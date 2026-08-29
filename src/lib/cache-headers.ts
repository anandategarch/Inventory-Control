// ============================================================
//  Cache Headers Helper (BE-01 — Fase 1)
//
//  Adds HTTP Cache-Control headers to GET API responses so that
//  browsers and CDNs (Cloudflare, Vercel Edge, Caddy) can cache
//  responses and avoid re-hitting the server on repeat visits.
//
//  Strategy:
//  - `public`          — responses are not user-specific (no auth on GET)
//  - `s-maxage=N`      — CDN/proxy cache TTL (seconds)
//  - `stale-while-revalidate=M` — serve stale for up to M seconds while
//                        fetching fresh in background
//  - `must-revalidate` — once stale, MUST revalidate (don't serve stale forever)
//
//  NOTE: cache key includes URL query params (?month=&week=), so different
//  filter combinations get separate cache entries automatically.
//
//  All TTLs are tuned to match the underlying data freshness:
//  - analysis/pareto/etc → 5 min CDN (matches DB AggregationCache 5-min TTL)
//  - status/data list    → 1 min (metadata changes rarely)
//  - item-search         → 30s (autocomplete should feel fresh)
// ============================================================

/** Heavy analysis endpoints (5-min CDN cache, 10-min stale grace). */
export const CACHE_ANALYSIS = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600, must-revalidate',
} as const;

/** Semi-static metadata endpoints: status, data list, PIC list (1-min CDN). */
export const CACHE_METADATA = {
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120, must-revalidate',
} as const;

/** Interactive/autocomplete endpoints (30s CDN — feel fresh). */
export const CACHE_INTERACTIVE = {
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60, must-revalidate',
} as const;

/** Never cache (mutations, setup status, auth). */
export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
} as const;
