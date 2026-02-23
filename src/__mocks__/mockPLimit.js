/* global module */
/**
 * CJS-compatible mock for p-limit (ESM-only package).
 * Provides the same API: pLimit(concurrency) returns a limit function.
 */
function pLimit() {
  return (fn) => fn();
}

module.exports = pLimit;
module.exports.default = pLimit;
