# Code Conventions

> **Read before writing any new code.** This document defines the rules for consistency across the codebase.

## 1. API Route Pattern

Every API route should follow this structure:

```typescript
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 30 for light routes

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // 1. Rate limit
    const ip = getClientIP(req);
    const rl = rateLimit(`route-name:${ip}`, RATE_LIMITS.analysis.maxRequests, RATE_LIMITS.analysis.windowMs);
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Rate limit exceeded.' }, { status: 429 });

    // 2. Zod validation
    const validation = validateQuery(schemaName, url.searchParams);
    if (!validation.success) return NextResponse.json({ success: false, error: validation.error }, { status: 400 });

    // 3. Heavy routes: DB cache + in-flight dedup + SWR via withCacheAndDedup
    //    (PREFERRED — see §3.1; /api/analysis uses the bespoke raw-JSON passthrough pipeline)
    const cacheKey = buildCacheKey({ route: 'route-name', month, week, ...filters, extra: { ...routeSpecificParams } });
    const { data, cached, stale } = await withCacheAndDedup<ResultType>(
      cacheKey,
      5 * 60 * 1000,
      async () => heavyQuery(...),
    );

    // 4. Response — envelope rebuilt per request (never cached); surface flags per §2
    const payload = { success: true, ...data, ...(cached ? { cached: true } : {}), ...(stale ? { stale: true } : {}) };
    return NextResponse.json(payload, { headers: CACHE_ANALYSIS, });
  } catch (e: unknown) {
    return errorResponse(e, 'route-name'); // MUST prefix with 'return'
  }
}
```

> **Note.** Sub-routes under the same path (e.g. `/api/area-item-heatmap/cell-detail`)
> follow the same pattern but with their own `rateLimit` namespace, Zod schema,
> and (optional) cache wrapper. The cell-detail route is intentionally NOT cached
> (drill-down is user-initiated, low QPS, fresh data expected on every click).

## 2. Response Shape

| Type | Shape |
|------|-------|
| Success | `{ success: true, ...data, durationMs: number, cached?: boolean, stale?: boolean }` |
| Error | `{ success: false, error: string }` + HTTP status code |
| Binary (export) | `new NextResponse(new Uint8Array(buffer), { headers: {...} })` |

- Always include `durationMs` for analysis routes
- Include `period: { month, week }` for data routes
- `cached: true` flag when returning from DB cache
- `stale: true` flag (PERF-CACHE-09 SWR) when returning from an EXPIRED cache
  entry while a background recompute is in flight. Surfaced by 18 JSON routes
  (all cached routes except export-report binary — see §3.1).

## 3. Cache Pattern

```typescript
// Build key (resolve month case BEFORE building key)
const cacheKey = buildCacheKey({
  route: 'route-name',
  month,                    // MUST be resolved via resolveMonthLabel() first
  week,
  compareWeek, compareMonth,
  area, kelompok, outletCode, itemName, pic,
  extra: { /* route-specific params that change the result — omitting causes cache poisoning */ },
});

// PREFERRED: one call = cache lookup + in-flight dedup + SWR + cache write
const { data, cached, stale } = await withCacheAndDedup<unknown>(
  cacheKey,
  5 * 60 * 1000,
  () => computeFn(), // runs only on miss (or as background SWR recompute) — MUST return plain JSON-serialisable object
);

// Invalidate (on mutations: ingest, settings, pic, data delete, migrate)
await invalidateAnalysisCache(); // Clears ALL 20 cached routes
```

**Legacy manual helpers** (`getCached`/`setCached`) hanya dipakai jalur non-SWR; `getCachedWithMeta` + `getCachedRawWithMeta` (raw string, zero-parse) ada untuk pipeline bespoke (`/api/analysis`).

### 3.1 SWR (Stale-While-Revalidate) — PERF-CACHE-09

`withCacheAndDedup()` implements SWR on top of the DB cache. On an EXPIRED cache
entry, the stale payload is returned immediately (marked `stale: true`) while a
fire-and-forget background recompute refreshes the cache. Concurrent requests
during the recompute get FRESH data (via in-flight dedup) — only the first
request after TTL expiry sees the stale response.

```typescript
// In a route handler — preferred over the manual getCached/setCached dance.
import { buildCacheKey, withCacheAndDedup } from '@/lib/aggregation-cache';

const cacheKey = buildCacheKey({ route: 'route-name', month, week, ...filters, extra: { ...routeSpecificParams } });
const { data, cached, stale } = await withCacheAndDedup<ResponseType>(
  cacheKey,
  5 * 60 * 1000, // 5-min TTL — same as the manual getCached pattern
  async () => {
    // computeFn — runs only on miss (or as the background SWR recompute).
    // MUST return a plain JSON-serialisable object (no Date, no class instances).
    const result = await heavyQuery(...);
    return { success: true, period: { month, week }, ...result, durationMs: Date.now() - startedAt };
  },
);

// Surface the cache flags on the response per §2.
const payload = cached
  ? { ...data, cached: true, ...(stale ? { stale: true } : {}) }
  : data;
return NextResponse.json(payload, { headers: CACHE_ANALYSIS });
```

SWR contract:
1. **In-flight dedup**: register the Promise BEFORE any `await`. Concurrent
   requests for the same key await the same Promise.
2. **Fresh hit** → return `{ data, cached: true }` (no `stale` flag).
3. **Stale hit (SWR)** → return `{ data: stale, cached: true, stale: true }` in
   <50ms; fire-and-forget background recompute that writes the fresh cache via
   `setCached(awaitWrite=true)` and resolves the in-flight Promise.
4. **No entry** → compute synchronously + write cache + resolve in-flight.
5. **On error**: reject in-flight + re-throw.
6. **`/api/export-report`** uses `withCacheAndDedup` but returns binary (docx
   **base64** payload — P3-HYG-4) — the `stale` flag is NOT surfaced on the
   response (the client gets the stale file immediately; the next download gets
   fresh). SWR still works internally.
7. **`/api/analysis`** IS on SWR (migrated): TTL 30 mnt (env
   `ANALYSIS_CACHE_TTL_MINUTES`) + `triggerBackgroundRecompute()` (guarded,
   fire-and-forget) + **raw-JSON passthrough** (P3-HYG-1): cache hit serves the
   stored JSON string directly — flag envelope injected via O(1) string surgery
   after the leading `{` (safe: stored payload never contains `cached`/`stale`);
   in-flight resolved with a `{__rawJson, stale}` marker. LONG TTL is safe
   because mutations ALWAYS invalidate explicitly.
8. **Envelope flags rebuilt per request** — `cached`/`stale` are NEVER stored in
   the cached payload (poisoning the cache with stale flags would freeze them).

### Cached Routes (20)

`analysis`, `pareto`, `recommendations`, `resto-bahan-matrix`, `export-report`,
`heatmap`, `outlet-items`, `item-history`, `drilldown`, `item-trend`,
`item-peer-comparison`, `item-trend-rank`, `flip-ranking`, `flip-ranking-drilldown`,
`item-anomali-outlets`, `peer-comparison`, `peer-comparison-items`,
`peer-comparison-trend` (P3-HYG-3), `compliance`, `chronic-outlets` (PAKET E).

All 20 are invalidated on any mutation via `invalidateAnalysisCache()` (clears
every prefix in the list). The `extra` field on `buildCacheKey` carries
route-specific params (e.g. `metric + itemLimit + mode` for heatmap,
`parentDim + childDim` for pareto, `priority + limit` for resto-bahan-matrix,
`sections` for export-report, `mode/limit/topItems/peers` for peer-comparison ×3)
— omitting these from the key causes cache poisoning between two requests with
different params. **MENAMBAH ROUTE CACHE BARU → WAJIB daftarkan prefix-nya di
`invalidateAnalysisCache()`** (kasus nyata: compliance + chronic-outlets sempat
tidak terdaftar → mutasi menyajikan data basi 5 mnt).

## 4. Error Handling

```typescript
// CORRECT — always use errorResponse + return
} catch (e: unknown) {
  return errorResponse(e, 'route-name');
}

// WRONG — leaks internals, missing return
} catch (e: unknown) {
  console.error(e); // NEVER use console.error
  NextResponse.json({ error: e.message }, { status: 500 }); // missing 'return'
}
```

- **Dev mode**: `errorResponse` returns full error message for debugging
- **Production**: returns generic `"Internal server error"` (no DB schema/SQL leakage)
- **Logger**: `logger.error('[route-name] error', { error: e instanceof Error ? e.message : String(e) })`
- **Never** use `console.error` — always use `logger.error`

## 5. Component Pattern

```typescript
// Always memoize
export const ComponentName = memo(function ComponentName({ data }: Props) {
  // Zustand: use useShallow for selective re-renders
  const { field1, field2 } = useDashboard(useShallow((s) => ({
    field1: s.field1, field2: s.field2,
  })));

  // Derived data: useMemo
  const sorted = useMemo(() => [...items].sort(...), [items, sortKey]);

  // Handlers: useCallback
  const handleClick = useCallback(() => { ... }, [deps]);

  return <Card>...</Card>;
});

// In page.tsx: wrap with ErrorBoundary
<ErrorBoundary label="Component Name">
  <ComponentName data={analysis.data} />
</ErrorBoundary>

// Heavy components: lazy-load
const HeavyChart = dynamic(() => import('...'), { ssr: false, loading: () => <LoadingChart /> });
```

### 5.1 Detail-Heavy Card Template (BomCorrelationCard)

For cards that render per-record findings + a small dense comparison table + narrative (e.g. `BomCorrelationCard` after the FIX-BOM-UI rewrite), follow this template:

```typescript
'use client';
import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { fmtNum, fmtPct } from '@/lib/format';

interface MetricRow { name: string; current: number | null; growth: number | null; previous: number | null; aligned: boolean | null, isBaseline?: boolean }

function CardInner({ data }: { data: AnalysisData }) {
  const s = data.executiveSummary;
  const findings = data.bomCorrelationFindings ?? [];
  const counts = data.bomCorrelationCounts;
  // 1. Per-record findings table (PRIMARY): render `findings` rows directly —
  //    server pre-computed, sorted by rulePriority DESC. Use per-rule count
  //    badges from `counts` (only render badges where count > 0).
  // 2. Aggregate alignment table (SECONDARY): build rows array inside an IIFE
  //    so we can early-return [] when `s` is null. Mark BOM row with isBaseline.
  // 3. Narrative findings array: text + 'warning' | 'ok' type.
  // 4. Render scroll container around findings table (max-h-96 + overflow-y-auto)
  //    so TableHeader sticky actually sticks.
}

export const BomCorrelationCard = memo(CardInner);
```

Key conventions:
- Type the props as `{ data: AnalysisData }` — do NOT pass derived values as separate props (keeps the prop interface stable).
- Use `FormulaInfo` in the header to explain the rule (formula + description + example + side).
- Use `null` for "no data" sentinel (not `0` or `undefined`) and render `—` in the cell.
- For growth cells: positive=red, negative=green, zero/null=muted (`growthColorClass` helper).
- For ratio cells: format with Indonesian decimal separator via `fmtRatio(v, '×')` (e.g. `2,5×`).
- Stable React keys: composite slug (`${outletId}-${itemId}-${ruleCode}-${akunPenyesuaian ?? ''}`), never array index.
- Wrap scrollable findings table in a `max-h-96 overflow-y-auto` container so `TableHeader` sticky actually sticks.
- Add `<TableCaption className="sr-only">` per table for screen-reader accessibility.
- Compute alignment booleans in TS, not SQL — keeps the SQL evaluator simple.

### 5.2 Tab Component Pattern

Dashboard sections live in `tabs/{DashboardTab,RestoTab,PeerTab,ParetoTab}.tsx`,
NOT in `page.tsx` (which is a 227-line thin orchestrator). When adding a new
section to a tab, follow this template:

```typescript
// src/components/dashboard/tabs/DashboardTab.tsx
'use client';
import { memo } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { FetchAware, LoadingChart, SectionHeader } from '@/components/dashboard/shared';

// Lazy-load heavy chart components (Recharts = 5.4MB). ssr: false — charts
// use ResponsiveContainer which needs window.
const NewChart = dynamic(() => import('@/components/dashboard/NewChart').then(m => m.NewChart), {
  ssr: false,
  loading: () => <LoadingChart />,
});

export const DashboardTab = memo(function DashboardTab({ data, isFetching }: DashboardTabProps) {
  return (
    <FetchAware isFetching={isFetching}>
      <ErrorBoundary label="New Section">
        <NewChart data={data} />
      </ErrorBoundary>
    </FetchAware>
  );
});
```

Conventions:
- **Keep-alive WAJIB (PAKET A)**: `<TabsContent forceMount className="data-[state=inactive]:hidden">` — pindah tab TIDAK unmount subtree (state lokal: sort, expand, scroll bertahan). Tanpa forceMount, tiap balik tab = remount + semua `useQuery` mount ulang (refetch storm).
- Wrap the tab in `React.memo` — `page.tsx` re-renders on any Zustand state
  change (modal toggles, filter selections); without memo, the active tab
  re-renders unnecessarily. TanStack Query returns stable `data` refs (same ref
  unless data actually changes), so memo is effective.
- Always wrap sections in `ErrorBoundary` + `FetchAware` so a single chart
  failure doesn't nuke the whole tab.
- Lazy-load chart components via `next/dynamic({ ssr: false, loading: () => <LoadingChart /> })`.
- The `data` prop is `AnalysisData` (typed in `src/hooks/useAnalysis.ts`).
  Don't pass derived values as separate props (keeps the prop interface stable
  + memo effective).
- New tabs (7th tab onwards) also need: a `<TabsTrigger>` in `page.tsx`, a
  `<TabsContent forceMount>` in `page.tsx`, an entry in the keyboard-shortcut
  handler in `useDashboardActions.ts` (digit `1..6` — probe dropdown-open
  HANYA di dalam cabang digit, P3-HYG-6), dan invalidasi TanStack key baru di
  `handleRefresh` (`useDashboardActions.ts`).

### 5.3 Lazy Sheet Pattern

Heavy drill-down Sheets (e.g. `AreaItemHeatmapSheet`) MUST be lazy-loaded so
their code is not in the eager parent chunk. The Sheet's own `useQuery` makes
the chunk code-loaded-only-on-first-open.

```typescript
// In the parent component (e.g. AreaItemHeatmap.tsx)
import dynamic from 'next/dynamic';

const AreaItemHeatmapSheet = dynamic(
  () => import('@/components/dashboard/AreaItemHeatmapSheet'),
  { ssr: false, loading: () => null }, // null — Sheet renders its own skeleton
);

// Then render conditionally — only mounted when needed.
{selectedCell && (
  <AreaItemHeatmapSheet
    open={!!selectedCell}
    onOpenChange={handleSheetOpenChange}
    areaName={selectedCell.area}
    itemName={selectedCell.item}
    monthLabel={monthLabel}
    currentWeek={currentWeek}
    filters={sheetFilters} // MUST be memoized — see below
  />
)}
```

Conventions:
- Memoize the `filters` prop with `useMemo` — otherwise the Sheet's internal
  `useMemo(() => params, [filters])` recomputes every render (busts the query
  key → spurious refetches).
- Memoize the `onOpenChange` callback with `useCallback` — otherwise the Sheet
  can remount on every parent render.
- In the Sheet's `useQuery`: set `placeholderData: keepPreviousData` (no
  skeleton flicker when switching between cells/records) + `refetchOnWindowFocus:
  false` (user-initiated drill-down — no need to refetch on tab focus).
- The Sheet's `queryFn` should be enabled only when `open === true` (via
  `enabled: open && !!monthLabel && ...`) so closing the Sheet cancels any
  pending fetch.

## 6. Rule Definition Conventions

Rules live in one place:
1. `src/config/rules.yaml` — **sole source of truth** untuk DEFINISI rule (DSL: comparison + logical + arithmetic operators). The previous `src/config/rules.ts` TS mirror was deleted as dead code in FIX-DOCS (was never imported at runtime); the legacy JS evaluator (`src/engine/rules/`) was likewise deleted as dead code in Task W (zero production callers since the SQL migration) — the yaml is now **spec-only documentation**.

The SQL push-down evaluator (`src/lib/queries/rule-evaluation.ts`) is the active evaluator on `/api/analysis` and `/api/export-report`. It hardcodes a `CASE WHEN` column per rule and a `RULE_MAP` entry that maps the column name → rule code + severity + category + priority. **Both must be updated together when adding a rule.**

### 6.1 Adding a New Rule (Checklist)

1. **`src/config/rules.yaml`** — append a rule entry with `code`, `name`, `category`, `severity`, `priority`, `condition`, `narrative_template`.
2. **`src/lib/queries/rule-evaluation.ts`** — add:
   - A `CASE WHEN ... THEN 1 ELSE 0 END` column in the main `SELECT` (alias `f_<snake_case_code>`).
   - A matching entry in the `RULE_MAP` array (col, code, severity, category, priority).
3. If the rule needs a new growth field, add it to the **Growth CTE** (`CROSS JOIN LATERAL (...)`) — see §6.2.
4. If the rule is zScore-based (needs historical stats), add it to `evaluateHistoricalRulesJs()` instead of the SQL.
5. Run `bun run test tests/queries/rule-evaluation.test.ts` and update expectations if needed.

### 6.2 Growth CTE Field Conventions

The growth CTE in `rule-evaluation.ts` (lines 169–193) computes period-over-period growth ratios. When adding a new metric (e.g. `wasteGrowth`), follow these conventions:

| Convention | Rule | Example |
|------------|------|---------|
| **Naming** | `<metric>Growth` (camelCase) | `wasteGrowth`, `susutGrowth`, `trialGrowth` |
| **Magnitude** | Use `ABS(curr) - ABS(prev)` in the numerator (not raw `curr - prev`) — sign-flips in the raw value would give misleading growth % | `(ABS(c."qtyWaste") - ABS(p."prevQtyWaste")) / ABS(p."prevQtyWaste")` |
| **Div-by-zero guard** | Wrap in `CASE WHEN p."prevX" IS NOT NULL AND p."prevX" != 0 THEN ... ELSE NULL END` — never divide by zero | see example above |
| **NULL sentinel** | Return `NULL` (not `0`) when prev is missing — rule conditions explicitly check `IS NOT NULL` | `g."wasteGrowth" IS NOT NULL AND ...` |
| **Prev column alias** | `prevQty<Metric>` / `prevNominal<Metric>` (camelCase) | `prevQtyWaste`, `prevNominalDeviasi` |

### 6.3 BOM Correlation Rule Conventions

The 4 BOM Correlation rules (`WASTE_BOM_MISMATCH`, `SUSUT_BOM_MISMATCH`, `TRIAL_BOM_MISMATCH`, `BOM_DEVIATION_DISPROPORTIONATE`) follow a shared pattern:

- **Severity**: `WARNING` (not `ABNORMAL`) — these are *indicators* of operational drift, not proof of fraud.
- **Priority**: 53–56 (low — lower than tolerance/residual/historical rules so they don't dominate the Priority Summary).
- **Condition shape** for mismatch rules:
  ```yaml
  condition:
    any:
      - all:
          - bomGrowth: { lt: 0 }
          - <metric>Growth: { gt: 0 }
      - all:
          - bomGrowth: { gt: 0 }
          - <metric>Growth: { lt: 0 }
  ```
- **BOM_DEVIATION_DISPROPORTIONATE** uses `deviationBomRatio > bomDisproportionateFactor` to catch the 1.5×–2× band that `BOM_DEVIATION_MISMATCH` (rule 3, factor = `bomDeviationFactor` = 2) misses. The `bomDisproportionateFactor` value is the runtime setting `BOM_DISPROPORTIONATE_FACTOR` (default `1.5`, range 1.0–5.0, exposed in the Settings dialog) — it is decoupled from `BOM_DEVIATION_FACTOR` so that lowering the latter no longer silently disables rule 8.
- **Narrative template** must reference both growth values so the analyst can see both numbers without drilldown.

### 6.4 SQL vs JS Evaluator Patterns

Rule evaluation lives in ONE file (`src/lib/queries/rule-evaluation.ts`) with two stages — they must stay in sync on rule semantics:

| Stage | Function | Routes | Rule count | Notes |
|-----------|------|--------|------------|-------|
| SQL push-down | `evaluateRulesSql` | `/api/analysis`, `/api/export-report` | 16 (all non-zScore) | Single SQL query; runs in ~2–3s for 35K records. **Active path.** |
| JS post-process | `evaluateHistoricalRulesJs` (same file) | same | 3 (zScore-based) | Uses `historicalByOutletItem` Map; runs in JS after the SQL eval. (BENCHMARK_ABOVE_AREA/NETWORK removed in FIX-RULE-CONFIG CONFIG-05.) |

The legacy per-record JS evaluator (`src/engine/rules/evaluator.ts` + its 455-line test) was deleted in Task W — it had zero production callers since the SQL migration (item-history/outlet-items never used it; doc claims to the contrary were stale). `rules.yaml` remains as the declarative spec.

When adding a rule, use the **SQL push-down** path (Stage 1) unless the rule needs historical stats. Update `RULE_MAP` in `rule-evaluation.ts` and add the corresponding `CASE WHEN` column, plus append the rule to `rules.yaml` so the spec stays in sync.

## 7. Heatmap Conventions

The Heatmap Area × Item (`AreaItemHeatmap.tsx` + `AreaItemHeatmapSheet.tsx` +
`src/lib/queries/heatmap.ts` + `/api/area-item-heatmap` +
`/api/area-item-heatmap/cell-detail`) is a visualization feature on the Dashboard
tab — NOT a business rule (it does not feed into the 19-rule engine or the
Priority Summary). When adding or modifying heatmap behaviour:

### 7.1 Dual Display (Total + Avg per Outlet)

Each cell MUST show two values when the active metric is a nominal magnitude:

- **Line 1 (bold)** — Total magnitude across all outlets in the area for that
  item (`value` field on `HeatmapCell`).
- **Line 2 (muted, smaller)** — Ø average per resto (`value / outletCount`).

Avg is computed ONLY for nominal metrics where summation is meaningful:
`absNominalDeviasi`, `nominalWaste`, `nominalSusut`. The other two metrics
(`pctQtyDeviasiToBom` is an AVG, `recordCount` is a COUNT) do NOT show avg —
dividing an average by outlet count is meaningless.

Enforced by the `AVG_ELIGIBLE_METRICS` set in `AreaItemHeatmap.tsx`. Add new
metrics to the set only if they are SUM-based magnitudes.

### 7.2 `outletCount` field is REQUIRED

The heatmap cells SQL query MUST include `CAST(COUNT(DISTINCT ir."outletId") AS
INTEGER) as "outletCount"` — without it, the dual-display avg cannot be
computed (div-by-zero guard). The drill-down Sheet's footer also uses
`rows.length` as the outlet count.

### 7.3 Pareto 80/20 is the default `mode`

The mode selector defaults to `pareto80` — items are auto-selected by
contributing to 80% of the total magnitude (cumulative). The alternative is
`top` (top N items by magnitude, where N = `itemLimit`).

For metrics where Pareto is semantically meaningless (`pctQtyDeviasiToBom` is
an AVG, `recordCount` is a COUNT), the query layer falls back to `top` mode
internally (`effectiveMode` in `queryAreaItemHeatmap`) — do NOT silently
apply Pareto to averages/counts.

The `paretoInfo` object (`totalItems`, `selectedItems`, `cumulativePct`,
`totalMagnitude`) MUST be returned on every response so the UI can render the
banner: "Menampilkan X dari Y item · Kontribusi: Z%".

### 7.4 Raw Quantities in Cells

Cells MUST return raw quantity aggregates (`qtyBom`, `qtyDeviasi`, `qtyWaste`,
`qtySusut`, `qtyTrial`, `nominalDeviasi`, `nominalLossSurplus`) in addition to
the metric `value`. The drill-down Sheet reuses these for the per-outlet table
+ TOTAL / Ø PER RESTO footer without an extra query.

### 7.5 Drill-down Sheet Footer

The Sheet MUST render TWO footer rows:

1. **TOTAL** — sum across all outlets shown (background: muted, font:
   semibold).
2. **Ø PER RESTO** — average across all outlets shown (background:
   amber-tinted, font: medium).

Dev/BOM% in the footer is recomputed as `totalQtyDeviasi / totalQtyBom` (NOT
the average of per-outlet Dev/BOM% — that would be a per-row average, which
is explicitly forbidden per §5.6 of the PRD).

### 7.6 Cache Key

The heatmap cache key MUST include `metric`, `itemLimit`, and `mode` in the
`extra` field (in addition to the standard filter set). Without these, two
requests with different metric/mode would share one cache entry → wrong
heatmap rendered.

## 8. Performance Conventions

### 8.1 Prefetch on Status Load

`useDashboardEffects.ts` fires both `prefetchAnalysis` AND `prefetchHeatmap`
on the first successful `/api/status` load — before the user has interacted
with the FilterBar. The prefetches use the SAME queryKey shape as the real
`useQuery` calls so TanStack dedupes them with the in-flight request.

```typescript
// In useDashboardEffects.ts
useEffect(() => {
  if (warmedStatusKey.current === warmKey) return;
  warmedStatusKey.current = warmKey;
  prefetchAnalysis(queryClient, params);
  prefetchHeatmap(queryClient, { month: params.month, week: params.week });
}, [status, queryClient, monthLabel, currentWeek]);
```

A `warmedStatusKey` ref guards against re-prefetching on every status
re-render (status has 5-min staleTime but its reference may update on
invalidation).

### 8.2 Parallel Resolve Independent Awaits

Independent `await`s in a route handler MUST be batched via `Promise.all`:

```typescript
// CORRECT — parallel
const [kelompokOutletCodes, picOutletCodes] = await Promise.all([
  resolveKelompokOutletCodes(kelompok),
  resolvePICOutletCodes(pic),
]);

// WRONG — sequential (wastes 50–100 ms)
const kelompokOutletCodes = await resolveKelompokOutletCodes(kelompok);
const picOutletCodes = await resolvePICOutletCodes(pic);
```

Same applies inside `withCacheAndDedup` computeFn — batch metadata fetches
(`db.sourceFile.findFirst`, `getRuntimeThresholds`, `resolvePICOutletCodes`)
into one `Promise.all` (saves ~50–100 ms on cold path).

### 8.3 Resolve Month BEFORE Building the Cache Key

```typescript
// CORRECT — resolve first, then build key
const resolver = await getMonthResolver();
const month = resolveMonthLabel(rawMonth, resolver) || rawMonth;
const cacheKey = buildCacheKey({ route: 'route-name', month, week, ... });

// WRONG — rawMonth in the key → "Agustus 2026" and "agustus 2026"
// get different cache entries for the same period.
const cacheKey = buildCacheKey({ route: 'route-name', month: rawMonth, week, ... });
```

### 8.4 `refetchOnWindowFocus: false` on All Queries

Every `useQuery` call MUST set `refetchOnWindowFocus: false`. Browser-tab
switches are frequent; default `true` triggers 6–8 s analysis refetches every
time the user returns to the tab. Manual refresh button is in `DashboardHeader`
for the rare case where the user wants to force a refetch.

Applies to: `useAnalysis`, `useStatus`, `useDrilldown`, the cell-detail query in
`AreaItemHeatmapSheet`, the heatmap query in `AreaItemHeatmap`, and any future
`useQuery`.

### 8.5 `optimizePackageImports` for Radix + Chart Libraries

`next.config.ts` MUST list every barrel-exported library used by the codebase
in `experimental.optimizePackageImports`:

- `recharts` (50+ chart primitives)
- `lucide-react` (1000+ icons)
- ALL 14 `@radix-ui/react-*` packages used by the 29 shadcn/ui components
  (dialog, select, popover, tooltip, tabs, scroll-area, checkbox, switch,
  slider, label, alert-dialog, collapsible, progress, toast).

When adding a new shadcn/ui component that pulls in a new Radix package, add
the package to `optimizePackageImports` in the same PR.

### 8.6 Statement Timeout + LIMIT Safety

Every raw SQL query MUST be wrapped in `withStatementTimeout()` (sets
`statement_timeout` + `work_mem` — **32 MB sejak PAKET B**, diturunkan dari 64 MB
karena 64 × ~10 transaksi konkuren menekan memori free-tier). Every top-N or unbounded
`GROUP BY` query MUST have an explicit `LIMIT` clause (defense-in-depth —
current production data is small but prevents unbounded payloads if the
catalog ever grows or multi-tenant scenarios arrive).

### 8.7 Render-Time Compute MUST `useMemo` (P3-HYG-7 — PAKET F)

Derived arrays/objects yang di-pass ke komponen memo (BarList, tabel, chart) WAJIB dibungkus `useMemo` — array/object literal baru per render mengalahkan memo anak. **Jebakan umum**: fallback `const items = data.x || []` membuat array kosong BARU tiap render → deps `[items]` berubah tiap render → bungkus juga fallbacknya: `useMemo(() => data.x || [], [data.x])`. Handler yang di-pass sebagai prop → `useCallback`. Pipeline berat (filter→group→sort atas ratusan baris) yang dirender di >1 tab → satu `useMemo` + pre-sort hasil di dalam memo (jangan sort inline per repaint).

### 8.8 Keydown Handler: Probe DOM Hanya di Cabang yang Butuh (P3-HYG-6)

Handler keydown global jangan menjalankan `document.querySelector(...)` sebelum guard type key — evaluasi selector HANYA setelah key terbukti relevant (mis. digit tab). Konstanta selector di-hoist ke module scope. Setiap keypress (termasuk huruf di input) tidak boleh membayar probe DOM.

### 8.9 Cache-Control Immutable — PROD Only

`next.config.ts` MUST gate the `Cache-Control: immutable` header for
`/_next/static/*` on `NODE_ENV === 'production'`. Turbopack dev mode uses
stable module-ID hashes (not content hashes), so `immutable` in dev causes
stale-chunk issues after source edits.

```typescript
async headers() {
  const isProd = process.env.NODE_ENV === 'production';
  const staticAssetRules = isProd
    ? [{ source: '/_next/static/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }]
    : []; // DEV: omit → Turbopack's default no-cache applies
  return [ ...staticAssetRules, { source: '/(.*)', headers: [ ...securityHeaders ] } ];
}
```

## 9. Git Conventions

### 9.1 Pre-push Hook (Force-Push Protection)

The repo ships `.githooks/pre-push` that BLOCKS force-push (`git push --force` /
`--force-with-lease`) to `main`. Force-push can orphan commits and cause "old
versions" to reappear in the working tree.

Activate the hook on a fresh clone:

```bash
git config core.hooksPath .githooks
```

The hook checks `git merge-base --is-ancestor` to detect non-fast-forward
pushes. To bypass (emergency only): `git push --no-verify`.

### 9.2 Cache-Control Immutable — PROD Only (Cross-Ref)

See §8.9 — the `immutable` static-asset cache header is gated on
`NODE_ENV === 'production'` to avoid breaking Turbopack dev HMR. This is a
build-config convention, not a runtime one — it lives in `next.config.ts`
`headers()`, not in any application code.

### 9.3 Git Commit Pattern (Cross-Ref to §14)

Commit message format (`type(scope): short description` + bullet body +
"Verified: 0 lint errors, N tests pass, tsc clean." footer) is documented in
§14 below.

## 10. Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| Files | kebab-case | `resto-bahan-matrix.ts` |
| Components | PascalCase | `HistoricalZScoreCard` |
| API routes | `/api/{resource}` (plural, kebab-case) | `/api/outlet-items` |
| DB models | PascalCase | `InventoryRecord` |
| DB columns | camelCase | `monthLabel`, `outletId` |
| SQL aliases | double-quoted | `"outletCode"`, `"absNominalDeviasi"` |
| Zod schemas | camelCase + `Schema` suffix | `analysisQuerySchema` |
| Test files | `{module}.test.ts` | `historical.test.ts` |

## 11. Validation Pattern

```typescript
// In src/lib/validation.ts
export const routeNameQuerySchema = z.object({
  month: z.string().min(3).max(50),
  week: weekLabelSchema,                    // /^WEEK\s+[0-9]+$/i
  area: areaSchema,                         // string max 50, optional
  kelompok: kelompokSchema,                 // string max 50, optional
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

// In route
const validation = validateQuery(routeNameQuerySchema, url.searchParams);
if (!validation.success) {
  return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
}
```

### Available Schemas
`monthLabelSchema`, `weekLabelSchema`, `areaSchema`, `kelompokSchema`, `outletCodeSchema`, `picSchema`, `itemNameSchema`, `limitSchema`, `cursorSchema`

## 12. Security Checklist (for new routes)

- [ ] Zod validation on ALL params
- [ ] Rate limiting (`rateLimit` + `getClientIP`)
- [ ] Error sanitization (`errorResponse` with `return`)
- [ ] Auth: add to `PROTECTED_PATHS` + `config.matcher` if mutation
- [ ] Cache: add route name to `invalidateAnalysisCache` if cached
- [ ] No `$queryRawUnsafe` — use `Prisma.sql` tagged templates
- [ ] No `console.error` — use `logger.error`
- [ ] HTTP Cache-Control header (`CACHE_ANALYSIS` or `CACHE_METADATA`)

## 13. Testing Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryRaw, mockExecuteRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: mockQueryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('functionName', () => {
  beforeEach(() => { mockQueryRaw.mockReset(); });

  it('returns expected result', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ /* mock row */ }]);
    const result = await functionName('WEEK 1', 'Agustus 2026', {});
    expect(result.length).toBe(1);
  });
});
```

## 14. Git Commit Pattern

```
type(scope): short description

- Bullet point 1
- Bullet point 2

Verified: 0 lint errors, N tests pass, tsc clean.
```

| Type | When |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `chore` | Maintenance, cleanup |
| `docs` | Documentation only |
| `refactor` | Code restructuring (no behavior change) |

**Git identity (WAJIB untuk repo ini):** semua commit + push memakai
`anandategarch <anandategarch@users.noreply.github.com>` sebagai author DAN
committer:
```bash
git -c user.name="anandategarch" -c user.email="anandategarch@users.noreply.github.com" commit -m "..."
```
Scope konvensi aktual: `analysis`, `be`, `fe-interact`, `deploy`, `db`,
`cache/ingest`, `ingest-integrity`, `upload/delete`, `pareto`, `hygiene`.

## 15. Number Formatting

| Function | Use Case | Example |
|----------|----------|---------|
| `fmtIDR(value)` | Currency (Rupiah) | `Rp 1,5 jt` |
| `fmtPctAbs(value)` | Percentage (absolute) | `45,2%` |
| `fmtNum(value)` | Quantity (compact) | `1,2 rb` / `3,5 jt` / `2,1 M` |
| `fmtPct(value)` | Percentage (signed) | `+12,5%` / `-8,3%` |

- Always pass `'id-ID'` to `toLocaleString()` (never use browser default)
- Indonesian decimal separator: `,` (not `.`)
- Indonesian thousand separator: `.` (not `,`)

## 16. State Management

### Zustand (client state)
```typescript
// useDashboard store — filters + UI state
const { monthLabel, currentWeek, area, setMonth } = useDashboard(
  useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    setMonth: s.setMonth,
  }))
);
```

### TanStack Query (server state)
```typescript
// useAnalysis hook
const { data, isLoading, isFetching, error, refetch } = useQuery({
  queryKey: ['analysis', month, week, ...filters],
  queryFn: () => fetchAnalysis(params),
  enabled: !!month && !!week,
  staleTime: 2 * 60 * 1000,     // 2 min
  gcTime: 10 * 60 * 1000,       // 10 min (was cacheTime)
  placeholderData: keepPreviousData, // prevent blank during refetch
  refetchOnWindowFocus: false,
});
```

## 17. File Organization

```
src/
├── app/api/{route}/route.ts          # API handler
├── app/api/{route}/services/         # Extracted orchestrators (if route > 200 lines)
├── components/dashboard/             # Dashboard components
├── components/dashboard/tabs/        # Tab-level sections (DashboardTab, RestoTab, PeerTab, ParetoTab)
├── components/filters/               # Filter + dialog components
├── components/ui/                    # shadcn/ui primitives (don't modify)
├── lib/queries/                      # SQL query modules
├── lib/metrics/                      # Pure calculation functions
├── hooks/                            # React hooks (useAnalysis, useDashboard, useDashboardEffects, useDashboardActions)
├── engine/                           # Business logic (rules, analysis)
└── config/                           # YAML config (rules, thresholds) — rules.ts deleted as dead code
```

- **Route > 200 lines?** Extract to `services/` folder
- **Query > 200 lines?** Split into sub-functions
- **Component > 300 lines?** Split into sub-components (see §5.2 Tab Component Pattern, §5.3 Lazy Sheet Pattern)
- **Dashboard page.tsx** is now a 227-line thin orchestrator — do NOT add new sections directly; put them in `tabs/*.tsx` instead (see §5.2)
- shadcn/ui files: **never modify** (regenerated by CLI)
- **Rule definitions**: edit `src/config/rules.yaml` (sole source of truth) AND `src/lib/queries/rule-evaluation.ts` `RULE_MAP` + `CASE WHEN` column — keep both in sync.
- **Growth fields**: add to the `CROSS JOIN LATERAL` growth CTE in `rule-evaluation.ts` with `ABS(curr) - ABS(prev)` numerator + div-by-zero guard. Return `NULL` when prev is missing.
- **Heatmap changes**: see §7 for the dual-display / Pareto 80% / outlet-count / drill-down Sheet conventions. The heatmap is NOT a rule — it does not feed the 19-rule engine.
- **Git hooks**: `.githooks/pre-push` blocks force-push to `main` (see §9.1). Activate via `git config core.hooksPath .githooks`.

---

*Authored by Agent DOC-PRD. Last updated by Agent DOC-INTENSIF (session audit
PAKET A/B/C/E/F: §1 route template → withCacheAndDedup, §3 cache pattern +
invalidasi 20 route (compliance/chronic-outlets didaftarkan — bug nyata),
§3.1 SWR contract item 7-8 (analysis migrated + raw-JSON passthrough), §5.2
tab keep-alive forceMount, §8.6 work_mem 32MB, §8.7 useMemo + §8.8 keydown
baru, §14 git identity; renumber §8.7→8.9. Sebelumnya: DOC-UPDATE-2 (SWR,
tab/sheet pattern, heatmap conventions; cached routes 5 → 9).*
