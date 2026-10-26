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

// ---- cleanups: HTML entities and state-name spelling ----
const { decodeHtmlEntities, canonicalStateName, applyCleanups } = require('../scripts/merge');

test('decodeHtmlEntities decodes the known entities in a single pass and leaves everything else alone', () => {
  assert.equal(decodeHtmlEntities('L&amp;T Western'), 'L&T Western');
  assert.equal(decodeHtmlEntities('a&nbsp;b&#160;c'), 'a b c');
  assert.equal(decodeHtmlEntities('it&#39;s &quot;x&quot; &lt;y&gt;'), `it's "x" <y>`);
  assert.equal(decodeHtmlEntities('&amp;amp;'), '&amp;'); // single pass: never double-decodes
  assert.equal(decodeHtmlEntities('already & fine; &unknown; &#12345;'), 'already & fine; &unknown; &#12345;');
});

test('applyCleanups decodes text fields but never touches nh_no, rates, identifiers, coordinates or rate_* provenance', () => {
  const entry = {
    tollplaza_id: 1, tollplaza_code: 'A&amp;B', latitude: '1&amp;', longitude: '2&amp;',
    nh_no: '21(New 205 &amp; 154) ', car_single: '5&amp;', lcv_return: '7&nbsp;',
    rate_source: 'https://x.invalid/?a=1&amp;b=2', rate_valid_until: '2030&amp;',
    contractor_name: 'M/s L&amp;T Ltd', chainage: 'A&nbsp;B', helpline_patrol: '1&amp;2', count: 3, nothing: null,
  };
  const out = applyCleanups([entry]);
  assert.equal(entry.contractor_name, 'M/s L&T Ltd');
  assert.equal(entry.chainage, 'A B');
  assert.equal(entry.helpline_patrol, '1&2');
  for (const k of ['tollplaza_code', 'latitude', 'longitude', 'nh_no', 'car_single', 'lcv_return', 'rate_source', 'rate_valid_until']) {
    assert.ok(String(entry[k]).includes('&'), `${k} must be untouched`);
  }
  assert.equal(entry.nh_no, '21(New 205 &amp; 154) ');
  assert.equal(entry.count, 3);
  assert.deepEqual(out, { entityRecords: 1, entityFields: 3, stateRenamed: 0 });
});

test('canonicalStateName fixes only the four known spelling variants and is null-safe', () => {
  assert.equal(canonicalStateName('TAMILNADU'), 'TAMIL NADU');
  assert.equal(canonicalStateName('ANDHRAPRADESH'), 'ANDHRA PRADESH');
  assert.equal(canonicalStateName('HIMACHALPRADESH'), 'HIMACHAL PRADESH');
  assert.equal(canonicalStateName('WESTBENGAL'), 'WEST BENGAL');
  assert.equal(canonicalStateName('TAMIL NADU'), 'TAMIL NADU');
  for (const keep of ['PUNJAB AND HARYANA', 'JAMMU AND KASHMIR', 'UTTAR PRADESH', 'DELHI']) assert.equal(canonicalStateName(keep), keep);
  assert.equal(canonicalStateName(null), null);
  const rows = [{ state_name: 'TAMILNADU' }, { state_name: 'TAMIL NADU' }, { state_name: null }];
  assert.equal(applyCleanups(rows).stateRenamed, 1);
  assert.deepEqual(rows.map((r) => r.state_name), ['TAMIL NADU', 'TAMIL NADU', null]);
});

test('a state label override with expected_current_state:null applies only while the upstream value is empty', () => {
  const empty = [P(1, null)];
  const filled = [P(2, 'KARNATAKA')];
  const ov = { 'id:1': { state_name: 'UTTARAKHAND', expected_current_state: null }, 'id:2': { state_name: 'UTTARAKHAND', expected_current_state: null } };
  const r1 = applyStateLabelOverrides(empty, { 'id:1': ov['id:1'] });
  const r2 = applyStateLabelOverrides(filled, { 'id:2': ov['id:2'] });
  assert.deepEqual(r1.applied, ['id:1']);
  assert.equal(empty[0].state_name, 'UTTARAKHAND');
  assert.deepEqual(r2.skippedChanged.map((x) => x.key), ['id:2']);
  assert.equal(filled[0].state_name, 'KARNATAKA'); // an upstream value is never clobbered
});

test('mergeDataSources runs the cleanups end to end and leaves rates and nh_no byte-identical', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanups-'));
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'nhai.json'), JSON.stringify([
    P(1, 'TAMILNADU', { nh_no: '30 &amp; 34', car_single: '45', contractor_name: 'L&amp;T' }),
  ]));
  const [r] = await mergeDataSources({ sourcesDir, dataDir: root });
  assert.equal(r.state_name, 'TAMIL NADU');
  assert.equal(r.contractor_name, 'L&T');
  assert.equal(r.nh_no, '30 &amp; 34');
  assert.equal(r.car_single, '45');
  fs.rmSync(root, { recursive: true, force: true });
});
