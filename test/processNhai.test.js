const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { processNhai, normalizeNhaiData, validateRawPlazas } = require('../scripts/processNhai');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'process-nhai-'));
}

function rawPlaza(overrides = {}) {
  return {
    tollplaza_id: 1,
    tollplaza_name: 'Test Plaza',
    state_name: 'Test State',
    latitude: '12.34',
    longitude: '56.78',
    CarRate_single: '100',
    ...overrides,
  };
}

test('normalizeNhaiData maps known fields and stamps metadata', () => {
  const normalized = normalizeNhaiData(rawPlaza());
  assert.equal(normalized.tollplaza_id, 1);
  assert.equal(normalized.tollplaza_name, 'Test Plaza');
  assert.equal(normalized.car_single, '100');
  assert.equal(normalized.data_source, 'nhai');
  assert.ok(normalized.last_updated);
});

test('validateRawPlazas rejects a non-array payload', () => {
  assert.throws(() => validateRawPlazas({ not: 'an array' }), /JSON array/);
});

test('validateRawPlazas rejects an empty array', () => {
  assert.throws(() => validateRawPlazas([]), /zero plazas/);
});

test('validateRawPlazas rejects records missing tollplaza_id', () => {
  assert.throws(() => validateRawPlazas([{ tollplaza_name: 'No id' }]), /missing a tollplaza_id/);
});

test('processNhai throws (and does not write) when the raw details file is missing', async () => {
  const dir = makeTempDir();
  const rawFile = path.join(dir, '.temp_raw_details.json');
  const nhaiFile = path.join(dir, 'nhai.json');

  await assert.rejects(
    processNhai({ rawFile, nhaiFile }),
    /Raw details file not found/
  );
  assert.equal(fs.existsSync(nhaiFile), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('processNhai throws on invalid JSON and leaves existing nhai.json untouched (simulates an interrupted download)', async () => {
  const dir = makeTempDir();
  const rawFile = path.join(dir, '.temp_raw_details.json');
  const nhaiFile = path.join(dir, 'nhai.json');

  // Truncated/corrupt JSON, as if the writer was killed mid-write.
  fs.writeFileSync(rawFile, '[{"tollplaza_id": 1, "tollplaza_name": "Trun');
  fs.writeFileSync(nhaiFile, JSON.stringify([{ tollplaza_id: 'existing' }]));

  await assert.rejects(
    processNhai({ rawFile, nhaiFile }),
    /invalid JSON/
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(nhaiFile, 'utf8')), [{ tollplaza_id: 'existing' }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('processNhai refuses to overwrite nhai.json when the new dataset regresses sharply', async () => {
  const dir = makeTempDir();
  const rawFile = path.join(dir, '.temp_raw_details.json');
  const nhaiFile = path.join(dir, 'nhai.json');

  // Previous run had 10 plazas; this partial/failed run only has 2 (an 80% drop).
  const previous = Array.from({ length: 10 }, (_, i) => ({ tollplaza_id: i }));
  fs.writeFileSync(nhaiFile, JSON.stringify(previous));
  fs.writeFileSync(rawFile, JSON.stringify([rawPlaza({ tollplaza_id: 1 }), rawPlaza({ tollplaza_id: 2 })]));

  await assert.rejects(
    processNhai({ rawFile, nhaiFile }),
    /drop, exceeds/
  );

  // Existing nhai.json (10 plazas) must still be there, unmodified.
  assert.equal(JSON.parse(fs.readFileSync(nhaiFile, 'utf8')).length, 10);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('processNhai writes normalized data when validation passes', async () => {
  const dir = makeTempDir();
  const rawFile = path.join(dir, '.temp_raw_details.json');
  const nhaiFile = path.join(dir, 'nhai.json');

  fs.writeFileSync(rawFile, JSON.stringify([rawPlaza({ tollplaza_id: 1 }), rawPlaza({ tollplaza_id: 2 })]));

  const result = await processNhai({ rawFile, nhaiFile });

  assert.equal(result.length, 2);
  const saved = JSON.parse(fs.readFileSync(nhaiFile, 'utf8'));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].data_source, 'nhai');

  fs.rmSync(dir, { recursive: true, force: true });
});
