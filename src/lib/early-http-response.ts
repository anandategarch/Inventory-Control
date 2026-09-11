// ============================================================
//  EarlyHttpResponse — shared cache-wrapped-compute abort signal
//  --------------------------------------------------------
//  FIX (H-12 / boilerplate dedup): this class was defined VERBATIM 3×
//  (export-report/services/types.ts, outlet-items/services/types.ts,
//  item-history/route.ts). All three definitions are now THIS single
//  module — behavior identical, one place to maintain.
//
//  PERF-CACHE-06 / PERF-API-01 / PERF-API-02 pattern: lets a
//  withCacheAndDedup-wrapped computeFn signal "abort compute + return
//  this response" for early-return error paths (404 No records found,
//  404 outlet not found, ...). Throwing this error propagates through
//  withCacheAndDedup's rejectComputation (so concurrent in-flight
//  awaiters also see the error) and is caught by the route's outer
//  try/catch, which returns the embedded response.
//
//  Without this, the computeFn's return type would be a union
//  (NextResponse | data) and the cache wrapper couldn't store the result.
//  The cache is NOT populated for 404s.
// ============================================================
import type { NextResponse } from 'next/server';

export class EarlyHttpResponse extends Error {
  constructor(public response: NextResponse) {
    super('EarlyHttpResponse');
    this.name = 'EarlyHttpResponse';
  }
}
