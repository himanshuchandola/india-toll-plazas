'use strict';

/**
 * Guards against silently replacing a good dataset with a badly broken refresh
 * (e.g. an upstream API returning a near-empty payload). Compares the new
 * record count against the previous one and throws if the drop is too large.
 * A missing/empty previous dataset (oldLength === 0) has no baseline to compare
 * against, so it is always allowed through.
 */
function assertNotRegressed(newLength, oldLength, label, maxDropRatio = 0.15) {
  if (oldLength === 0) return;
  if (newLength === 0) {
    throw new Error(`${label}: new dataset is empty (previous had ${oldLength} record(s))`);
  }
  const drop = (oldLength - newLength) / oldLength;
  if (drop > maxDropRatio) {
    throw new Error(
      `${label}: new dataset has ${newLength} record(s) vs ${oldLength} previously ` +
      `(a ${(drop * 100).toFixed(1)}% drop, exceeds the ${(maxDropRatio * 100).toFixed(0)}% threshold)`
    );
  }
}

/**
 * Write JSON to filePath only after validateFn() succeeds, via write-temp-then-rename.
 * Because the existing file is only replaced by the atomic rename at the very end,
 * a thrown validation error (or a crash mid-serialize) always leaves the existing
 * file exactly as it was.
 */
function writeJsonIfValid(filePath, value, { pretty = false, validateFn } = {}) {
  if (typeof validateFn === 'function') {
    validateFn(value);
  }
  const fs = require('fs');
  const content = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

module.exports = { assertNotRegressed, writeJsonIfValid };
