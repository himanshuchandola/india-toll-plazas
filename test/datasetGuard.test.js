const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertNotRegressed, writeJsonIfValid } = require('../scripts/lib/datasetGuard');

test('assertNotRegressed allows a small drop', () => {
  assert.doesNotThrow(() => assertNotRegressed(950, 1000, 'dataset'));
});

test('assertNotRegressed throws when the drop exceeds the threshold', () => {
  assert.throws(() => assertNotRegressed(500, 1000, 'dataset'), /50\.0% drop/);
});

test('assertNotRegressed throws when the new dataset is empty', () => {
  assert.throws(() => assertNotRegressed(0, 1000, 'dataset'), /empty/);
});

test('assertNotRegressed allows anything when there is no previous baseline', () => {
  assert.doesNotThrow(() => assertNotRegressed(0, 0, 'dataset'));
  assert.doesNotThrow(() => assertNotRegressed(5, 0, 'dataset'));
});

test('writeJsonIfValid leaves the existing file untouched when validation fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-guard-'));
  const filePath = path.join(dir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify(['original']));

  assert.throws(() => {
    writeJsonIfValid(filePath, ['new'], {
      validateFn: () => { throw new Error('invalid'); },
    });
  }, /invalid/);

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), ['original']);

  // No leftover temp file either.
  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonIfValid writes the new content when validation passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-guard-'));
  const filePath = path.join(dir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify(['original']));

  writeJsonIfValid(filePath, ['new'], { validateFn: () => {} });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), ['new']);

  fs.rmSync(dir, { recursive: true, force: true });
});
