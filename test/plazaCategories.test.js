const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeDataSources, applyPlazaCategories } = require('../scripts/merge');

const P = (id, extra = {}) => ({ tollplaza_id: id, tollplaza_code: `C${id}`, tollplaza_name: `Plaza ${id}`, state_name: 'S', location: 'KM 1', car_single: '100', ...extra });

test('plaza_category is set only on listed plazas; everything else, including rates, is untouched', () => {
  const combined = [P(1), P(2), P(3)];
  const r = applyPlazaCategories(combined, { 'id:1': { plaza_category: 'border_checkpost' }, 'id:3': { plaza_category: 'checkpost_entry_fee' } });
  assert.deepEqual(r.applied, ['id:1', 'id:3']);
  assert.equal(combined[0].plaza_category, 'border_checkpost');
  assert.equal(combined[2].plaza_category, 'checkpost_entry_fee');
  assert.ok(!('plaza_category' in combined[1]), 'default plazas get no field (absent = highway_toll)');
  assert.equal(combined[0].car_single, '100');
  assert.equal(combined[0].tollplaza_name, 'Plaza 1');
});

test('only the two non-default categories may be written; highway_toll and garbage are rejected', () => {
  const combined = [P(1), P(2), P(3)];
  const r = applyPlazaCategories(combined, {
    'id:1': { plaza_category: 'highway_toll' },
    'id:2': { plaza_category: 'nonsense' },
    'id:3': {},
  });
  assert.deepEqual(r.invalid.sort(), ['id:1', 'id:2', 'id:3']);
  assert.ok(combined.every((c) => !('plaza_category' in c)));
});

test('an existing upstream category is never overwritten, and a matching one is reported as already set', () => {
  const combined = [P(1, { plaza_category: 'border_checkpost' }), P(2, { plaza_category: 'checkpost_entry_fee' })];
  const r = applyPlazaCategories(combined, {
    'id:1': { plaza_category: 'checkpost_entry_fee' },
    'id:2': { plaza_category: 'checkpost_entry_fee' },
    'id:99': { plaza_category: 'border_checkpost' },
  });
  assert.deepEqual(r.skippedChanged, [{ key: 'id:1', current: 'border_checkpost', wanted: 'checkpost_entry_fee' }]);
  assert.deepEqual(r.alreadyCategorised, ['id:2']);
  assert.deepEqual(r.notFound, ['id:99']);
  assert.equal(combined[0].plaza_category, 'border_checkpost');
});

test('plazas can be keyed by code as well as id', () => {
  const combined = [P(7)];
  const r = applyPlazaCategories(combined, { 'code:C7': { plaza_category: 'border_checkpost' } });
  assert.deepEqual(r.applied, ['code:C7']);
  assert.equal(combined[0].plaza_category, 'border_checkpost');
});

test('mergeDataSources applies curated/plaza_categories.json end to end and a malformed file is skipped safely', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-'));
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(path.join(sourcesDir, 'curated'), { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'nhai.json'), JSON.stringify([P(1), P(2)]));
  fs.writeFileSync(path.join(sourcesDir, 'curated', 'plaza_categories.json'), JSON.stringify({ plazas: { 'id:2': { plaza_category: 'checkpost_entry_fee' } } }));
  const out = await mergeDataSources({ sourcesDir, dataDir: root });
  assert.equal(out.find((p) => p.tollplaza_id === 2).plaza_category, 'checkpost_entry_fee');
  assert.ok(!('plaza_category' in out.find((p) => p.tollplaza_id === 1)));

  fs.writeFileSync(path.join(sourcesDir, 'curated', 'plaza_categories.json'), '{ not json');
  const again = await mergeDataSources({ sourcesDir, dataDir: root });
  assert.equal(again.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the committed curated file only uses allowed categories and covers exactly the approved 40 plazas', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/sources/curated/plaza_categories.json'), 'utf8'));
  const entries = Object.entries(doc.plazas);
  assert.equal(entries.length, 40);
  for (const [, v] of entries) assert.ok(['checkpost_entry_fee', 'border_checkpost'].includes(v.plaza_category));
  assert.equal(entries.filter(([, v]) => v.plaza_category === 'border_checkpost').length, 22);
  assert.equal(entries.filter(([, v]) => v.plaza_category === 'checkpost_entry_fee').length, 18);
  assert.ok(!entries.some(([k]) => /^id:34(1[4-9]|2\d|3[0-4])$/.test(k)), 'held-back Uttarakhand checkposts must not be classified');
});
