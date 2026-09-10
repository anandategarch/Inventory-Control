// ============================================================
//  Analysis Engine — Shared Types
// ============================================================
//  OPTIMIZE-ANALYSIS: RecWithRels slimmed to only the fields the engine
//  actually reads. Callers may pass richer objects (e.g. Prisma `include`
//  results from export-report route) — structurally compatible.
//
//  Field list verified by grepping every `curr.*` / `prev.*` / `rec.*`
//  access in patternEngine.ts plus fetch-records.ts's select shape.
// ============================================================
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';

/**
 * Full record shape (still used by callers that do `include: { outlet, item, week }`
 * — e.g. export-report route, which needs all columns for the Word export).
 */
export type RecWithRelsFull = InventoryRecord & { outlet: Outlet; item: Item; week: Week };

/**
 * Slim record shape — only fields patternEngine + downstream
 * computations (variance / health-ranking / historical) read.
 * Switching the analysis route's findMany from `include` to `select` with
 * this exact field set avoids transferring ~10 unused columns per row
 * (id, sourceFileId, weekId, status, satuan, qtyCom, nominalWaste/Susut/Trial,
 * avgPrice, toleranceRaw, pct*ToBom (except pctQtyDeviasiToBom), residualNominal,
 * bulan, bulan2, weekLabel, monthLabel, createdAt) across ~35K rows.
 */
export type RecWithRels = {
  // Natural-key components (used for prev-record + historical-stats lookup)
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;

  // Raw qty columns read by patternEngine + post-process consumers
  qtyBom: number | null;
  qtyDeviasi: number | null;
  qtyWaste: number | null;
  qtySusut: number | null;
  qtyTrial: number | null;
  qtyLossSurplus: number | null;

  // Nominal columns
  nominalDeviasi: number | null;
  nominalLossSurplus: number | null;
  nominalSales: number | null; // denormalized outlet-level (used by salesGrowth + dedupSalesByOutlet)

  // Pre-computed abs values
  absNominalDeviasi: number | null;
  absQtyDeviasi: number | null;
  absNominalLossSurplus: number | null;
  absQtyLossSurplus: number | null;

  // Pre-computed ratios / metadata
  pctQtyDeviasiToBom: number | null;
  tolerancePct: number | null;
  direction: string | null;
  residualQty: number | null;
  residualRatio: number | null;

  // Denormalized area (used by pattern detection / variance / historical)
  area: string;

  // Relations — only the fields actually accessed
  outlet: { code: string; name: string; area: string };
  item: { name: string };
};
