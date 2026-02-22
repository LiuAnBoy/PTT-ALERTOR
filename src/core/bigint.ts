/**
 * Enable BigInt JSON serialization.
 * BigInt values are converted to strings in JSON output.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function () {
  return this.toString();
};
