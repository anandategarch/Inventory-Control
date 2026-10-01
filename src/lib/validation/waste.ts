// ============================================================
//  Route-specific schemas — waste family (DEEP-WASTE) + the
//  multi-month window series.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema per consumer route:
//  /api/waste-series, /api/waste-top-items (DEEP-WASTE-1),
//  /api/waste-peer-zscore (DEEP-WASTE-2),
//  /api/outlet-monthly-series (DEEP-RESTO-1 window sibling —
//  same multi-month same-week window semantics as waste-series).
// ============================================================
import { z } from 'zod';
import {
  monthLabelSchema,
  weekLabelSchema,
  areaSchema,
  kelompokSchema,
  picSchema,
  outletCodeSchema,
} from './shared';

// /api/outlet-monthly-series?outletCode=&month=&week=
// DEEP-RESTO-1: multi-month same-week series for ONE outlet (sales MoM,
// dev/BOM, loss/surplus, net cost ratio, recurrence-style abnormal flag).
// `month` resolves the running month (window upper bound, inclusive).
export const outletMonthlySeriesQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
});

// /api/waste-series?month=&week=&area=&kelompok=&pic=&outletCode=
// DEEP-WASTE-1: multi-month SAME-week waste network view (per-outlet
// monthly waste/susut/trial/residual/loss + waste/sales + the 4 network
// detectors). Same filter scope as /api/pareto (area/kelompok/pic); the
// optional outletCode scopes the view to ONE outlet (the Resto tab's
// Profil Waste card). `month` resolves the running month (window upper
// bound, inclusive).
export const wasteSeriesQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  pic: picSchema,
  outletCode: outletCodeSchema,
});

// /api/waste-top-items?month=&week=&area=&kelompok=&pic=&outletCode=&limit=&metric=
// DEEP-WASTE-1: Pareto of items by ΣABS nominalWaste over the same
// window + sistematik columns (#outlet/#bulan) + per-outlet breakdown.
// The optional outletCode scopes the view to ONE outlet (global outlet
// filter parity with waste-series). limit is clamped in the route
// (1..50, default 20) — bogus values must not reach the cache key (same
// style as peer-comparison/top-items).
//
// W11 (Paritas Susut & Trial) — ADDITIVE param: `metric` selects the
// top-N ORDERING metric ('waste' | 'susut' | 'trial', default 'waste').
// The response ALWAYS carries all three metric aggregates + the W/S/T
// fingerprint regardless of the ordering metric (parity context);
// `sistematik` stays WASTE-semantic under every metric (generalizing it
// is out of scope — documented in the query module).
export const wasteTopItemsQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  pic: picSchema,
  outletCode: outletCodeSchema,
  metric: z.enum(['waste', 'susut', 'trial']).default('waste'),
});

// /api/waste-peer-zscore?outletCode=&month=&week=&kelompok=
// DEEP-WASTE-2: per-month waste/sales + rank + z-score of ONE outlet
// inside its dynamic ±10% sales band over the same window.
// kelompok scopes the PEER set only — the focus outlet is always included.
export const wastePeerZScoreQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});
