// ============================================================
//  background-scheduler — keep background promises alive past
//  the HTTP response.
//  --------------------------------------------------------
//  FIX (BUG-3-c SEDANG-5): SWR background recomputes + fire-and-forget
//  cache writes were plain floating promises. On Vercel, a serverless
//  function is frozen right after the response is sent, so those
//  promises were killed mid-flight: the AggregationCache upsert never
//  landed and the SWR recompute never finished → the next request paid
//  a full cold recompute and the cache silently degraded (stale until
//  the 90-min cleanup TTL).
//
//  Next 16 `after()` (imported from 'next/server') registers work the
//  runtime must complete AFTER the response is flushed — the local-dev
//  equivalent of Vercel's waitUntil. It accepts a callback OR an
//  already-started promise (AfterTask = Promise<T> | (() => T | Promise<T>));
//  we pass the promise so the work starts immediately and the runtime
//  simply waits for it past response completion.
//
//  `after()` throws when called outside a request scope (unit tests,
//  scripts, cron) — in that case we fall back to plain fire-and-forget,
//  which is exactly the old behavior and still correct in a long-lived
//  Node process (local dev / `next start`).
// ============================================================
import { after } from 'next/server';

export function scheduleBackground(p: Promise<unknown>): void {
  // Attach the no-op rejection handler FIRST, in BOTH paths:
  //  - it marks `p` as handled, so a failure can never surface as an
  //    unhandled rejection that crashes the process;
  //  - the derived promise passed to after() never rejects, so the
  //    scheduled task itself cannot trigger onTaskError noise.
  // Callers are expected to log their own errors internally (all current
  // scheduled promises already wrap their bodies in try/catch).
  const guarded = p.then(
    () => undefined,
    () => undefined, // swallow — non-fatal by contract (see header)
  );
  try {
    after(guarded);
  } catch {
    // Outside a request scope (tests / scripts) — fire-and-forget.
    // `guarded` already carries the no-op catch above, so the original
    // promise's rejection is handled and nothing is left dangling.
  }
}
