'use strict';
// Reconciles IHMCL plaza names with data/latest.json. Report-only: it never edits the dataset, never merges
// records, and never derives a toll rate from aggregate amounts.

const GENERIC = new Set(['toll', 'plaza', 'fee', 'tp', 'gate', 'booth', 'tollplaza', 'feeplaza', 'closed', 'close', 'loop', 'virtual', 'the']);

/** Lowercase, drop punctuation, collapse spaces. Keeps every meaningful token. */
function normalizeStrict(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** As strict, but without generic words ("toll plaza", "fee plaza", "close loop toll"). */
function normalizeCore(name) {
  return normalizeStrict(name).split(' ').filter((t) => t && !GENERIC.has(t)).join(' ');
}

/** As core, but also ignoring bracketed qualifiers such as "(Chengalpet)" or "(Ch.109+670)". */
function normalizeCoreNoParen(name) {
  return normalizeCore(String(name || '').replace(/\([^)]*\)/g, ' '));
}

const MATCH_TIERS = new Set(['strict_exact', 'core_exact', 'core_no_paren_exact']);
const isMatch = (tier) => MATCH_TIERS.has(tier);

function bigrams(s) {
  const t = s.replace(/\s+/g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}

/** Sorensen-Dice similarity on character bigrams (0..1). */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a); const B = bigrams(b);
  let inter = 0; let total = 0;
  for (const [g, n] of A) { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

const FUZZY_THRESHOLD = 0.82;

function indexBy(records, keyFn) {
  const m = new Map();
  for (const r of records) { const k = keyFn(r.tollplaza_name); if (!k) continue; (m.get(k) || m.set(k, []).get(k)).push(r); }
  return m;
}

function brief(r) { return { id: r.tollplaza_id, name: String(r.tollplaza_name).trim(), state: r.state_name, source: r.data_source }; }

/**
 * Match tiers (only unique exact tiers count as matches; everything else is a candidate for human review):
 *  strict_exact  - normalised names identical, exactly one dataset record
 *  core_exact    - identical after removing generic words, exactly one dataset record
 *  core_no_paren_exact - as core_exact but ignoring bracketed qualifiers, exactly one dataset record (lowest confidence exact tier)
 *  ambiguous     - tier hit more than one dataset record: never picked automatically
 *  fuzzy_candidate - best bigram similarity >= threshold, review only
 *  unmatched
 */
function reconcile(ihmclRows, datasetRecords) {
  const strictIdx = indexBy(datasetRecords, normalizeStrict);
  const coreIdx = indexBy(datasetRecords, normalizeCore);
  const noParenIdx = indexBy(datasetRecords, normalizeCoreNoParen);
  const coreKeys = [...coreIdx.keys()];
  const results = [];
  const matchedIds = new Map(); // dataset id -> ihmcl row names that matched it

  // Pass 1: exact tiers only.
  for (const row of ihmclRows) {
    const strict = normalizeStrict(row.plazaName);
    const core = normalizeCore(row.plazaName);
    let tier = 'unmatched';
    let candidates = [];
    const s = strictIdx.get(strict);
    const c = core ? coreIdx.get(core) : undefined;
    const noParen = normalizeCoreNoParen(row.plazaName);
    const n = noParen ? noParenIdx.get(noParen) : undefined;
    if (s && s.length === 1) { tier = 'strict_exact'; candidates = s; }
    else if (s && s.length > 1) { tier = 'ambiguous'; candidates = s; }
    else if (c && c.length === 1) { tier = 'core_exact'; candidates = c; }
    else if (c && c.length > 1) { tier = 'ambiguous'; candidates = c; }
    else if (n && n.length === 1) { tier = 'core_no_paren_exact'; candidates = n; }
    else if (n && n.length > 1) { tier = 'ambiguous'; candidates = n; }
    results.push({ row, tier, candidates: candidates.map(brief), _core: core });
    if (isMatch(tier)) {
      const id = candidates[0].tollplaza_id;
      matchedIds.set(id, [...(matchedIds.get(id) || []), row.plazaName]);
    }
  }

  // Pass 2: fuzzy suggestions for still-unmatched rows, restricted to dataset records no exact match has claimed.
  // Suggestions are for human review only and are never counted as matches.
  for (const r of results) {
    if (r.tier !== 'unmatched' || !r._core) continue;
    let best = 0; let bestKey = null; let bestRecords = [];
    for (const k of coreKeys) {
      const free = coreIdx.get(k).filter((d) => !matchedIds.has(d.tollplaza_id));
      if (!free.length) continue;
      const d = dice(r._core, k);
      if (d > best) { best = d; bestKey = k; bestRecords = free; }
    }
    if (bestKey && best >= FUZZY_THRESHOLD) {
      r.tier = 'fuzzy_candidate';
      r.similarity = Math.round(best * 100) / 100;
      r.candidates = bestRecords.map(brief);
    }
  }
  results.forEach((r) => { delete r._core; });

  // A dataset record claimed by several IHMCL rows is a conflict, not a match.
  const conflicts = [...matchedIds.entries()].filter(([, names]) => names.length > 1).map(([id, names]) => ({ datasetId: id, ihmclNames: names }));
  const conflictIds = new Set(conflicts.map((c) => c.datasetId));
  for (const r of results) {
    if (isMatch(r.tier) && conflictIds.has(r.candidates[0].id)) r.tier = 'conflict';
  }
  return { results, conflicts };
}

function summarise(ihmclParsed, datasetRecords, rec) {
  const tiers = {};
  for (const r of rec.results) tiers[r.tier] = (tiers[r.tier] || 0) + 1;

  const matchedDatasetIds = new Set(rec.results.filter((r) => isMatch(r.tier)).map((r) => r.candidates[0].id));
  const datasetOnly = datasetRecords.filter((d) => !matchedDatasetIds.has(d.tollplaza_id));
  const bySource = (list) => list.reduce((a, d) => { a[d.data_source] = (a[d.data_source] || 0) + 1; return a; }, {});

  // Leads for tariff verification: matched plaza with real activity but no published car single rate in the dataset.
  // These are leads only. No price is inferred from the aggregate amounts.
  const byId = new Map(datasetRecords.map((d) => [d.tollplaza_id, d]));
  const verificationLeads = [];
  for (const r of rec.results) {
    if (!isMatch(r.tier)) continue;
    const d = byId.get(r.candidates[0].id);
    const missing = d.car_single === null || d.car_single === undefined || String(d.car_single).trim() === '';
    const zero = String(d.car_single).trim() === '0';
    if ((missing || zero) && r.row.counts.car_jeep > 0) {
      verificationLeads.push({ datasetId: d.tollplaza_id, datasetName: String(d.tollplaza_name).trim(), ihmclName: r.row.plazaName, datasetCarSingle: missing ? 'missing' : '0', ihmclCarJeepCount: r.row.counts.car_jeep, reason: missing ? 'activity reported but no published car single rate' : 'activity reported while dataset car single rate is 0' });
    }
  }

  const sample = (arr, n = 25) => arr.slice(0, n);
  return {
    reportingPeriod: ihmclParsed.reportingPeriod,
    source: ihmclParsed.source,
    counts: {
      ihmclRows: ihmclParsed.rows.length,
      datasetRecords: datasetRecords.length,
      tiers,
      matchedUnique: matchedDatasetIds.size,
      datasetRecordsNotMatched: datasetOnly.length,
      datasetRecordsNotMatchedBySource: bySource(datasetOnly),
      conflicts: rec.conflicts.length,
      verificationLeads: verificationLeads.length,
    },
    unmatchedIhmcl: sample(rec.results.filter((r) => r.tier === 'unmatched').map((r) => ({ name: r.row.plazaName, piu: r.row.piu, ro: r.row.ro, totalCount: r.row.totalCount })), 200),
    ambiguous: sample(rec.results.filter((r) => r.tier === 'ambiguous').map((r) => ({ name: r.row.plazaName, candidates: r.candidates })), 100),
    fuzzyCandidates: sample(rec.results.filter((r) => r.tier === 'fuzzy_candidate').map((r) => ({ name: r.row.plazaName, similarity: r.similarity, candidates: r.candidates })), 200),
    conflicts: rec.conflicts,
    verificationLeads: sample(verificationLeads, 200),
    datasetRecordsNotMatchedSample: sample(datasetOnly.map(brief), 50),
    notes: [
      'Report only: data/latest.json was not modified and no records were merged.',
      'Only unique exact (strict or core) name matches count as matches; fuzzy and ambiguous items need human review.',
      'Aggregate counts/amounts are activity statistics; no per-vehicle toll is inferred from them.',
    ],
  };
}

module.exports = { normalizeStrict, normalizeCore, normalizeCoreNoParen, isMatch, dice, reconcile, summarise, FUZZY_THRESHOLD };
