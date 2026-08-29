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

    // 3. DB cache check (for heavy routes)
    const cacheKey = buildCacheKey({ route: 'route-name', month, week, ...filters });
    const cached = await getCached(cacheKey, 5 * 60 * 1000);
    if (cached) return NextResponse.json(cached, { headers: CACHE_ANALYSIS });

    // 4. Compute
    const result = await heavyQuery(...);

    // 5. Cache write (MUST await with awaitWrite=true)
    await setCached(cacheKey, result, true);

    // 6. Response with cache headers
    return NextResponse.json({ success: true, ...result, durationMs: Date.now() - startedAt }, { headers: CACHE_ANALYSIS });
  } catch (e: unknown) {
    return errorResponse(e, 'route-name'); // MUST prefix with 'return'
  }
}
```

## 2. Response Shape

| Type | Shape |
|------|-------|
| Success | `{ success: true, ...data, durationMs: number, cached?: boolean }` |
| Error | `{ success: false, error: string }` + HTTP status code |
| Binary (export) | `new NextResponse(new Uint8Array(buffer), { headers: {...} })` |

- Always include `durationMs` for analysis routes
- Include `period: { month, week }` for data routes
- `cached: true` flag when returning from DB cache

## 3. Cache Pattern

```typescript
// Build key (resolve month case BEFORE building key)
const cacheKey = buildCacheKey({
  route: 'route-name',
  month,                    // MUST be resolved via resolveMonthLabel() first
  week,
  compareWeek, compareMonth,
  area, kelompok, outletCode, itemName, pic,
});

// Read (5-min TTL)
const cached = await getCached<unknown>(cacheKey, 5 * 60 * 1000);
if (cached && typeof cached === 'object' && 'success' in cached) {
  return NextResponse.json(cached, { headers: CACHE_ANALYSIS });
}

// Write (MUST await, awaitWrite=true for critical caches)
await setCached(cacheKey, result, true);

// Invalidate (on mutations: ingest, settings, pic, data delete, migrate)
await invalidateAnalysisCache(); // Clears ALL 5 cached routes
```

### Cached Routes (5)
`analysis`, `pareto`, `recommendations`, `resto-bahan-matrix`, `export-report`

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

For cards that render a small, dense comparison table + narrative findings (e.g. `BomCorrelationCard`), follow this template:

```typescript
'use client';
import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { fmtNum, fmtPct } from '@/lib/format';

interface MetricRow { name: string; current: number | null; growth: number | null; previous: number | null; aligned: boolean | null }

function CardInner({ data }: { data: AnalysisData }) {
  const s = data.executiveSummary;
  // 1. Pull growth values from exec summary (already server-computed)
  // 2. Build rows array inside an IIFE so we can early-return [] when data is null
  // 3. Build findings array (text + 'warning' | 'ok' type) inside another IIFE
  // 4. Render Table + findings list
}

export const BomCorrelationCard = memo(CardInner);
```

Key conventions:
- Type the props as `{ data: AnalysisData }` — do NOT pass derived values as separate props (keeps the prop interface stable).
- Use `FormulaInfo` in the header to explain the rule (formula + description + example + side).
- Use `null` for "no data" sentinel (not `0` or `undefined`) and render `—` in the cell.
- Compute alignment booleans in TS, not SQL — keeps the SQL evaluator simple.
- Findings array: push only when an anomaly is detected; fall back to a single "all aligned" ok message.

## 6. Rule Definition Conventions

Rules live in two places:
1. `src/config/rules.yaml` — **source of truth** (DSL: comparison + logical + arithmetic operators).
2. `src/config/rules.ts` — TS mirror (used by the legacy JS evaluator on `/api/item-history` and `/api/outlet-items`; some fields still use the older `direction`-based conditions).

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
- **BOM_DEVIATION_DISPROPORTIONATE** uses `deviationBomRatio > 1.5` to catch the 1.5×–2× band that `BOM_DEVIATION_MISMATCH` (rule 3, factor = `bomDeviationFactor` = 2) misses.
- **Narrative template** must reference both growth values so the analyst can see both numbers without drilldown.

### 6.4 SQL vs JS Evaluator Patterns

The codebase has TWO rule evaluators — they serve different routes and must stay in sync on rule semantics:

| Evaluator | File | Routes | Rule count | Notes |
|-----------|------|--------|------------|-------|
| SQL push-down | `src/lib/queries/rule-evaluation.ts` (`evaluateRulesSql`) | `/api/analysis`, `/api/export-report` | 16 (all non-zScore) | Single SQL query; runs in ~2–3s for 35K records. **Active path.** |
| JS post-process | `src/lib/queries/rule-evaluation.ts` (`evaluateHistoricalRulesJs`) | same | 5 (zScore-based) | Uses `historicalByOutletItem` Map; runs in JS after the SQL eval. |
| Legacy JS | `src/engine/rules/evaluator.ts` | `/api/item-history`, `/api/outlet-items` | 17 (no BOM Correlation) | Older single-record evaluator; not updated with BOM Correlation rules. |

When adding a rule, prefer the **SQL push-down** path (Stage 1) unless the rule needs historical stats. Update `RULE_MAP` in `rule-evaluation.ts` and add the corresponding `CASE WHEN` column. Do NOT add the rule to `src/engine/rules/evaluator.ts` unless the `/api/item-history` route needs it — and if you do, document the divergence in a comment.

## 7. Naming Conventions

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

## 8. Validation Pattern

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

## 9. Security Checklist (for new routes)

- [ ] Zod validation on ALL params
- [ ] Rate limiting (`rateLimit` + `getClientIP`)
- [ ] Error sanitization (`errorResponse` with `return`)
- [ ] Auth: add to `PROTECTED_PATHS` + `config.matcher` if mutation
- [ ] Cache: add route name to `invalidateAnalysisCache` if cached
- [ ] No `$queryRawUnsafe` — use `Prisma.sql` tagged templates
- [ ] No `console.error` — use `logger.error`
- [ ] HTTP Cache-Control header (`CACHE_ANALYSIS` or `CACHE_METADATA`)

## 10. Testing Pattern

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

## 11. Git Commit Pattern

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

## 12. Number Formatting

| Function | Use Case | Example |
|----------|----------|---------|
| `fmtIDR(value)` | Currency (Rupiah) | `Rp 1,5 jt` |
| `fmtPctAbs(value)` | Percentage (absolute) | `45,2%` |
| `fmtNum(value)` | Quantity (compact) | `1,2 rb` / `3,5 jt` / `2,1 M` |
| `fmtPct(value)` | Percentage (signed) | `+12,5%` / `-8,3%` |

- Always pass `'id-ID'` to `toLocaleString()` (never use browser default)
- Indonesian decimal separator: `,` (not `.`)
- Indonesian thousand separator: `.` (not `,`)

## 13. State Management

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

## 14. File Organization

```
src/
├── app/api/{route}/route.ts          # API handler
├── app/api/{route}/services/         # Extracted orchestrators (if route > 200 lines)
├── components/dashboard/             # Dashboard components
├── components/filters/               # Filter + dialog components
├── components/ui/                    # shadcn/ui primitives (don't modify)
├── lib/queries/                      # SQL query modules
├── lib/metrics/                      # Pure calculation functions
├── hooks/                            # React hooks (useAnalysis, useDashboard)
├── engine/                           # Business logic (rules, analysis)
└── config/                           # YAML/TS config (rules, thresholds)
```

- **Route > 200 lines?** Extract to `services/` folder
- **Query > 200 lines?** Split into sub-functions
- **Component > 300 lines?** Split into sub-components
- shadcn/ui files: **never modify** (regenerated by CLI)
- **Rule definitions**: edit `src/config/rules.yaml` (source of truth) AND `src/lib/queries/rule-evaluation.ts` `RULE_MAP` + `CASE WHEN` column — keep both in sync.
- **Growth fields**: add to the `CROSS JOIN LATERAL` growth CTE in `rule-evaluation.ts` with `ABS(curr) - ABS(prev)` numerator + div-by-zero guard. Return `NULL` when prev is missing.
