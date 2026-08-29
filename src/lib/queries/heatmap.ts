// ============================================================
//  Area × Item Heatmap Query
//  --------------------------------------------------------
//  Returns a matrix of Area (rows) × Item (columns) with
//  aggregated metric values for heatmap visualization.
//
//  Item selection:
//  - mode='top'      → top N items by total metric value (legacy)
//  - mode='pareto80' → items contributing to 80% of total magnitude (default)
//
//  Each cell returns BOTH nominal value AND raw quantities:
//    qtyBom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial
//  so the drill-down can show real quantities without an extra query.
//
//  Metric options (drives the heat color + cell value):
//  - 'absNominalDeviasi' (default) — total deviation magnitude
//  - 'nominalWaste' — waste amount
//  - 'nominalSusut' — shrinkage amount
//  - 'pctQtyDeviasiToBom' — avg deviation % to BOM
//  - 'recordCount' — number of deviating records
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

export type HeatmapMetric =
  | 'absNominalDeviasi'
  | 'nominalWaste'
  | 'nominalSusut'
  | 'pctQtyDeviasiToBom'
  | 'recordCount';

export type ItemSelectMode = 'top' | 'pareto80';

export interface HeatmapCell {
  area: string;
  itemName: string;
  value: number;
  recordCount: number;
  // Raw quantity aggregates (always ABS magnitude) for drill-down display
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  // Nominal aggregates (ABS magnitude) for drill-down display
  nominalDeviasi: number;
  nominalLossSurplus: number;
}

export interface HeatmapResult {
  areas: string[];
  items: string[];
  cells: HeatmapCell[];
  metric: HeatmapMetric;
  maxValue: number;
  itemSelectMode: ItemSelectMode;
  paretoInfo: {
    totalItems: number;
    selectedItems: number;
    cumulativePct: number;
    totalMagnitude: number;
  };
}

const METRIC_SQL: Record<HeatmapMetric, Prisma.Sql> = {
  absNominalDeviasi: Prisma.sql`COALESCE(SUM(ir."absNominalDeviasi"), 0)`,
  nominalWaste: Prisma.sql`COALESCE(SUM(ABS(ir."nominalWaste")), 0)`,
  nominalSusut: Prisma.sql`COALESCE(SUM(ABS(ir."nominalSusut")), 0)`,
  pctQtyDeviasiToBom: Prisma.sql`COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")), 0)`,
  recordCount: Prisma.sql`CAST(COUNT(*) AS FLOAT)`,
};

export async function queryAreaItemHeatmap(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  metric: HeatmapMetric = 'absNominalDeviasi',
  itemLimit: number = 20,
  mode: ItemSelectMode = 'pareto80',
): Promise<HeatmapResult> {
  const f = buildSqlFilters(filters);
  const metricExpr = METRIC_SQL[metric];

  // Step 1: Get ALL items with their total metric value (for Pareto selection)
  // For 'pctQtyDeviasiToBom' and 'recordCount', Pareto doesn't make semantic sense
  // (they're averages/counts, not magnitudes). Fall back to 'top' mode for those.
  const effectiveMode: ItemSelectMode =
    mode === 'pareto80' && (metric === 'pctQtyDeviasiToBom' || metric === 'recordCount')
      ? 'top'
      : mode;

  const allItemsRows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string; totalValue: number }[]>`
    SELECT i.name as "itemName", ${metricExpr} as "totalValue"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      ${f}
    GROUP BY i.name
    ORDER BY "totalValue" DESC
  `);

  if (allItemsRows.length === 0) {
    return {
      areas: [], items: [], cells: [], metric, maxValue: 0,
      itemSelectMode: effectiveMode,
      paretoInfo: { totalItems: 0, selectedItems: 0, cumulativePct: 0, totalMagnitude: 0 },
    };
  }

  // Step 2: Select items — Pareto 80% or top N
  let selectedItems: string[];
  let paretoInfo: HeatmapResult['paretoInfo'];

  if (effectiveMode === 'pareto80') {
    const totalMagnitude = allItemsRows.reduce((s, r) => s + Math.abs(Number(r.totalValue)), 0);
    if (totalMagnitude === 0) {
      selectedItems = allItemsRows.slice(0, itemLimit).map((r) => r.itemName);
      paretoInfo = { totalItems: allItemsRows.length, selectedItems: selectedItems.length, cumulativePct: 100, totalMagnitude: 0 };
    } else {
      let cumPct = 0;
      const picked: string[] = [];
      for (const r of allItemsRows) {
        if (picked.length >= itemLimit) break; // cap at itemLimit for readability
        const share = (Math.abs(Number(r.totalValue)) / totalMagnitude) * 100;
        cumPct += share;
        picked.push(r.itemName);
        if (cumPct >= 80) break; // Pareto threshold reached
      }
      selectedItems = picked;
      paretoInfo = {
        totalItems: allItemsRows.length,
        selectedItems: picked.length,
        cumulativePct: Number(cumPct.toFixed(1)),
        totalMagnitude,
      };
    }
  } else {
    selectedItems = allItemsRows.slice(0, itemLimit).map((r) => r.itemName);
    const totalMagnitude = allItemsRows.reduce((s, r) => s + Math.abs(Number(r.totalValue)), 0);
    const selectedMag = allItemsRows.slice(0, selectedItems.length).reduce((s, r) => s + Math.abs(Number(r.totalValue)), 0);
    paretoInfo = {
      totalItems: allItemsRows.length,
      selectedItems: selectedItems.length,
      cumulativePct: totalMagnitude > 0 ? Number(((selectedMag / totalMagnitude) * 100).toFixed(1)) : 0,
      totalMagnitude,
    };
  }

  if (selectedItems.length === 0) {
    return {
      areas: [], items: [], cells: [], metric, maxValue: 0,
      itemSelectMode: effectiveMode, paretoInfo,
    };
  }

  // Step 3: Fetch the area × item matrix for selected items — with full qty + nominal aggregates
  const itemNames = Prisma.join(selectedItems);
  const cells = await withStatementTimeout((tx) => tx.$queryRaw<HeatmapCell[]>`
    SELECT
      ir.area,
      i.name as "itemName",
      ${metricExpr} as value,
      CAST(COUNT(*) AS INTEGER) as "recordCount",
      COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
      COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) as "qtyDeviasi",
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "qtyWaste",
      COALESCE(SUM(ABS(ir."qtySusut")), 0) as "qtySusut",
      COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "qtyTrial",
      COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) as "nominalDeviasi",
      COALESCE(SUM(ABS(ir."nominalLossSurplus")), 0) as "nominalLossSurplus"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND i.name IN (${itemNames})
      ${f}
    GROUP BY ir.area, i.name
    ORDER BY ir.area, value DESC
  `);

  // Step 4: Extract distinct areas (preserve order from cells)
  const areaSet = new Set<string>();
  for (const c of cells) areaSet.add(c.area);
  const areas = [...areaSet].sort();

  // Step 5: Compute max value for color scaling
  const maxValue = cells.reduce((max, c) => Math.max(max, c.value), 0);

  return {
    areas,
    items: selectedItems,
    cells,
    metric,
    maxValue,
    itemSelectMode: effectiveMode,
    paretoInfo,
  };
}

// ============================================================
//  Cell Detail — drill-down per outlet for a specific area+item
//  Returns one row per outlet × akunPenyesuaian with full qty + nominal
// ============================================================
export interface HeatmapCellDetailRow {
  outletCode: string;
  outletName: string;
  area: string;
  akunPenyesuaian: string;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
  pctQtyDeviasiToBom: number;
  recordCount: number;
}

export async function queryHeatmapCellDetail(
  week: string,
  month: string,
  filters: SqlFilterOpts,
  areaName: string,
  itemName: string,
): Promise<HeatmapCellDetailRow[]> {
  const f = buildSqlFilters(filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<HeatmapCellDetailRow[]>`
    SELECT
      o.code as "outletCode",
      o.name as "outletName",
      ir.area,
      ir."akunPenyesuaian",
      COALESCE(SUM(ABS(ir."qtyBom")), 0) as "qtyBom",
      COALESCE(SUM(ABS(ir."qtyDeviasi")), 0) as "qtyDeviasi",
      COALESCE(SUM(ABS(ir."qtyWaste")), 0) as "qtyWaste",
      COALESCE(SUM(ABS(ir."qtySusut")), 0) as "qtySusut",
      COALESCE(SUM(ABS(ir."qtyTrial")), 0) as "qtyTrial",
      COALESCE(SUM(ABS(ir."nominalDeviasi")), 0) as "nominalDeviasi",
      COALESCE(SUM(ABS(ir."nominalLossSurplus")), 0) as "nominalLossSurplus",
      COALESCE(AVG(ABS(ir."pctQtyDeviasiToBom")), 0) as "pctQtyDeviasiToBom",
      CAST(COUNT(*) AS INTEGER) as "recordCount"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "Outlet" o ON ir."outletId" = o.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND ir.area = ${areaName}
      AND i.name = ${itemName}
      ${f}
    GROUP BY o.code, o.name, ir.area, ir."akunPenyesuaian"
    ORDER BY "nominalDeviasi" DESC
  `);
  return rows;
}
