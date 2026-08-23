# Task SPLIT-COMPONENTS — Component Splitter

**Task:** Split `PrioritySummaryCard.tsx` (1238 lines) and `RestoAnalysis.tsx` (985 lines) into smaller, maintainable sub-components (Phase 3 of dashboard refactor).

## Context Used
Read `/home/z/my-project/worklog.md` (Phase 3 entries — 62 unit tests, audit fixes, type-safety work).

## Outcome

### PrioritySummaryCard.tsx split — 1238 → 383 lines (-69%)

Created `src/components/dashboard/priority-summary/`:

| File | Lines | Contents |
|---|---|---|
| `types.ts` | 67 | `SignalScore`, `Recommendation`, `OutletItem` interfaces |
| `constants.ts` | 128 | `SIGNAL_GROUPS`, `SIGNAL_ICONS`, `CHART` palette, `CHART_TEXT`, `TOOLTIP_STYLE`, `SIGNAL_EXPLANATIONS` |
| `helpers.ts` | 41 | `priorityBadge()`, `seededRand()` |
| `chart-data-builders.ts` | 296 | All 15 `build*Data()` functions (DevBom, DeviasiGrowth, TrendMemburuk, ZScore, ResidualRatio, LossSales, DirectionFlip, ItemConcentration, TolBreachHigh, TolBreach, OverExplained, HighLoss, Benchmark, ResidualNominal, NoToleranceRows) |
| `signal-chart.tsx` | 386 | `ChartEmptyState` + `SignalChart` (15 switch cases) + extracted shared `fmtNominalLabel` helper |

`PrioritySummaryCard.tsx` is now a thin wrapper that imports from `./priority-summary/*` and re-exports `Recommendation` + `OutletItem` types for backward compatibility.

### RestoAnalysis.tsx split — 985 → 412 lines (-58%)

Created `src/components/dashboard/resto-analysis/`:

| File | Lines | Contents |
|---|---|---|
| `types.ts` | 127 | `RestoProfile`, `ItemRow`, `OutletItemsResponse`, `ItemHistoryTimelineRow`, `ItemHistoryResponse`, `RecommendationResponse` |
| `helpers.tsx` | 79 | `fmtGrowth`, `growthColor`, `priorityColor`, `priorityBg`, `directionColor`, `Row`, `SummaryCard` (.tsx because components) |
| `item-detail-modal.tsx` | 167 | `ItemDetailModal` (uses `/api/item-history`) |
| `menu-analysis.tsx` | 167 | `MenuAnalysis` (Phase 3 menu outlier detection) |
| `ranking-nasional.tsx` | 140 | `RankingNasionalCard` |

`RestoAnalysis.tsx` keeps the main `RestoAnalysis` component (header + 6 profile cards + Bahan Analysis table + delegation to sub-components) and re-exports types for backward compat.

## Verification

```
npx tsc --noEmit         → 0 errors ✓
bun run lint             → 0 errors, 9 pre-existing warnings (none in new files) ✓
bun run test             → 62/62 tests pass (482ms) ✓
```

Backward-compat imports still work:
- `src/components/dashboard/RestoAnalysis.tsx:14` → `import { PrioritySummaryCard, type OutletItem, type Recommendation } from '@/components/dashboard/PrioritySummaryCard'` ✓
- `src/app/page.tsx:20` → `import { RestoAnalysis } from '@/components/dashboard/RestoAnalysis'` ✓

## Commit + Push
- Commit: `c7f247f` — "refactor: Phase 3 — split PrioritySummaryCard (1238→<500) + RestoAnalysis (985→<500)"
- Pushed to `github.com/anandategarch/Inventory-Control.git` main branch (`ef1dabf..c7f247f`)

## Notes for Future Agents
- New files in `priority-summary/` and `resto-analysis/` use relative imports (`./types`, `./constants`) for intra-module deps and absolute `@/...` imports for cross-module deps.
- `helpers.tsx` in `resto-analysis/` is intentionally `.tsx` (not `.ts`) because it contains `Row` + `SummaryCard` JSX components.
- The `fmtNominalLabel` helper was extracted inside `signal-chart.tsx` to deduplicate the inline `LabelList` formatter logic that was repeated 6 times in the original `SignalChart` switch cases.
- No behavioral changes — pure code organization refactor. All 15 chart data builders, 15 chart switch cases, 5 helper functions, and 4 sub-components moved verbatim with no logic edits.
