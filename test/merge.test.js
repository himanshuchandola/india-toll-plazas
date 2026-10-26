const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeDataSources } = require('../scripts/merge');

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  const sourcesDir = path.join(root, 'sources');
  const dataDir = root;
  fs.mkdirSync(sourcesDir, { recursive: true });
  return { root, sourcesDir, dataDir };
}

test('mergeDataSources combines nhai + state plazas and writes latest.json', async () => {
  const { root, sourcesDir, dataDir } = makeDirs();

  fs.writeFileSync(path.join(sourcesDir, 'nhai.json'), JSON.stringify([
    { tollplaza_id: 1, state_name: 'A', location: 'KM 10' },
  ]));
  fs.writeFileSync(path.join(sourcesDir, 'state_highways.json'), JSON.stringify([
    { tollplaza_id: 2, state_name: 'B', location: 'KM 5' },
  ]));

  const combined = await mergeDataSources({ sourcesDir, dataDir });

  assert.equal(combined.length, 2);
  const latestFile = path.join(dataDir, 'latest.json');
  const saved = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  assert.equal(saved.length, 2);

  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeDataSources refuses to overwrite latest.json with an empty dataset', async () => {
  const { root, sourcesDir, dataDir } = makeDirs();
  const latestFile = path.join(dataDir, 'latest.json');
  fs.writeFileSync(latestFile, JSON.stringify([{ tollplaza_id: 1 }, { tollplaza_id: 2 }]));

  // No nhai.json / state_highways.json present -> combined would be empty.
  await assert.rejects(mergeDataSources({ sourcesDir, dataDir }), /empty/);

  assert.equal(JSON.parse(fs.readFileSync(latestFile, 'utf8')).length, 2);

  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeDataSources refuses to overwrite latest.json on a sharp regression', async () => {
  const { root, sourcesDir, dataDir } = makeDirs();
  const latestFile = path.join(dataDir, 'latest.json');

  fs.writeFileSync(latestFile, JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ tollplaza_id: i }))));
  fs.writeFileSync(path.join(sourcesDir, 'nhai.json'), JSON.stringify([{ tollplaza_id: 1, state_name: 'A' }]));

  await assert.rejects(mergeDataSources({ sourcesDir, dataDir }), /drop, exceeds/);

  assert.equal(JSON.parse(fs.readFileSync(latestFile, 'utf8')).length, 20);

  fs.rmSync(root, { recursive: true, force: true });
});

test('applyCuratedRates overrides rate fields and stamps provenance', () => {
  const { applyCuratedRates } = require('../scripts/merge');
  const entry = { car_single: '50', data_confidence: 'complete' };
  applyCuratedRates(entry, { rates: { car_single: '75' }, rate_source: 'operator-notice' });

  assert.equal(entry.car_single, '75');
  assert.equal(entry.data_confidence, 'verified');
  assert.equal(entry.rate_source, 'operator-notice');
});
