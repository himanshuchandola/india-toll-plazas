const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  dedupePlazas,
  fetchTollplazaDetailWithRetry,
  fetchAllPlazaDetails,
  resolvePaths,
} = require('../scripts/fetchNhaiData');

function makeSourcesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-nhai-'));
  return dir;
}

test('dedupePlazas drops duplicate tollplaza_id entries, keeping the first', () => {
  const input = [
    { tollplaza_id: 1, tollplaza_name: 'A' },
    { tollplaza_id: 2, tollplaza_name: 'B' },
    { tollplaza_id: 1, tollplaza_name: 'A duplicate' },
  ];
  const result = dedupePlazas(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].tollplaza_name, 'A');
});

test('dedupePlazas ignores entries with no tollplaza_id', () => {
  const result = dedupePlazas([{ tollplaza_name: 'no id' }, { tollplaza_id: 1, tollplaza_name: 'ok' }]);
  assert.equal(result.length, 1);
});

test('fetchTollplazaDetailWithRetry retries transient failures and eventually succeeds', async () => {
  let calls = 0;
  const fakeClient = {
    makeRequest: async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNRESET');
      return { resultCode: 200, payload: [{ tollplaza_id: 1, tollplaza_name: 'Recovered' }] };
    },
  };

  const result = await fetchTollplazaDetailWithRetry(1, fakeClient, 3);
  assert.equal(result.success, true);
  assert.equal(calls, 3);
});

test('fetchTollplazaDetailWithRetry gives up after the max attempts and reports the error', async () => {
  const fakeClient = {
    makeRequest: async () => { throw new Error('persistent failure'); },
  };

  const result = await fetchTollplazaDetailWithRetry(1, fakeClient, 2);
  assert.equal(result.success, false);
  assert.match(result.error, /persistent failure/);
});

test('fetchAllPlazaDetails always writes .temp_raw_details.json, even when every request fails (simulates an interrupted download)', async () => {
  const sourcesDir = makeSourcesDir();
  const plazas = [{ tollplaza_id: 1, tollplaza_name: 'A' }, { tollplaza_id: 2, tollplaza_name: 'B' }];
  const failingClient = {
    makeRequest: async () => { throw new Error('network down'); },
  };

  const { results, failed, total } = await fetchAllPlazaDetails(plazas, { httpClient: failingClient, sourcesDir, resume: false });

  assert.equal(results.length, 0);
  assert.equal(Object.keys(failed).length, 2);
  assert.equal(total, 2);

  const { rawDetailsFile, failedPlazasFile } = resolvePaths(sourcesDir);
  assert.equal(fs.existsSync(rawDetailsFile), true, '.temp_raw_details.json must exist even on total failure');
  assert.deepEqual(JSON.parse(fs.readFileSync(rawDetailsFile, 'utf8')), []);
  assert.equal(fs.existsSync(failedPlazasFile), true);

  fs.rmSync(sourcesDir, { recursive: true, force: true });
});

test('fetchAllPlazaDetails flushes .temp_raw_details.json after every batch, not just at the end (simulates a hard kill mid-run)', async () => {
  const sourcesDir = makeSourcesDir();
  // 3 batches worth of plazas (CONCURRENT_REQUESTS is 10), third batch never resolves.
  const plazas = Array.from({ length: 25 }, (_, i) => ({ tollplaza_id: i + 1, tollplaza_name: `Plaza ${i + 1}` }));

  const client = {
    // The last batch keeps failing (and gets retried with backoff), which
    // holds fetchAllPlazaDetails open long enough to inspect disk state
    // mid-run, before its own `finally` has had a chance to execute.
    makeRequest: async (url, method, body) => {
      if (body.tollplaza_id > 20) {
        throw new Error('simulated persistent failure');
      }
      return { resultCode: 200, payload: [{ tollplaza_id: body.tollplaza_id, tollplaza_name: 'ok' }] };
    },
  };

  const { rawDetailsFile } = resolvePaths(sourcesDir);

  const runPromise = fetchAllPlazaDetails(plazas, { httpClient: client, sourcesDir, resume: false });
  await new Promise(resolve => setTimeout(resolve, 50));

  // By now the first two batches (20 plazas) should already be on disk, even
  // though fetchAllPlazaDetails as a whole hasn't returned yet (it's still
  // retrying the third, failing batch).
  assert.equal(fs.existsSync(rawDetailsFile), true);
  const onDisk = JSON.parse(fs.readFileSync(rawDetailsFile, 'utf8'));
  assert.ok(onDisk.length >= 10, `expected at least one completed batch on disk, got ${onDisk.length}`);

  const { results, failed } = await runPromise;
  assert.equal(results.length, 20);
  assert.equal(Object.keys(failed).length, 5);

  fs.rmSync(sourcesDir, { recursive: true, force: true });
});

test('fetchAllPlazaDetails resumes from a checkpoint and only retries the plazas that previously failed', async () => {
  const sourcesDir = makeSourcesDir();
  const plazas = [
    { tollplaza_id: 1, tollplaza_name: 'A' },
    { tollplaza_id: 2, tollplaza_name: 'B' },
  ];

  // First run: plaza 1 succeeds, plaza 2 fails.
  const firstClient = {
    makeRequest: async (url, method, body) => {
      if (body.tollplaza_id === 1) {
        return { resultCode: 200, payload: [{ tollplaza_id: 1, tollplaza_name: 'A' }] };
      }
      throw new Error('timeout');
    },
  };
  await fetchAllPlazaDetails(plazas, { httpClient: firstClient, sourcesDir, resume: false });

  // Second run (resume=true, the default): only plaza 2 should be requested.
  const requestedIds = [];
  const secondClient = {
    makeRequest: async (url, method, body) => {
      requestedIds.push(body.tollplaza_id);
      return { resultCode: 200, payload: [{ tollplaza_id: body.tollplaza_id, tollplaza_name: 'resolved' }] };
    },
  };
  const { results, failed } = await fetchAllPlazaDetails(plazas, { httpClient: secondClient, sourcesDir });

  assert.deepEqual(requestedIds, [2]);
  assert.equal(results.length, 2);
  assert.equal(Object.keys(failed).length, 0);

  fs.rmSync(sourcesDir, { recursive: true, force: true });
});
