// ============================================================
//  Route-specific schemas — peer-comparison family (±10% band).
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema per consumer route:
//  /api/peer-comparison (+/items, /trend, /top-items),
//  /api/peer-track-record (DEEP-RESTO-1 — rank in band),
//  /api/benchmark-opportunity (ANA-1-E — PEER tab).
// ============================================================
import { z } from 'zod';
import {
  monthLabelSchema,
  weekLabelSchema,
  kelompokSchema,
  limitSchema,
} from './shared';

// /api/peer-comparison?outletCode=&month=&week=&mode=&limit=&kelompok=
// FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only —
// the focus outlet is always queried by outletCode regardless.
export const peerComparisonQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  mode: z.enum(['week', 'month']).optional(),
  limit: limitSchema,
  kelompok: kelompokSchema,
});

// /api/peer-comparison/items?outletCode=&month=&week=&kelompok=
export const peerComparisonItemsQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/peer-comparison/trend?outletCode=&month=&week=&kelompok=
export const peerComparisonTrendQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/peer-comparison/top-items?outletCode=&month=&week=&kelompok=
// PEERTOP-1 — per-peer top-N items + cross-peer union. topN/limit/mode are
// parsed + clamped manually in the route (same style as the items route's
// topItems: bogus values must not reach the cache key, so they never enter
// the zod schema).
export const peerTopItemsQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/peer-track-record?outletCode=&month=&week=&kelompok=
// DEEP-RESTO-1: per-month rank of the outlet inside its dynamic ±10%
// sales band (net deviation + total loss) over the same window.
// kelompok scopes the PEER set only — the focus outlet is always included.
export const peerTrackRecordQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/benchmark-opportunity?month=&week=&kelompok=
// ANA-1-E ("Peluang Perbaikan (Rp)" — Rp gap vs AREA MEDIAN loss, PEER tab).
// Same filter scope as the peer-comparison family (kelompok scopes the
// outlet set; no target outlet — the metric is network-wide per area).
export const benchmarkOpportunityQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});
