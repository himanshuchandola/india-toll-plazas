const httpClientDefault = require('./httpClient');
const fs = require('fs');
const path = require('path');

const API_BASE_URL = 'https://rajmargyatra.nhai.gov.in/nhai/api';
const CONCURRENT_REQUESTS = 10;
const DELAY_BETWEEN_BATCHES = 100;
const MAX_ATTEMPTS_PER_PLAZA = 3; // 1 initial try + 2 retries
const RETRY_BACKOFF_MS = 1000;

const SOURCES_DIR = path.join(__dirname, '../data/sources');
const PLAZA_LIST_FILE = path.join(SOURCES_DIR, '.temp_plazas_list.json');
const RAW_DETAILS_FILE = path.join(SOURCES_DIR, '.temp_raw_details.json');
const CHECKPOINT_FILE = path.join(SOURCES_DIR, '.checkpoint_raw_details.json');
const FAILED_PLAZAS_FILE = path.join(SOURCES_DIR, '.failed_plazas.json');

// Paths are derived from a sourcesDir so tests can point them at a temp
// directory instead of the project's real data/sources/.
function resolvePaths(sourcesDir = SOURCES_DIR) {
  return {
    plazaListFile: path.join(sourcesDir, '.temp_plazas_list.json'),
    rawDetailsFile: path.join(sourcesDir, '.temp_raw_details.json'),
    checkpointFile: path.join(sourcesDir, '.checkpoint_raw_details.json'),
    failedPlazasFile: path.join(sourcesDir, '.failed_plazas.json'),
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Removes duplicate plaza entries by tollplaza_id (keeping the first occurrence),
 * so a single bad/duplicated upstream payload never results in fetching — or
 * checkpointing — the same plaza twice.
 */
function dedupePlazas(plazas) {
  const seen = new Set();
  const deduped = [];
  for (const plaza of plazas) {
    const id = plaza && plaza.tollplaza_id;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    deduped.push(plaza);
  }
  return deduped;
}

function loadCheckpoint(checkpointFile = CHECKPOINT_FILE) {
  if (!fs.existsSync(checkpointFile)) {
    return { completed: {}, failed: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    return {
      completed: (parsed && typeof parsed.completed === 'object' && parsed.completed) || {},
      failed: (parsed && typeof parsed.failed === 'object' && parsed.failed) || {},
    };
  } catch (error) {
    console.warn(`Checkpoint file is corrupt (${error.message}); starting this run from scratch.`);
    return { completed: {}, failed: {} };
  }
}

function saveCheckpoint(checkpoint, checkpointFile = CHECKPOINT_FILE) {
  atomicWriteJson(checkpointFile, {
    updatedAt: new Date().toISOString(),
    completed: checkpoint.completed,
    failed: checkpoint.failed,
  });
}

function clearCheckpoint(sourcesDir = SOURCES_DIR) {
  const { checkpointFile, failedPlazasFile } = resolvePaths(sourcesDir);
  for (const file of [checkpointFile, failedPlazasFile]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function fetchTollplazaNames(httpClient = httpClientDefault, options = {}) {
  const { plazaListFile } = resolvePaths(options.sourcesDir);

  console.log('Fetching all toll plaza names...');
  console.log(`URL: ${API_BASE_URL}/getTollplazaName`);

  try {
    const data = await httpClient.makeRequest(
      `${API_BASE_URL}/getTollplazaName`,
      'POST',
      {},
      {
        'Referer': 'https://rajmargyatra.nhai.gov.in/ataglance'
      }
    );

    if (data.resultCode === 200 && data.payload) {
      const deduped = dedupePlazas(data.payload);
      const duplicateCount = data.payload.length - deduped.length;
      console.log(`Successfully fetched ${data.payload.length} toll plazas` +
        (duplicateCount > 0 ? ` (${duplicateCount} duplicate tollplaza_id removed)` : ''));

      atomicWriteJson(plazaListFile, deduped);

      return deduped;
    } else {
      throw new Error(`API returned: ${data.resultString || 'Unknown error'}`);
    }
  } catch (error) {
    console.error(`Error fetching toll plaza names: ${error.message}`);
    throw error;
  }
}

async function fetchTollplazaDetailOnce(tollplazaId, httpClient) {
  try {
    const data = await httpClient.makeRequest(
      `${API_BASE_URL}/getTollplazaDetails`,
      'POST',
      { tollplaza_id: tollplazaId },
      {
        'Referer': 'https://rajmargyatra.nhai.gov.in/ataglance'
      }
    );

    if (data.resultCode === 200 && data.payload && data.payload.length > 0) {
      return { success: true, data: data.payload[0] };
    } else {
      return { success: false, error: data.resultString || 'No data' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Fetches a single plaza's details, retrying transient failures with a short
 * backoff before giving up and reporting it as failed.
 */
async function fetchTollplazaDetailWithRetry(tollplazaId, httpClient = httpClientDefault, maxAttempts = MAX_ATTEMPTS_PER_PLAZA) {
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await fetchTollplazaDetailOnce(tollplazaId, httpClient);
    if (lastResult.success) return lastResult;
    if (attempt < maxAttempts) {
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  return lastResult;
}

/**
 * Fetches details for every plaza, checkpointing progress to disk after every
 * batch so a crash, network outage, or Ctrl+C never loses work already done —
 * a re-run skips plazas already checkpointed as completed and only retries the
 * rest. `.temp_raw_details.json` (consumed by processNhai.js) is always written
 * from the checkpoint in a `finally` block, so it reflects whatever was
 * successfully fetched even if this run itself fails partway through.
 */
async function fetchAllPlazaDetails(plazas, options = {}) {
  const httpClient = options.httpClient || httpClientDefault;
  const resume = options.resume !== false;
  const { rawDetailsFile, checkpointFile, failedPlazasFile } = resolvePaths(options.sourcesDir);

  const deduped = dedupePlazas(plazas);
  const checkpoint = resume ? loadCheckpoint(checkpointFile) : { completed: {}, failed: {} };

  const validIds = new Set(deduped.map(p => p.tollplaza_id));
  for (const id of Object.keys(checkpoint.completed)) {
    if (!validIds.has(Number(id)) && !validIds.has(id)) delete checkpoint.completed[id];
  }

  const pending = deduped.filter(p => checkpoint.completed[p.tollplaza_id] === undefined);

  console.log(`Fetching details for ${deduped.length} toll plazas ` +
    `(${Object.keys(checkpoint.completed).length} already checkpointed, ${pending.length} remaining, ${CONCURRENT_REQUESTS} concurrent)...`);

  try {
    for (let i = 0; i < pending.length; i += CONCURRENT_REQUESTS) {
      const batch = pending.slice(i, i + CONCURRENT_REQUESTS);
      const batchResults = await Promise.all(
        batch.map(plaza => fetchTollplazaDetailWithRetry(plaza.tollplaza_id, httpClient))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const plaza = batch[j];
        const result = batchResults[j];

        if (result.success) {
          checkpoint.completed[plaza.tollplaza_id] = result.data;
          delete checkpoint.failed[plaza.tollplaza_id];
          process.stdout.write('.');
        } else {
          checkpoint.failed[plaza.tollplaza_id] = {
            tollplaza_name: plaza.tollplaza_name,
            error: result.error,
            lastAttempt: new Date().toISOString(),
          };
          process.stdout.write('F');
        }
      }

      // Checkpoint after every batch — this is what makes the fetch resumable.
      // .temp_raw_details.json / .failed_plazas.json are flushed here too (not
      // just in the `finally` below), so a hard kill (SIGKILL, OOM, machine
      // sleep) that skips JS `finally` handlers still leaves them in sync with
      // the checkpoint instead of stale or missing.
      saveCheckpoint(checkpoint, checkpointFile);
      atomicWriteJson(rawDetailsFile, Object.values(checkpoint.completed));
      atomicWriteJson(failedPlazasFile, checkpoint.failed);

      const completedSoFar = Object.keys(checkpoint.completed).length;
      if ((i + batch.length) % 50 < CONCURRENT_REQUESTS) {
        console.log(`\nProgress: ${completedSoFar}/${deduped.length}`);
      }

      if (i + CONCURRENT_REQUESTS < pending.length) {
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }
  } finally {
    // Always flush, even on an uncaught error — fixes plaza detail fetches
    // succeeding but .temp_raw_details.json never getting written because an
    // error (or interruption) hit before the old single end-of-run write.
    saveCheckpoint(checkpoint, checkpointFile);
    atomicWriteJson(rawDetailsFile, Object.values(checkpoint.completed));
    atomicWriteJson(failedPlazasFile, checkpoint.failed);
  }

  const results = Object.values(checkpoint.completed);
  const failedEntries = Object.entries(checkpoint.failed);

  console.log(`\n\nCompleted: ${results.length}/${deduped.length} successful, ${failedEntries.length} failed.`);
  if (failedEntries.length > 0) {
    console.log('Failed plazas:');
    failedEntries.slice(0, 20).forEach(([id, info]) => {
      console.log(`  - ${id} (${info.tollplaza_name || 'unknown'}): ${info.error}`);
    });
    if (failedEntries.length > 20) {
      console.log(`  ...and ${failedEntries.length - 20} more — see ${path.relative(process.cwd(), failedPlazasFile)}`);
    }
    console.log(`Re-run this script to retry only the failed plazas (already-fetched ones are checkpointed and skipped).`);
  }

  return { results, failed: checkpoint.failed, total: deduped.length };
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  if (fresh) {
    console.log('Ignoring any existing checkpoint (--fresh).');
    clearCheckpoint();
  }

  try {
    const plazas = await fetchTollplazaNames();
    const { results, failed, total } = await fetchAllPlazaDetails(plazas, { resume: !fresh });

    console.log(`\nFinal: ${results.length}/${total} plazas with details (${Object.keys(failed).length} failed).`);

    if (results.length === 0) {
      console.error('No plaza details were fetched successfully.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  fetchTollplazaNames,
  fetchAllPlazaDetails,
  fetchTollplazaDetailWithRetry,
  dedupePlazas,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  resolvePaths,
  CHECKPOINT_FILE,
  RAW_DETAILS_FILE,
  FAILED_PLAZAS_FILE,
  PLAZA_LIST_FILE,
};
