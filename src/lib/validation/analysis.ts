// ============================================================
//  Route-specific schemas — analysis & explore family.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema per consumer route:
//  /api/analysis, /api/drilldown, /api/outlet-items,
//  /api/item-history, /api/recommendations, /api/pareto,
//  /api/change-analysis (+/items), /api/area-item-heatmap
//  (+/cell-detail), /api/item-trend.
// ============================================================
import { z } from 'zod';
import {
  noControlChars,
  monthLabelSchema,
  weekLabelSchema,
  compareWeekSchema,
  areaSchema,
  kelompokSchema,
  outletCodeSchema,
  itemNameSchema,
  picSchema,
  limitSchema,
  cursorSchema,
} from './shared';

// /api/analysis?month=&week=&compareWeek=&area=&kelompok=&outlet=&item=&pic=
export const analysisQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  compareWeek: compareWeekSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  item: itemNameSchema,
  pic: picSchema,
});

// /api/drilldown?outletCode=&itemName=&weekLabel=&monthLabel=&area=&kelompok=&pic=&limit=&cursor=
// FIX (BUG-2-b / BUG-1-c #9): area/kelompok/pic were read raw from
// searchParams in the route (the schema here silently STRIPPED them as
// unknown keys — zod object default) → a 1000-char kelompok reached
// resolveKelompokOutletCodes' SQL unvalidated. Added with the same optional
// bounded shapes the other filter routes use (areaSchema ≤50 /
// kelompokSchema ≤50 / picSchema ≤100).
export const drilldownQuerySchema = z.object({
  outletCode: outletCodeSchema,
  itemName: itemNameSchema,
  weekLabel: weekLabelSchema,
  monthLabel: monthLabelSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  pic: picSchema,
  limit: limitSchema,
  cursor: cursorSchema,
});

// /api/outlet-items?outletCode=&month=&week=&compareWeek=
export const outletItemsQuerySchema = z.object({
  outletCode: z.string().min(1).max(50), // required
  month: monthLabelSchema,
  week: weekLabelSchema,
  compareWeek: compareWeekSchema,
  compareMonth: monthLabelSchema,
});

// /api/item-history?outletCode=&itemName=&month=&week=
export const itemHistoryQuerySchema = z.object({
  outletCode: z.string().min(1).max(50), // required
  itemName: z.string().min(1).max(200), // required
  month: monthLabelSchema,
  week: weekLabelSchema,
});

// /api/recommendations?month=&week=&prevWeek=&prevMonth=&limit=&area=&kelompok=&outletCode=&pic=
export const recommendationsQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  prevWeek: weekLabelSchema,
  prevMonth: monthLabelSchema,
  limit: limitSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  outletCode: outletCodeSchema,
  pic: picSchema,
});

// /api/pareto?month=&week=&area=&kelompok=&pic=&parentDim=&childDim=
// FIX (AUDIT7-BE-4): was reading raw url.searchParams.get() with no Zod
// validation — inconsistent with /api/analysis + /api/recommendations.
// parentDim + childDim included for forward-compat with the multi-nesting
// feature (AUDIT7-BE-1 — backend not yet implemented). Strict enum prevents
// arbitrary strings from reaching downstream SQL/JS consumers.
export const paretoQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  pic: picSchema,
  parentDim: z.enum(['item', 'outlet', 'area', 'kelompok', 'pic']).optional(),
  childDim: z.enum(['item', 'outlet', 'area', 'kelompok', 'pic']).optional(),
});

// /api/change-analysis?month=&week=&kelompok=  (CHANGE-1 — lens "Perubahan")
export const changeAnalysisQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/change-analysis/items?month=&week=&kelompok=&outletCode=
export const changeAnalysisItemsQuerySchema = changeAnalysisQuerySchema.extend({
  outletCode: outletCodeSchema,
});

// /api/area-item-heatmap GET query params (BUG-A-01 from orphaned 400b538)
export const heatmapQuerySchema = z.object({
  // FIX (BUGHUNT-A2): free-form month lacked the control-char gate (shared
  // monthLabelSchema has it; this inline field didn't) — see noControlChars.
  month: z.string().min(3).max(50).refine(noControlChars),
  week: weekLabelSchema,
  metric: z.enum(['absNominalDeviasi', 'nominalWaste', 'nominalSusut', 'pctQtyDeviasiToBom', 'recordCount']).optional(),
  itemLimit: z.coerce.number().int().min(5).max(100).optional(),
  mode: z.enum(['pareto80', 'top']).optional(),
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  item: itemNameSchema,
  pic: picSchema,
}).strict();

// /api/item-trend GET query params (TREND-BACKEND — per-item QTY fluctuation
// timeline across ALL periods). `month` + `week` are optional and used only
// for the cache key (the query itself returns ALL periods for the item).
// `metric` selects which QTY to Z-Score on (default: qtyDeviasi).
export const itemTrendQuerySchema = z.object({
  // FIX (BUGHUNT-A2): month + itemName lacked the control-char gate — a
  // control char in either would collide with the real value's cache key
  // after sanitizeKeyPart (see noControlChars export note).
  month: z.string().min(3).max(50).refine(noControlChars).optional(),
  week: weekLabelSchema,
  itemName: z.string().min(1).max(200).refine(noControlChars),
  metric: z.enum(['qtyDeviasi', 'qtyWaste', 'qtySusut', 'qtyTrial']).optional(),
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  pic: picSchema,
}).strict();
