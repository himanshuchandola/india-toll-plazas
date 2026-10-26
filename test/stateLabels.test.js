const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeDataSources, applyStateLabelOverrides } = require('../scripts/merge');

const P = (id, state, extra = {}) => ({ tollplaza_id: id, tollplaza_code: `C${id}`, tollplaza_name: `Plaza ${id}`, state_name: state, location: 'KM 1', ...extra });

test('state label override applies only to state_name and only while upstream still has the expected value', () => {
  const combined = [P(1, 'WRONGSTATE', { car_single: '50' }), P(2, 'CHANGEDUPSTREAM'), P(3, 'RIGHTSTATE')];
  const overrides = {
    'id:1': { state_name: 'RIGHTSTATE', expected_current_state: 'WRONGSTATE', car_single: '999', tollplaza_name: 'HACKED' },
    'id:2': { state_name: 'RIGHTSTATE', expected_current_state: 'WRONGSTATE' },
    'id:3': { state_name: 'RIGHTSTATE', expected_current_state: 'WRONGSTATE' },
    'id:99': { state_name: 'X', expected_current_state: 'Y' },
  };
  const r = applyStateLabelOverrides(combined, overrides);
  assert.deepEqual(r.applied, ['id:1']);
  assert.deepEqual(r.alreadyCorrect, ['id:3']);
  assert.deepEqual(r.skippedChanged, [{ key: 'id:2', current: 'CHANGEDUPSTREAM', expected: 'WRONGSTATE' }]);
  assert.deepEqual(r.notFound, ['id:99']);
  assert.equal(combined[0].state_name, 'RIGHTSTATE');
  assert.equal(combined[0].car_single, '50'); // rates untouched
  assert.equal(combined[0].tollplaza_name, 'Plaza 1'); // no other field may be set by this layer
  assert.equal(combined[1].state_name, 'CHANGEDUPSTREAM'); // never clobbers a newer upstream value
});

test('state label override can be keyed by plaza code as well as id', () => {
  const combined = [P(7, 'OLD')];
  const r = applyStateLabelOverrides(combined, { 'code:C7': { state_name: 'NEW', expected_current_state: 'OLD' } });
  assert.deepEqual(r.applied, ['code:C7']);
  assert.equal(combined[0].state_name, 'NEW');
});

test('mergeDataSources applies curated/state_labels.json end to end and re-sorts by corrected state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statelabels-'));
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(path.join(sourcesDir, 'curated'), { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'nhai.json'), JSON.stringify([P(1, 'BSTATE'), P(2, 'ASTATE')]));
  fs.writeFileSync(path.join(sourcesDir, 'curated', 'state_labels.json'), JSON.stringify({ plazas: { 'id:1': { state_name: 'AASTATE', expected_current_state: 'BSTATE' } } }));
  const combined = await mergeDataSources({ sourcesDir, dataDir: root });
  assert.deepEqual(combined.map((c) => [c.tollplaza_id, c.state_name]), [[1, 'AASTATE'], [2, 'ASTATE']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'))[0].state_name, 'AASTATE');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a malformed state_labels.json is skipped without breaking the merge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statelabels-bad-'));
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(path.join(sourcesDir, 'curated'), { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'nhai.json'), JSON.stringify([P(1, 'A')]));
  fs.writeFileSync(path.join(sourcesDir, 'curated', 'state_labels.json'), '{ not json');
  const combined = await mergeDataSources({ sourcesDir, dataDir: root });
  assert.equal(combined[0].state_name, 'A');
  fs.rmSync(root, { recursive: true, force: true });
});
