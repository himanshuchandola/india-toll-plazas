'use strict';
// Local-only parser for IHMCL "VC Wise Monthly ETC FASTag Data" PDFs (text extracted with pdftotext -layout).
// IHMCL's files are "All Rights Reserved": inputs and outputs of this tool must stay git-ignored. This module
// contains no IHMCL data. Amounts are aggregate rupees collected and must never be used to infer a per-vehicle toll.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const CATEGORIES = ['car_jeep', 'lcv', 'bus_truck', 'axle_3', 'axle_4_6', 'osv'];
const NUMERIC_TOKENS = 14; // 6 categories x (count, amount) + total (count, amount)
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function extractText(pdfPath) {
  try {
    return execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('pdftotext not found. Install poppler (e.g. `brew install poppler`).');
    throw new Error(`pdftotext failed for ${pdfPath}: ${error.message}`);
  }
}

function fileFingerprint(filePath) {
  const buf = fs.readFileSync(filePath);
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** "1,17,084" -> 117084; "-" -> 0 (IHMCL prints "-" for nil); anything else -> null. */
function parseIndianNumber(token) {
  if (token === '-') return 0;
  if (!/^\d[\d,]*$/.test(token)) return null;
  const n = Number(token.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

/** Extracts the reporting month from a title like "... for the Month of Sept 2026". */
function parseTitle(line) {
  const m = /month of\s+([A-Za-z]+)\.?\s+(\d{4})/i.exec(line);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return { year: Number(m[2]), month, label: `${m[1]} ${m[2]}`, period: `${m[2]}-${String(month).padStart(2, '0')}` };
}

function parseRow(line, lineNumber) {
  const tailMatch = new RegExp(`((?:\\d[\\d,]*|-)(?:\\s+(?:\\d[\\d,]*|-)){${NUMERIC_TOKENS - 1}})\\s*$`).exec(line);
  if (!tailMatch) return null;
  const numbers = tailMatch[1].trim().split(/\s+/).map(parseIndianNumber);
  if (numbers.some((n) => n === null)) return null;

  const left = line.slice(0, tailMatch.index).trimEnd();
  const segments = left.trim().split(/\s{2,}/).filter(Boolean);
  const flags = [];
  let plazaName;
  let piu = null;
  let ro = null;
  if (segments.length === 3) {
    [plazaName, piu, ro] = segments;
  } else if (segments.length > 3) {
    plazaName = segments.slice(0, -2).join(' ');
    [piu, ro] = segments.slice(-2);
    flags.push('plaza_name_has_wide_gap');
  } else {
    plazaName = segments[0] || '';
    if (segments.length === 2) { ro = segments[1]; flags.push('piu_missing_or_merged'); } else flags.push('piu_and_ro_missing');
  }
  if (!plazaName) return null;

  const counts = {};
  const amountsInr = {};
  CATEGORIES.forEach((c, i) => { counts[c] = numbers[2 * i]; amountsInr[c] = numbers[2 * i + 1]; });
  const totalCount = numbers[12];
  const totalAmountInr = numbers[13];
  const sumCount = CATEGORIES.reduce((s, c) => s + counts[c], 0);
  const sumAmount = CATEGORIES.reduce((s, c) => s + amountsInr[c], 0);
  if (sumCount !== totalCount) flags.push('count_total_mismatch');
  if (sumAmount !== totalAmountInr) flags.push('amount_total_mismatch');

  return { line: lineNumber, plazaName: plazaName.replace(/\s+/g, ' ').trim(), piu, ro, counts, amountsInr, totalCount, totalAmountInr, flags };
}

/**
 * Parses the layout text of one IHMCL VC-wise report. Never throws on a bad row; unparsed non-blank lines are
 * returned in `unparsedLines` so nothing disappears silently.
 */
function parseVcWiseText(text) {
  const rows = [];
  const unparsedLines = [];
  let period = null;
  let title = null;
  const lines = text.replace(/\f/g, '\n').split('\n');
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;
    if (/^\s*PLAZA_NAME\b/.test(line)) return; // repeated header
    const t = parseTitle(line);
    if (t && /vc wise/i.test(line)) { period = t; title = line.trim(); return; }
    const row = parseRow(line, idx + 1);
    if (row) rows.push(row);
    else unparsedLines.push({ line: idx + 1, text: line.trim().slice(0, 160) });
  });

  const nameCounts = new Map();
  for (const r of rows) nameCounts.set(r.plazaName.toLowerCase(), (nameCounts.get(r.plazaName.toLowerCase()) || 0) + 1);
  const duplicateNames = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([name, n]) => ({ name, n }));
  const flagged = rows.filter((r) => r.flags.length).length;

  return {
    title,
    reportingPeriod: period, // the period INSIDE the file; distinct from when the file was retrieved
    rows,
    quality: {
      rowCount: rows.length,
      unparsedLineCount: unparsedLines.length,
      rowsWithFlags: flagged,
      duplicatePlazaNamesWithinFile: duplicateNames,
      totalsMismatchRows: rows.filter((r) => r.flags.some((f) => f.endsWith('_total_mismatch'))).length,
    },
    unparsedLines: unparsedLines.slice(0, 50),
  };
}

function parseVcWisePdf(pdfPath) {
  const parsed = parseVcWiseText(extractText(pdfPath));
  return { ...parsed, source: { fileName: require('path').basename(pdfPath), ...fileFingerprint(pdfPath), parsedAt: new Date().toISOString() } };
}

module.exports = { CATEGORIES, NUMERIC_TOKENS, parseIndianNumber, parseTitle, parseRow, parseVcWiseText, parseVcWisePdf, extractText };
