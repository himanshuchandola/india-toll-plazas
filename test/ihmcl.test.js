const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parseIndianNumber, parseTitle, parseRow, parseVcWiseText } = require('../scripts/ihmcl/parseVcWise');
const { normalizeStrict, normalizeCore, normalizeCoreNoParen, reconcile, summarise } = require('../scripts/ihmcl/reconcile');
const { isGitIgnored, assertSafeOutput } = require('../scripts/ihmcl/run');

// SYNTHETIC layout text in the shape pdftotext -layout produces. All plazas and numbers are invented ("Testville").
const row = (name, piu, ro, nums) => `${name.padEnd(36)}${piu.padEnd(15)}${ro.padEnd(16)}${nums.join('   ')}`;
// categories: car, lcv, bus, 3ax, 4-6ax, osv, total (count, amount each)
const GOOD = ['1,000', '2,00,000', '10', '5,000', '20', '30,000', '5', '9,000', '4', '8,000', '-', '-', '1,039', '2,52,000'];

test('parseIndianNumber handles Indian grouping and the nil dash', () => {
  assert.equal(parseIndianNumber('1,17,084'), 117084);
  assert.equal(parseIndianNumber('-'), 0);
  assert.equal(parseIndianNumber('12a'), null);
  assert.equal(parseIndianNumber(''), null);
});

test('parseTitle reads the reporting month from inside the file ("Sept" and full names)', () => {
  assert.deepEqual(parseTitle('VC Wise Monthly ETC FASTag Data for the Month of Sept 2026'), { year: 2026, month: 9, label: 'Sept 2026', period: '2026-09' });
  assert.equal(parseTitle('... Month of January 2025').period, '2025-01');
  assert.equal(parseTitle('no month here'), null);
});

test('parseRow splits name/PIU/RO and numeric tail; "-" becomes 0; totals reconcile', () => {
  const r = parseRow(row('Testville Toll Plaza', 'Testpur', 'Test - West', GOOD), 3);
  assert.equal(r.plazaName, 'Testville Toll Plaza');
  assert.equal(r.piu, 'Testpur');
  assert.equal(r.ro, 'Test - West');
  assert.equal(r.counts.car_jeep, 1000);
  assert.equal(r.amountsInr.car_jeep, 200000);
  assert.equal(r.counts.osv, 0);
  assert.equal(r.totalCount, 1039);
  assert.deepEqual(r.flags, []);
});

test('parseRow flags totals that do not add up and wide-gap names, without dropping the row', () => {
  const bad = [...GOOD]; bad[12] = '1,040';
  const r1 = parseRow(row('Testville Toll Plaza', 'Testpur', 'Test - West', bad), 1);
  assert.deepEqual(r1.flags, ['count_total_mismatch']);
  const r2 = parseRow(`${'Bagrana  (Close Loop)'.padEnd(34)}${'Testpur'.padEnd(15)}${'Test'.padEnd(10)}${GOOD.join('   ')}`, 2);
  assert.equal(r2.plazaName, 'Bagrana (Close Loop)');
  assert.ok(r2.flags.includes('plaza_name_has_wide_gap'));
});

test('parseVcWiseText: skips repeated headers, keeps unparsed lines visible, reports duplicates and period', () => {
  const text = [
    'VC Wise Monthly ETC FASTag Data for the Month of Sept 2026',
    'PLAZA_NAME   PIU   RO   CAR_JEEP_CNT ...',
    row('Alpha Toll Plaza', 'Testpur', 'Test', GOOD),
    row('Alpha Toll Plaza', 'Testpur', 'Test', GOOD),
    '\fPLAZA_NAME   PIU   RO   CAR_JEEP_CNT ...',
    row('Beta Plaza', 'Testpur', 'Test', GOOD),
    'Grand total with no usable columns',
  ].join('\n');
  const p = parseVcWiseText(text);
  assert.equal(p.reportingPeriod.period, '2026-09');
  assert.equal(p.rows.length, 3);
  assert.equal(p.quality.unparsedLineCount, 1);
  assert.equal(p.unparsedLines[0].text, 'Grand total with no usable columns');
  assert.deepEqual(p.quality.duplicatePlazaNamesWithinFile, [{ name: 'alpha toll plaza', n: 2 }]);
});

const D = (id, name, extra = {}) => ({ tollplaza_id: id, tollplaza_name: name, state_name: 'TESTSTATE', data_source: 'nhai', car_single: '50', ...extra });
const R = (name, car = 100) => ({ plazaName: name, piu: 'P', ro: 'R', counts: { car_jeep: car }, totalCount: car });

test('normalizers: strict keeps meaningful tokens, core drops generic words, no-paren drops bracketed qualifiers', () => {
  assert.equal(normalizeStrict('Akshda TOLL PLAZA'), 'akshda toll plaza');
  assert.equal(normalizeCore('Akshda TOLL PLAZA'), 'akshda');
  assert.equal(normalizeCore('Pinan (Close Loop Toll)'), 'pinan');
  assert.equal(normalizeCoreNoParen('Paranur (Chengalpet) Toll Plaza'), 'paranur');
});

test('reconcile: unique exact tiers match; ambiguous and conflicting cases are never picked automatically', () => {
  const ds = [D(1, 'Alpha'), D(2, 'Beta Toll Plaza'), D(3, 'Gamma (Karnal)'), D(4, 'Delta Toll Plaza'), D(5, 'Delta Toll Plaza'), D(6, 'Echo')];
  const rows = [R('Alpha'), R('Beta Fee Plaza'), R('Gamma Toll Plaza'), R('Delta Plaza'), R('Echo Toll Plaza'), R('Echo Plaza')];
  const { results, conflicts } = reconcile(rows, ds);
  const tier = (n) => results.find((r) => r.row.plazaName === n).tier;
  assert.equal(tier('Alpha'), 'strict_exact');
  assert.equal(tier('Beta Fee Plaza'), 'core_exact');
  assert.equal(tier('Gamma Toll Plaza'), 'core_no_paren_exact');
  assert.equal(tier('Delta Plaza'), 'ambiguous');
  assert.equal(tier('Echo Toll Plaza'), 'conflict');
  assert.equal(tier('Echo Plaza'), 'conflict');
  assert.deepEqual(conflicts.map((c) => c.datasetId), [6]);
});

test('reconcile: fuzzy suggestions are review-only, never counted as matches, and skip dataset records already claimed', () => {
  const ds = [D(1, 'Mathur Toll Plaza'), D(2, 'Ahmedabad Ring Road 2')];
  const rows = [R('Athur Toll Plaza'), R('Ahmedabad Ring Road 2'), R('Ahmedabad (Ring Road) Toll Plaza')];
  const { results } = reconcile(rows, ds);
  const by = (n) => results.find((r) => r.row.plazaName === n);
  assert.equal(by('Athur Toll Plaza').tier, 'fuzzy_candidate');
  assert.equal(by('Ahmedabad Ring Road 2').tier, 'strict_exact');
  assert.notEqual(by('Ahmedabad (Ring Road) Toll Plaza').tier, 'fuzzy_candidate'); // its only candidate is already matched
  const s = summarise({ rows, reportingPeriod: { period: '2026-09' }, source: {} }, ds, { results, conflicts: [] });
  assert.equal(s.counts.matchedUnique, 1);
});

test('summarise: tariff-verification leads are flagged without inferring any price from aggregates', () => {
  const ds = [D(1, 'Alpha', { car_single: null }), D(2, 'Beta', { car_single: '0' }), D(3, 'Gamma', { car_single: '40' }), D(4, 'Delta', { car_single: null })];
  const rows = [R('Alpha', 500), R('Beta', 300), R('Gamma', 900), R('Delta', 0)];
  const rec = reconcile(rows, ds);
  const s = summarise({ rows, reportingPeriod: null, source: {} }, ds, rec);
  assert.deepEqual(s.verificationLeads.map((l) => l.datasetId).sort(), [1, 2]);
  assert.equal(s.verificationLeads.find((l) => l.datasetId === 1).datasetCarSingle, 'missing');
  assert.equal(s.verificationLeads.find((l) => l.datasetId === 2).datasetCarSingle, '0');
  assert.ok(!JSON.stringify(s).match(/perVehicle|averageToll|implied|avgAmount/i));
});

test('safety: local IHMCL folders are git-ignored and ordinary tracked paths are not', () => {
  assert.equal(isGitIgnored(path.join('data', 'local', 'ihmcl', 'inbox', 'x.pdf')), true);
  assert.equal(isGitIgnored('README.md'), false);
  assert.doesNotThrow(() => assertSafeOutput());
});
