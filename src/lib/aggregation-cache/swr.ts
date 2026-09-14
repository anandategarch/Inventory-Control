// ============================================================
//  swr — withCacheAndDedup (cache lookup + dedup + SWR recompute)
//  --------------------------------------------------------
//  Extracted from the former src/lib/aggregation-cache.ts monolith
//  (REFACTOR-1-a pure-move split). The MOST SENSITIVE piece of the
//  split: the generation-guard miss/SWR/awaiter logic (FIX BUG-2-b)
//  moved here INTACT — the generation reads now go through
//  getCacheGeneration() (synchronous reads of the same module-level
//  counter owned by ./generation.ts) and the in-flight map is reached
//  via ./inflight.ts, both semantically identical to the pre-split
//  direct variable accesses.
// ============================================================
import { getCacheGeneration } from './generation';
import { getCachedWithMeta, setCached } from './store';
import { getInflight, setInflight } from './inflight';
import { scheduleBackground } from '../background-scheduler';

// ============================================================
//  PERF-CACHE-06: withCacheAndDedup — combines DB cache lookup + in-flight
//  Promise dedup + compute into a single helper. Used by the cached routes
//  that previously lacked in-flight dedup (pareto, recommendations,
//  export-report) + the newly-cached heatmap route.
//  /api/analysis keeps its bespoke pipeline (multi-stage with 404 short-circuit)
//  — see validate-and-resolve.ts.
//
//  PERF-CACHE-09 (SWR): Stale-While-Revalidate support.
//  On an EXPIRED cache hit, the stale payload is returned immediately
//  (with `stale: true` flag) and a background recompute is triggered
//  (fire-and-forget). The in-flight Promise (registered before any await)
//  is resolved by the background recompute so concurrent requests awaiting
//  it get FRESH data (not stale). This means:
//    - Request A (first after expiry): gets stale data in <50ms.
//    - Request B (concurrent with A's recompute): awaits in-flight → gets fresh.
//    - Request C (after recompute completes): DB cache is fresh → gets fresh.
//
//  Flow:
//    1. Check in-flight Promise → return its result if exists (await → fresh)
//    2. Register new in-flight Promise (BEFORE any await — closes the race
//       window where 2 concurrent requests both see getInflight=null and
//       both proceed to compute)
//    3. Check DB cache (via getCachedWithMeta — returns fresh + stale):
//       a. Fresh hit → resolve in-flight + return { data, cached: true }
//       b. Stale hit → return { data: stale, cached: true, stale: true }
//          AND fire-and-forget background recompute that resolves in-flight
//          + writes fresh cache via setCached(awaitWrite=true)
//    4. No cache entry → run computeFn() (synchronously, await it)
//       + setCached(awaitWrite=true) + resolve in-flight
//    5. On error: reject in-flight + re-throw
//
//  Returns `{ data, cached, stale? }` — `cached` is true for both in-flight
//  + DB hits (fresh or stale) so callers can set the `cached: true` flag on
//  the response (CONVENTIONS §2). `stale` is true ONLY for SWR returns.
//  Callers MAY surface `stale: true` on the response to let the client know
//  the data is from an expired cache entry (optional — client ignores if
//  it doesn't handle the field).
// ============================================================
export async function withCacheAndDedup<T>(
  cacheKey: string,
  ttlMs: number,
  computeFn: () => Promise<T>,
  awaitWrite: boolean = true,
): Promise<{ data: T; cached: boolean; stale?: boolean }> {
  // 1. In-flight dedup — concurrent request for same key awaits this Promise.
  //    MUST be checked BEFORE any await to close the check-then-act race.
  const inflight = getInflight<T>(cacheKey);
  if (inflight) {
    // FIX (BUG-2-b): capture the generation BEFORE awaiting. If an
    // invalidation landed while we waited, the awaited result was computed
    // from PRE-mutation data — serving it as `cached:true` would leak
    // stale data past the invalidation (BUG-1-c #2). Instead, re-enter the
    // dedup: join a newer in-flight if one was already registered, else
    // fall through and become the request that computes fresh (step 2).
    const genAtAwait = getCacheGeneration();
    const data = await inflight;
    if (genAtAwait === getCacheGeneration()) {
      return { data, cached: true };
    }
    const refreshed = getInflight<T>(cacheKey);
    if (refreshed && refreshed !== inflight) {
      // Another post-invalidation request already started a fresh compute
      // for this key — await it rather than computing a duplicate.
      const genAtSecondAwait = getCacheGeneration();
      const refreshedData = await refreshed;
      if (genAtSecondAwait === getCacheGeneration()) {
        return { data: refreshedData, cached: true };
      }
    }
    // Invalidation landed again (or nobody re-registered) — fall through
    // to a fresh compute below. No deadlock: the awaited promise already
    // settled, and step 2 registers ours (setInflight's cleanup is guarded
    // against deleting a newer registration).
  }

  // 2. Register in-flight Promise BEFORE the DB cache check (next await).
  //    This closes the race: any concurrent request that arrives while we're
  //    awaiting getCachedWithMeta will see this Promise via getInflight + await it.
  let resolveComputation!: (v: T) => void;
  let rejectComputation!: (e: unknown) => void;
  const computationPromise = new Promise<T>((resolve, reject) => {
    resolveComputation = resolve;
    rejectComputation = reject;
  });
  setInflight(cacheKey, computationPromise);

  try {
    // 3. DB cache check — getCachedWithMeta returns BOTH fresh + stale entries
    //    (does NOT delete on expiry, so the SWR path can return the stale data).
    const cachedWithMeta = await getCachedWithMeta<T>(cacheKey, ttlMs);
    if (cachedWithMeta !== null) {
      if (!cachedWithMeta.stale) {
        // 3a. Fresh hit — resolve in-flight (concurrent awaiters get fresh) + return.
        resolveComputation(cachedWithMeta.data);
        return { data: cachedWithMeta.data, cached: true };
      }

      // 3b. PERF-CACHE-09 (SWR): stale hit — return stale immediately +
      //     fire-and-forget background recompute. The in-flight Promise
      //     (registered in step 2) is resolved by the background recompute,
      //     so concurrent requests awaiting it get FRESH data.
      // FIX (BUG-3-c SEDANG-5): schedule the IIFE via after() so Vercel
      // keeps the function alive until the recompute + cache write land.
      // A plain floating promise was frozen at response time — the fresh
      // row never got written and every subsequent request kept paying a
      // cold recompute until cleanup aged the stale row out.
      scheduleBackground((async () => {
        try {
          // FIX (BUG-2-b): capture the generation BEFORE computeFn. If an
          // invalidation lands while the background recompute runs, the
          // result is (at least partly) PRE-mutation data — writing it
          // back would re-poison the just-invalidated key under a FRESH
          // computedAt (BUG-1-c #2). Skip the write; the next request
          // recomputes clean.
          const gen = getCacheGeneration();
          const fresh = await computeFn();
          if (gen === getCacheGeneration()) {
            // awaitWrite=true — block ~50-150ms so the next request hits cache.
            await setCached(cacheKey, fresh, true);
          }
          // ALWAYS resolve the in-flight Promise — never settling it would
          // hang every awaiter parked on it. Awaiters capture the generation
          // themselves before awaiting and re-enter the fresh path if it
          // advanced, so handing them the pre-mutation value is safe.
          resolveComputation(fresh);
        } catch (e) {
          rejectComputation(e);
        }
      })());
      return { data: cachedWithMeta.data, cached: true, stale: true };
    }

    // 4. No cache entry (fresh or stale) — compute synchronously.
    // FIX (BUG-2-b): generation guard — capture BEFORE computeFn; if an
    // invalidation landed mid-compute, the result is pre-mutation data
    // and must NOT be written back (the invalidation would be silently
    // undone). The data is still returned — it is already computed and
    // this response is one-off (never cached), so the next request sees
    // the post-mutation state.
    const gen = getCacheGeneration();
    const data = await computeFn();

    // 5. Cache write — awaitWrite=true blocks ~50-150ms so the next request
    //    hits the cache. awaitWrite=false fires-and-forgets (faster response,
    //    but next request may re-compute if write hasn't completed).
    if (gen === getCacheGeneration()) {
      await setCached(cacheKey, data, awaitWrite);
    }

    // 6. Resolve in-flight + return.
    resolveComputation(data);
    return { data, cached: false };
  } catch (e) {
    // Reject in-flight so concurrent awaiters get the error (not a hang).
    rejectComputation(e);
    throw e;
  }
}
