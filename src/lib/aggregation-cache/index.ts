// ============================================================
//  Aggregation Cache — DB-level caching for expensive queries.
//  --------------------------------------------------------
//  Public barrel of the REFACTOR-1-a split of the former
//  src/lib/aggregation-cache.ts monolith into:
//    ./key-builder.ts  — buildCacheKey (pure)
//    ./generation.ts   — getCacheGeneration
//    ./store.ts        — getCached / getCachedWithMeta /
//                        getCachedRawWithMeta / setCached / setCachedRaw /
//                        cleanupExpiredCache
//    ./inflight.ts     — getInflight / setInflight
//    ./swr.ts          — withCacheAndDedup
//    ./invalidate.ts    — invalidateCache / invalidateAnalysisCache
//
//  The public import path '@/lib/aggregation-cache' stays STABLE for all
//  consumers + tests — including tests/queries/query-cache.test.ts's
//  vi.mock('@/lib/aggregation-cache'), which replaces this barrel.
//  Internal imports between the split modules are file-to-file (never
//  via this barrel) to avoid import cycles. The barrel re-exports
//  EXACTLY the pre-split public API (bumpCacheGeneration is internal).
//
//  Background (from the former monolith header):
//  Uses the AggregationCache table (Prisma model) to persist
//  computed results across serverless cold starts.
//
//  FIX Medium #1 (from MASTER_CONTEXT.md): analysis route takes
//  6-8s. In-memory cache (LRUCache) is unreliable in serverless
//  (each cold start = fresh memory). DB cache survives cold starts
//  and is shared across all serverless instances.
//
//  TTL: 5 minutes (300s) by default. Configurable per cache key.
//  Cache invalidation: explicit via invalidateCache() on data
//  mutations (ingest, settings change, direction migration).
//
//  FIX M3 (AUDIT-5): in-flight Promise dedup — if two concurrent
//  requests miss the cache for the same key, only one computes;
//  the second awaits the first's result.
// ============================================================
export { buildCacheKey } from './key-builder';
export { getCacheGeneration } from './generation';
export { getCached, getCachedWithMeta, getCachedRawWithMeta, setCached, setCachedRaw, cleanupExpiredCache } from './store';
export { getInflight, setInflight } from './inflight';
export { withCacheAndDedup } from './swr';
export { invalidateCache, invalidateAnalysisCache } from './invalidate';
