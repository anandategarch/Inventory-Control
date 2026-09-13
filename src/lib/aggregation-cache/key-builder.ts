// ============================================================
//  key-builder — AggregationCache key construction
//  --------------------------------------------------------
//  Extracted from the former src/lib/aggregation-cache.ts monolith
//  (REFACTOR-1-a pure-move split). PURE module — no DB, no state,
//  fully unit-testable. Hosts the sentinel/separator constants +
//  buildCacheKey.
// ============================================================

// FIX (BUG-EDGE-4): \x1f (ASCII Unit Separator) — never appears in user input.
const SEP = '\x1f';
// FIX (BUG-2-b): sentinel markers carry a NUL (\u0000) prefix so they can
// NEVER be forged by user input. The old plain 'ALL'/'NONE' markers
// collided with literal filter values: `?area=ALL`, `?kelompok=All`
// (→ .toUpperCase() below → 'ALL'), `?outlet=ALL`, `?item=ALL`, `?pic=ALL`
// all slipped past the case-sensitive `!== 'all'` check and were cached
// under the key IDENTICAL to the no-filter view — the empty/partial
// payload was then served to every unfiltered request for the full TTL
// (cache poisoning, BUG-1-c #1). A NUL-prefixed token is impossible to
// produce via a URL query param — same philosophy as the SEP above.
//
// NOTE: changing the markers changes EVERY cache key, so all pre-fix rows
// miss once (cold recompute) and age out via cleanupExpiredCache — that
// is intentional (self-healing: any pre-fix poisoned row becomes
// unreachable under the new keys). No migration needed.
//
// FIX (BUG-2-b): 'all' stays a CASE-SENSITIVE no-filter marker, exactly
// mirroring the query layer (build-where.ts / shared.ts drop only the
// lowercase 'all') so the cache key and the SQL filter can never
// disagree. Case variants like 'ALL'/'All' are deliberately kept as
// LITERAL filter values — the query filters on them literally (0 rows),
// so they get their OWN cache entry and can no longer touch the
// no-filter key. Routes wanting case-insensitive 'all' normalization
// must normalize BEFORE calling buildCacheKey AND before querying (the
// peer-comparison family's kelompokParam pattern).
const SENTINEL_ALL = '\u0000ALL';
const SENTINEL_NONE = '\u0000NONE';

/**
 * Build a cache key from the filter parameters.
 * Format: "analysis␟2026-08␟WEEK 1␟WEEK 1␟Juli 2026␟JAWA TIMUR 1␟MLG␟1016.MLGJAK␟MINYAK MIE␟Andi"
 *
 * FIX (BUG-KELOMPOK-CACHE): kelompok was missing from the cache key → requests
 * with different kelompok filters shared the same cache entry → cache poisoning
 * (e.g., user A selects kelompok="MLG" then user B with no filter gets A's
 * filtered result, or vice-versa). Adding kelompok to the key fixes this.
 *
 * FIX (BUG-EDGE-4): Use ASCII Unit Separator (\x1f) as delimiter instead of `|`.
 * The old `|` separator could cause key collision if any filter value contained
 * `|` (e.g., month="a|b" + week="c" → same key as month="a" + week="b|c").
 * \x1f is a control character that will never appear in user input, making the
 * key collision-proof.
 *
 * FIX (BUG-BE-5 / BUG-PERF-7): normalize 'all' → the no-filter sentinel +
 * uppercase kelompok so that `?kelompok=all` and no kelompok param produce
 * the SAME cache key. (BUG-2-b: the sentinel is now NUL-prefixed — see
 * SENTINEL_ALL above — so it can never collide with a literal filter value.)
 *
 * PERF-CACHE-01..04: `extra` field for route-specific params that affect the
 * response but aren't part of the standard filter set (e.g. pareto's parentDim/
 * childDim, recommendations' limit, export-report's sections, heatmap's
 * metric+itemLimit+mode). Omitting these
 * from the key caused cache poisoning (two requests with different params
 * sharing one cache entry → wrong response served).
 */
export function buildCacheKey(parts: {
  route: string;
  month?: string | null;
  week?: string | null;
  compareWeek?: string | null;
  compareMonth?: string | null;
  area?: string | null;
  kelompok?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  pic?: string | null;
  // PERF-CACHE: route-specific params that affect the response shape/content.
  // Joined as `key=value` pairs (sorted by key for determinism) after the
  // standard filter components. Empty/undefined values are omitted.
  extra?: Record<string, string | number | null | undefined>;
}): string {
  const filter = [
    parts.month || SENTINEL_ALL,
    parts.week || SENTINEL_ALL,
    parts.compareWeek || SENTINEL_NONE,
    parts.compareMonth || SENTINEL_NONE,
    parts.area && parts.area !== 'all' ? parts.area : SENTINEL_ALL,
    parts.kelompok && parts.kelompok !== 'all' ? parts.kelompok.toUpperCase() : SENTINEL_ALL,
    parts.outletCode && parts.outletCode !== 'all' ? parts.outletCode : SENTINEL_ALL,
    parts.itemName || SENTINEL_ALL,
    parts.pic || SENTINEL_ALL,
  ];
  // PERF-CACHE: append route-specific extras (sorted for determinism).
  // Format: "key=value" — value is stringified; null/undefined/empty → skipped.
  if (parts.extra) {
    const extras = Object.keys(parts.extra).sort()
      .map((k) => {
        const v = parts.extra![k];
        if (v === null || v === undefined || v === '') return null;
        return `${k}=${String(v)}`;
      })
      .filter((s): s is string => s !== null);
    if (extras.length > 0) {
      filter.push(extras.join(','));
    }
  }
  return `${parts.route}${SEP}${filter.join(SEP)}`;
}
