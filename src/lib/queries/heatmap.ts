// ============================================================
//  Area × Item Heatmap Query
//  --------------------------------------------------------
//  Returns a matrix of Area (rows) × Item (columns) with
//  aggregated metric values for heatmap visualization.
//
//  Default: Top 20 items by total absNominalDeviasi (readable grid).
//  Configurable via `itemLimit` param (up to 109 items).
//
//  Metric options:
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

export interface HeatmapCell {
  area: string;
  itemName: string;
  value: number;
  recordCount: number;
}

export interface HeatmapResult {
  areas: string[];
  items: string[];
  cells: HeatmapCell[];
  metric: HeatmapMetric;
  maxValue: number;
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
): Promise<HeatmapResult> {
  const f = buildSqlFilters(filters);
  const metricExpr = METRIC_SQL[metric];

  // Step 1: Find the top N items by total metric value (across all areas)
  // This ensures the heatmap shows the most impactful items.
  const topItemsRows = await withStatementTimeout((tx) => tx.$queryRaw<{ itemName: string }[]>`
    SELECT i.name as "itemName"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      ${f}
    GROUP BY i.name
    ORDER BY ${metricExpr} DESC
    LIMIT ${itemLimit}
  `);
  const topItems = topItemsRows.map((r) => r.itemName);

  if (topItems.length === 0) {
    return { areas: [], items: [], cells: [], metric, maxValue: 0 };
  }

  // Step 2: Fetch the area × item matrix for the top items
  // Use a parameterized IN clause via Prisma.join
  const itemNames = Prisma.join(topItems);
  const cells = await withStatementTimeout((tx) => tx.$queryRaw<HeatmapCell[]>`
    SELECT
      ir.area,
      i.name as "itemName",
      ${metricExpr} as value,
      CAST(COUNT(*) AS INTEGER) as "recordCount"
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month}
      AND ir."weekLabel" = ${week}
      AND i.name IN (${itemNames})
      ${f}
    GROUP BY ir.area, i.name
    ORDER BY ir.area, value DESC
  `);

  // Step 3: Extract distinct areas (preserve order from cells)
  const areaSet = new Set<string>();
  for (const c of cells) areaSet.add(c.area);
  const areas = [...areaSet].sort();

  // Step 4: Compute max value for color scaling
  const maxValue = cells.reduce((max, c) => Math.max(max, c.value), 0);

  return {
    areas,
    items: topItems,
    cells,
    metric,
    maxValue,
  };
}
