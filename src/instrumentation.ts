// ============================================================
//  Next.js Instrumentation — runs once on server startup
//  ============================================================
//  BigInt.prototype.toJSON polyfill — SQLite returns BigInt for
//  SUM/COUNT/AVG columns. JSON.stringify can't serialize BigInt
//  by default, causing "Do not know how to serialize a BigInt"
//  errors in API routes. This polyfill coerces BigInt to Number
//  during JSON serialization, which is safe for our use case
//  (all values fit within Number.MAX_SAFE_INTEGER).
// ============================================================

export async function register() {
  // @ts-ignore — augmenting BigInt.prototype with toJSON
  if (typeof BigInt.prototype.toJSON !== 'function') {
    // @ts-ignore
    BigInt.prototype.toJSON = function () {
      return Number(this);
    };
  }
}
