#!/usr/bin/env node
'use strict';
// Local-only runner. Reads IHMCL PDFs from data/local/ihmcl/inbox and writes parsed output and reports to
// data/local/ihmcl/{parsed,reports}. Refuses to run unless that folder is git-ignored, so nothing from IHMCL
// can be committed by accident. Usage: node scripts/ihmcl/run.js [--dataset data/latest.json]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseVcWisePdf } = require('./parseVcWise');
const { reconcile, summarise } = require('./reconcile');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL = path.join(ROOT, 'data', 'local', 'ihmcl');

function isGitIgnored(p) {
  try { execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch (e) { return e.status === 1 ? false : null; } // null = could not determine (e.g. not a git repo)
}

function assertSafeOutput() {
  const probes = [path.join(LOCAL, 'inbox', 'x.pdf'), path.join(LOCAL, 'parsed', 'x.json'), path.join(LOCAL, 'reports', 'x.json')];
  for (const p of probes) {
    if (isGitIgnored(p) !== true) throw new Error(`Refusing to run: ${path.relative(ROOT, p)} is not git-ignored. Add "data/local/" to .gitignore first.`);
  }
}

function markdown(summary) {
  const c = summary.counts;
  const p = summary.reportingPeriod;
  return [
    `# IHMCL VC-wise reconciliation: ${p ? p.label : 'unknown period'} (LOCAL ONLY, do not commit)`,
    '',
    `- Reporting period inside the file: ${p ? p.period : 'not found'}`,
    `- File: ${summary.source.fileName} (sha256 ${summary.source.sha256.slice(0, 16)}..., ${summary.source.bytes} bytes), parsed ${summary.source.parsedAt}`,
    `- IHMCL rows: ${c.ihmclRows}; dataset records: ${c.datasetRecords}`,
    `- Match tiers: ${JSON.stringify(c.tiers)}`,
    `- Dataset records matched uniquely: ${c.matchedUnique}; not matched: ${c.datasetRecordsNotMatched} ${JSON.stringify(c.datasetRecordsNotMatchedBySource)}`,
    `- Conflicts (one dataset record claimed by several IHMCL rows): ${c.conflicts}`,
    `- Tariff-verification leads: ${c.verificationLeads}`,
    '',
    ...summary.notes.map((n) => `- ${n}`),
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const dsArg = args.indexOf('--dataset');
  const datasetPath = path.resolve(ROOT, dsArg >= 0 ? args[dsArg + 1] : 'data/latest.json');
  assertSafeOutput();

  const inbox = path.join(LOCAL, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const pdfs = fs.readdirSync(inbox).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (!pdfs.length) { console.log(`No PDFs in ${path.relative(ROOT, inbox)}. Download IHMCL VC-wise monthly PDFs there yourself (they are not redistributed).`); return; }

  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  fs.mkdirSync(path.join(LOCAL, 'parsed'), { recursive: true });
  fs.mkdirSync(path.join(LOCAL, 'reports'), { recursive: true });

  for (const f of pdfs) {
    const parsed = parseVcWisePdf(path.join(inbox, f));
    const tag = parsed.reportingPeriod ? parsed.reportingPeriod.period : path.basename(f, '.pdf');
    fs.writeFileSync(path.join(LOCAL, 'parsed', `${tag}.json`), JSON.stringify(parsed, null, 1));
    const summary = summarise(parsed, dataset, reconcile(parsed.rows, dataset));
    fs.writeFileSync(path.join(LOCAL, 'reports', `reconciliation-${tag}.json`), JSON.stringify(summary, null, 1));
    fs.writeFileSync(path.join(LOCAL, 'reports', `reconciliation-${tag}.md`), markdown(summary));
    console.log(markdown(summary));
    console.log(`Parse quality: ${JSON.stringify(parsed.quality)}`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { assertSafeOutput, isGitIgnored };
