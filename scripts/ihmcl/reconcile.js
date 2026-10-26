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

const MATCH_TIERS = new Set(['strict_exact', 'core_exact', 'core_no_paren_exact', 'alias_match']);
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
function aliasKey(name, piu) { return `${normalizeStrict(name)}|${String(piu || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`; }

/**
 * `aliases`: explicit, human-approved overrides [{ ihmclName, piu, datasetId, basis }]. An alias fixes one IHMCL row
 * (name + PIU) to one dataset record. It is reported as its own tier (alias_match), never merged into the dataset,
 * and an alias pointing at a dataset id that does not exist is an error, not silently ignored.
 */
function reconcile(ihmclRows, datasetRecords, aliases = []) {
  const byDatasetId = new Map(datasetRecords.map((d) => [d.tollplaza_id, d]));
  const aliasIdx = new Map();
  for (const a of aliases) {
    if (!byDatasetId.has(a.datasetId)) throw new Error(`Alias for "${a.ihmclName}" points at unknown dataset id ${a.datasetId}`);
    aliasIdx.set(aliasKey(a.ihmclName, a.piu), a);
  }
  const strictIdx = indexBy(datasetRecords, normalizeStrict);
  const coreIdx = indexBy(datasetRecords, normalizeCore);
  const noParenIdx = indexBy(datasetRecords, normalizeCoreNoParen);
  const coreKeys = [...coreIdx.keys()];
  const results = [];
  const matchedIds = new Map(); // dataset id -> ihmcl row names that matched it

  // Pass 1: exact tiers only (rows with an alias take the alias instead).
  for (const row of ihmclRows) {
    const alias = aliasIdx.get(aliasKey(row.plazaName, row.piu));
    if (alias) {
      const rec = byDatasetId.get(alias.datasetId);
      results.push({ row, tier: 'alias_match', candidates: [brief(rec)], aliasBasis: alias.basis || null, _core: normalizeCore(row.plazaName) });
      matchedIds.set(alias.datasetId, [...(matchedIds.get(alias.datasetId) || []), row.plazaName]);
      continue;
    }
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
    if (isMatch(r.tier) && r.tier !== 'alias_match' && conflictIds.has(r.candidates[0].id)) r.tier = 'conflict'; // an alias is an explicit decision and stays authoritative; the colliding exact row is the conflict
  }
  const stateHints = applyStateHints(results, datasetRecords);
  return { results, conflicts, stateHints };
}


// ---- State hint (review-only) ------------------------------------------------------------------------------
// IHMCL rows carry no state, only a PIU and Regional Office. We learn which states each PIU/RO covers from the
// unique exact matches (conflicts excluded), then use that ONLY to annotate rows for human review. It never
// changes a tier, never creates a match, and never edits the dataset. Hints are as reliable as the matches they
// come from, so they need enough support and are skipped otherwise.

const stateKey = (v) => (v ? String(v).toUpperCase().replace(/[^A-Z]/g, '') : null);
const labelKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sumValues = (m) => [...m.values()].reduce((a, b) => a + b, 0);

function deriveStateHints(results) {
  const piu = new Map(); const ro = new Map();
  const add = (m, k, st) => { if (!k || !st) return; const e = m.get(k) || new Map(); e.set(st, (e.get(st) || 0) + 1); m.set(k, e); };
  for (const r of results) {
    if (!isMatch(r.tier) || r.tier === 'alias_match') continue; // aliases came from hints; do not feed them back
    const st = stateKey(r.candidates[0].state);
    add(piu, labelKey(r.row.piu), st);
    add(ro, labelKey(r.row.ro), st);
  }
  return { piu, ro };
}

/**
 * PIU first (needs >=2 supporting matches), else RO (needs >=3 matches; states with >=2 matches and >=5% share).
 * `ownState` (leave-one-out): when judging an already-matched row, its own match is removed from the counts so a
 * wrong match cannot vouch for itself.
 */
function plausibleStates(row, hints, ownState = null) {
  const minus = (m) => {
    if (!m || !ownState || !m.has(ownState)) return m;
    const c = new Map(m); c.set(ownState, c.get(ownState) - 1); if (c.get(ownState) <= 0) c.delete(ownState); return c;
  };
  const p = minus(hints.piu.get(labelKey(row.piu)));
  if (p && sumValues(p) >= 2) {
    const total = sumValues(p);
    return { source: 'piu', support: total, states: [...p.entries()].filter(([, n]) => n / total >= 0.2).map(([st]) => st) };
  }
  const r = minus(hints.ro.get(labelKey(row.ro)));
  if (r && sumValues(r) >= 3) {
    const total = sumValues(r);
    return { source: 'ro', support: total, states: [...r.entries()].filter(([, n]) => n >= 2 && n / total >= 0.05).map(([st]) => st) };
  }
  return null;
}

/** Dataset records in the plausible states whose bracket-free name equals, or is a token-prefix of (or extends), the IHMCL name. */
function stateProposals(row, plaus, datasetRecords, claimedIds) {
  const toks = normalizeCoreNoParen(row.plazaName).split(' ').filter(Boolean);
  if (!toks.length) return [];
  return datasetRecords.filter((d) => {
    if (claimedIds.has(d.tollplaza_id)) return false;
    if (!plaus.states.includes(stateKey(d.state_name))) return false;
    const dt = normalizeCoreNoParen(d.tollplaza_name).split(' ').filter(Boolean);
    if (!dt.length) return false;
    const [a, b] = toks.length <= dt.length ? [toks, dt] : [dt, toks];
    return a.every((t, i) => b[i] === t);
  });
}

/** Adds `stateReview` to rows that need it. Pure annotation: tiers and match sets are untouched. */
function applyStateHints(results, datasetRecords) {
  const hints = deriveStateHints(results);
  const claimedIds = new Set(results.filter((r) => isMatch(r.tier)).map((r) => r.candidates[0].id));
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  let noHint = 0;

  for (const r of results) {
    if (r.tier === 'alias_match') continue;
    const plaus = plausibleStates(r.row, hints, isMatch(r.tier) ? stateKey(r.candidates[0].state) : null);
    if (!plaus || !plaus.states.length) { noHint++; continue; }
    const evidence = { hintSource: plaus.source, support: plaus.support, plausibleStates: plaus.states };
    const stateOf = (c) => stateKey(c.state);

    if (isMatch(r.tier)) {
      const matchedState = stateOf(r.candidates[0]);
      if (matchedState && !plaus.states.includes(matchedState)) { // a null dataset state is not comparable, so never flagged
        r.stateReview = { kind: 'matched_state_mismatch', ...evidence, matchedState: r.candidates[0].state };
      }
    } else if (r.tier === 'conflict') {
      const claimed = r.candidates[0];
      const plausible = plaus.states.includes(stateOf(claimed));
      const proposals = plausible ? [] : stateProposals(r.row, plaus, datasetRecords, claimedIds).map(brief);
      r.stateReview = { kind: plausible ? 'conflict_claim_state_plausible' : 'conflict_claim_state_implausible', ...evidence, proposals };
    } else if (r.tier === 'ambiguous') {
      const narrowed = r.candidates.filter((c) => plaus.states.includes(stateOf(c)));
      r.stateReview = { kind: narrowed.length === 1 ? 'ambiguous_narrowed_unique' : narrowed.length > 1 ? 'ambiguous_narrowed_multiple' : 'ambiguous_no_state_match', ...evidence, proposals: narrowed };
    } else {
      const proposals = stateProposals(r.row, plaus, datasetRecords, claimedIds).map(brief);
      if (proposals.length) r.stateReview = { kind: proposals.length === 1 ? 'proposal_unique' : 'proposal_multiple', ...evidence, proposals };
    }
    if (r.stateReview) bump(r.stateReview.kind);
  }
  return { counts, rowsWithoutHint: noHint, hints };
}

function summariseStateReview(results) {
  const pick = (kinds) => results.filter((r) => r.stateReview && kinds.includes(r.stateReview.kind));
  const fmt = (r) => ({ ihmclName: r.row.plazaName.trim(), piu: r.row.piu, ro: r.row.ro, tier: r.tier, ...r.stateReview });
  return {
    proposals: pick(['proposal_unique', 'proposal_multiple', 'ambiguous_narrowed_unique', 'conflict_claim_state_implausible']).map(fmt),
    matchedStateMismatches: pick(['matched_state_mismatch']).map(fmt),
    ambiguousStillOpen: pick(['ambiguous_narrowed_multiple', 'ambiguous_no_state_match']).map(fmt),
    conflictClaimsKept: pick(['conflict_claim_state_plausible']).map(fmt),
  };
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
      const suspect = !!(r.stateReview && r.stateReview.kind === 'matched_state_mismatch');
      verificationLeads.push({ matchSuspectByState: suspect, datasetId: d.tollplaza_id, datasetName: String(d.tollplaza_name).trim(), ihmclName: r.row.plazaName, datasetCarSingle: missing ? 'missing' : '0', ihmclCarJeepCount: r.row.counts.car_jeep, reason: missing ? 'activity reported but no published car single rate' : 'activity reported while dataset car single rate is 0' });
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
      verificationLeadsWithStateSuspectMatch: verificationLeads.filter((l) => l.matchSuspectByState).length,
      aliasMatches: rec.results.filter((r) => r.tier === 'alias_match').length,
      stateReview: rec.stateHints ? rec.stateHints.counts : {},
      rowsWithoutStateHint: rec.stateHints ? rec.stateHints.rowsWithoutHint : null,
    },
    unmatchedIhmcl: sample(rec.results.filter((r) => r.tier === 'unmatched').map((r) => ({ name: r.row.plazaName, piu: r.row.piu, ro: r.row.ro, totalCount: r.row.totalCount })), 200),
    ambiguous: sample(rec.results.filter((r) => r.tier === 'ambiguous').map((r) => ({ name: r.row.plazaName, candidates: r.candidates })), 100),
    fuzzyCandidates: sample(rec.results.filter((r) => r.tier === 'fuzzy_candidate').map((r) => ({ name: r.row.plazaName, similarity: r.similarity, candidates: r.candidates })), 200),
    aliasesApplied: rec.results.filter((r) => r.tier === 'alias_match').map((r) => ({ ihmclName: r.row.plazaName.trim(), piu: r.row.piu, datasetId: r.candidates[0].id, datasetName: r.candidates[0].name, basis: r.aliasBasis })),
    conflicts: rec.conflicts,
    stateReview: rec.stateHints ? summariseStateReview(rec.results) : null,
    verificationLeads: sample(verificationLeads, 200),
    datasetRecordsNotMatchedSample: sample(datasetOnly.map(brief), 50),
    notes: [
      'Report only: data/latest.json was not modified and no records were merged.',
      'Only unique exact (strict or core) name matches count as matches; fuzzy and ambiguous items need human review.',
      'alias_match rows come from the local aliases file (human-approved overrides); they are counted separately and never edit the dataset.',
      'State hints (PIU/RO -> state) are learned from the unique exact matches and are review-only: they never change a tier or a match count.',
      'Aggregate counts/amounts are activity statistics; no per-vehicle toll is inferred from them.',
    ],
  };
}

module.exports = { stateKey, deriveStateHints, plausibleStates, applyStateHints, normalizeStrict, normalizeCore, normalizeCoreNoParen, isMatch, dice, reconcile, summarise, FUZZY_THRESHOLD };
