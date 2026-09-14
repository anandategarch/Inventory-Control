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

// FIX (BUG-3): sentinel markers carry an ESC (\u001b) prefix so they can
// NEVER be forged by user input.
//
// HISTORY — DO NOT GO BACK TO NUL (the 2026-09 "export muter terus" incident):
//   BUG-2-b used a NUL (\u0000) prefix here. NUL is indeed unforgeable via a
//   URL param, but PostgreSQL TEXT columns REJECT the 0x00 byte entirely
//   (SQLSTATE 22021 "invalid byte sequence for encoding \"UTF8\": 0x00\") —
//   see key-builder.ts history) — so every AggregationCache upsert failed
//   silently (setCachedRaw is non-blocking by design) and the cache NEVER
//   wrote a single row: every request recomputed cold. Measured against
//   production: /api/export-report took 15-17s on EVERY call (the reported
//   "loading lama + spinner muter terus"), and the second identical request
//   within the 5-min TTL was just as slow — the cache-hit path never fired.
//   ESC (0x1b) keeps the same impossible-from-user-input property (1)
//   validation.ts rejects ALL control characters in filter params, (2)
//   sanitizeKeyPart below strips them as defense-in-depth) while being a
//   legal byte in a PostgreSQL TEXT value.
// The ORIGINAL bug (pre-BUG-2-b) was plain 'ALL'/'NONE' colliding with
// literal filter values (`?area=ALL`, `?kelompok=All` → 'ALL' after
// toUpperCase below) — those slipped past the case-sensitive `!== 'all'`
// check and were cached under the key IDENTICAL to the no-filter view
// (cache poisoning, BUG-1-c #1). The control-char prefix preserves that fix.
//
// NOTE: changing the markers changes EVERY cache key, so all pre-fix rows
// miss once (cold recompute) and age out via cleanupExpiredCache — that
// is intentional (self-healing: any pre-fix row becomes unreachable under
// the new keys). No migration needed.
//
// FIX (BUG-2-b, preserved): 'all' stays a CASE-SENSITIVE no-filter marker,
// exactly mirroring the query layer (build-where.ts / shared.ts drop only
// the lowercase 'all') so the cache key and the SQL filter can never
// disagree. Case variants like 'ALL'/'All' are deliberately kept as
// LITERAL filter values — the query filters on them literally (0 rows),
// so they get their OWN cache entry and can no longer touch the
// no-filter key. Routes wanting case-insensitive 'all' normalization
// must normalize BEFORE calling buildCacheKey AND before querying (the
// peer-comparison family's kelompokParam pattern).
const SENTINEL_ALL = '\u001bALL';
const SENTINEL_NONE = '\u001bNONE';

// FIX (BUG-3): last-resort sanitizer — strips control characters (C0, DEL,
// C1) from any part before it is embedded in the cache key, guaranteeing
// the key is always a legal PostgreSQL TEXT value. This is defense-in-depth:
// validation.ts already 400-rejects control chars in every filter param, so
// only routes that bypass validated data can reach here with controls.
// Stripping (rather than throwing) may merge two already-illegitimate
// inputs into one key — acceptable, since upstream validation rejects them.
function sanitizeKeyPart(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

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
  // FIX (BUG-3): every user-influenced part passes through sanitizeKeyPart
  // before joining — the resulting key can never contain a byte illegal for
  // the AggregationCache.cacheKey TEXT column (NUL killed every cache write
  // from the BUG-2-b deploy until now; see SENTINEL_ALL history above).
  const filter = [
    parts.month ? sanitizeKeyPart(parts.month) : SENTINEL_ALL,
    parts.week ? sanitizeKeyPart(parts.week) : SENTINEL_ALL,
    parts.compareWeek ? sanitizeKeyPart(parts.compareWeek) : SENTINEL_NONE,
    parts.compareMonth ? sanitizeKeyPart(parts.compareMonth) : SENTINEL_NONE,
    parts.area && parts.area !== 'all' ? sanitizeKeyPart(parts.area) : SENTINEL_ALL,
    parts.kelompok && parts.kelompok !== 'all' ? sanitizeKeyPart(parts.kelompok.toUpperCase()) : SENTINEL_ALL,
    parts.outletCode && parts.outletCode !== 'all' ? sanitizeKeyPart(parts.outletCode) : SENTINEL_ALL,
    parts.itemName ? sanitizeKeyPart(parts.itemName) : SENTINEL_ALL,
    parts.pic ? sanitizeKeyPart(parts.pic) : SENTINEL_ALL,
  ];
  // PERF-CACHE: append route-specific extras (sorted for determinism).
  // Format: "key=value" — value is stringified; null/undefined/empty → skipped.
  if (parts.extra) {
    const extras = Object.keys(parts.extra).sort()
      .map((k) => {
        const v = parts.extra![k];
        if (v === null || v === undefined || v === '') return null;
        return `${k}=${sanitizeKeyPart(String(v))}`;
      })
      .filter((s): s is string => s !== null);
    if (extras.length > 0) {
      filter.push(extras.join(','));
    }
  }
  return `${parts.route}${SEP}${filter.join(SEP)}`;
}
