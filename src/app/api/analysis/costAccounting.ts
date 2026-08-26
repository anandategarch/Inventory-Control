// ============================================================
//  ANALYSIS API — Cost Accounting Analysis
//  5 new features:
//  1. Cost Impact Decomposition (waste/susut/trial/residual)
//  2. Pareto ABC Analysis (vital few vs trivial many)
//  3. Outlet Efficiency Matrix (Sales vs Loss/Sales scatter)
//  4. Cost per Rp 1000 Sales (simple benchmark metric)
//  5. Net Cost Impact Trend (Loss - Surplus over time)
// ============================================================
import type { Client, InValue } from '@libsql/client';
import type { AggRow, Totals } from './types';

// ------------------------------------------------------------
//  Types
// ------------------------------------------------------------

export interface CostImpactDecomposition {
  wasteCost: number;
  susutCost: number;
  trialCost: number;
  residualCost: number;
  totalCost: number;
  /** Each as % of totalCost */
  wastePct: number;
  susutPct: number;
  trialPct: number;
  residualPct: number;
  /** Each as % of sales */
  wasteToSales: number;
  susutToSales: number;
  trialToSales: number;
  residualToSales: number;
  totalCostToSales: number;
}

export interface ParetoItem {
  rank: number;
  itemName: string;
  outletCode: string;
  absNominal: number;
  cumulative: number;
  cumulativePct: number;
  classification: 'A' | 'B' | 'C';
}

export interface ParetoAnalysis {
  items: ParetoItem[];
  classACount: number;
  classACost: number;
  classAPct: number; // % of total cost
  classBCount: number;
  classBCost: number;
  classBPct: number;
  classCCount: number;
  classCCost: number;
  classCPct: number;
}

export interface OutletEfficiencyPoint {
  outletCode: string;
  outletName: string;
  area: string;
  sales: number;
  lossToSales: number; // Y axis
  totalAbsNominal: number;
  direction: string;
  quadrant: 'STAR' | 'STABLE' | 'ATTENTION' | 'PROBLEM';
}

export interface CostPerThousand {
  costPerThousand: number;
  totalDeviasi: number;
  totalSales: number;
  /** Per-outlet breakdown */
  byOutlet: Array<{
    outletCode: string;
    outletName: string;
    area: string;
    costPerThousand: number;
    sales: number;
    deviasi: number;
  }>;
}

export interface NetCostTrendPoint {
  weekLabel: string;
  loss: number;
  surplus: number;
  netCost: number;
  netCostRatio: number; // netCost / sales × 100
  sales: number;
}

// ------------------------------------------------------------
//  1. Cost Impact Decomposition
// ------------------------------------------------------------

export function computeCostImpactDecomposition(
  rows: AggRow[],
  totals: Totals
): CostImpactDecomposition {
  const wasteCost = rows.reduce((s, r) => s + (r.nominalWaste || 0), 0);
  const susutCost = rows.reduce((s, r) => s + (r.nominalSusut || 0), 0);
  const trialCost = rows.reduce((s, r) => s + (r.nominalTrial || 0), 0);
  // FIX P0: residual cost = sum of |residualQty| × avgPrice (not abs-of-sum)
  const residualCost = rows.reduce((s, r) => s + Math.abs(r.residualQty || 0), 0)
    * (totals.nomDeviasiTotal > 0 && totals.qtyDeviasiTotal > 0
      ? totals.nomDeviasiTotal / totals.qtyDeviasiTotal
      : 0);
  const totalCost = totals.nomDeviasiTotal;
  const sales = totals.totalSales;

  return {
    wasteCost,
    susutCost,
    trialCost,
    residualCost,
    totalCost,
    wastePct: totalCost > 0 ? wasteCost / totalCost : 0,
    susutPct: totalCost > 0 ? susutCost / totalCost : 0,
    trialPct: totalCost > 0 ? trialCost / totalCost : 0,
    residualPct: totalCost > 0 ? residualCost / totalCost : 0,
    wasteToSales: sales > 0 ? wasteCost / sales : 0,
    susutToSales: sales > 0 ? susutCost / sales : 0,
    trialToSales: sales > 0 ? trialCost / sales : 0,
    residualToSales: sales > 0 ? residualCost / sales : 0,
    totalCostToSales: sales > 0 ? totalCost / sales : 0,
  };
}

// ------------------------------------------------------------
//  2. Pareto ABC Analysis
// ------------------------------------------------------------

export function computeParetoAnalysis(rows: AggRow[]): ParetoAnalysis {
  const items = [...rows]
    .map((r) => ({
      itemName: r.itemName,
      outletCode: r.outletCode,
      absNominal: Math.abs(r.nominalDeviasi || 0),
    }))
    .sort((a, b) => b.absNominal - a.absNominal);

  const grandTotal = items.reduce((s, i) => s + i.absNominal, 0);
  let cumulative = 0;

  const paretoItems: ParetoItem[] = items.map((item, idx) => {
    cumulative += item.absNominal;
    const cumulativePct = grandTotal > 0 ? (cumulative / grandTotal) * 100 : 0;
    let classification: 'A' | 'B' | 'C' = 'C';
    if (cumulativePct <= 70) classification = 'A';
    else if (cumulativePct <= 90) classification = 'B';
    return {
      rank: idx + 1,
      itemName: item.itemName,
      outletCode: item.outletCode,
      absNominal: item.absNominal,
      cumulative,
      cumulativePct,
      classification,
    };
  });

  const classA = paretoItems.filter((i) => i.classification === 'A');
  const classB = paretoItems.filter((i) => i.classification === 'B');
  const classC = paretoItems.filter((i) => i.classification === 'C');

  return {
    items: paretoItems.slice(0, 30), // top 30 for UI
    classACount: classA.length,
    classACost: classA.reduce((s, i) => s + i.absNominal, 0),
    classAPct: grandTotal > 0 ? (classA.reduce((s, i) => s + i.absNominal, 0) / grandTotal) * 100 : 0,
    classBCount: classB.length,
    classBCost: classB.reduce((s, i) => s + i.absNominal, 0),
    classBPct: grandTotal > 0 ? (classB.reduce((s, i) => s + i.absNominal, 0) / grandTotal) * 100 : 0,
    classCCount: classC.length,
    classCCost: classC.reduce((s, i) => s + i.absNominal, 0),
    classCPct: grandTotal > 0 ? (classC.reduce((s, i) => s + i.absNominal, 0) / grandTotal) * 100 : 0,
  };
}

// ------------------------------------------------------------
//  3. Outlet Efficiency Matrix
// ------------------------------------------------------------

export interface OutletAggLike {
  sales: number;
  absNominal: number;
  direction: string | null;
  signedQtyDev: number;
}

export function computeOutletEfficiencyMatrix(
  byOutlet: Map<string, OutletAggLike>,
  rows: AggRow[]
): OutletEfficiencyPoint[] {
  const result: OutletEfficiencyPoint[] = [];

  // P2-4: Dynamic thresholds — replace hardcoded 500M / 0.05 with
  // percentile-based (median) values computed from the actual data.
  // Falls back to the previous hardcoded values when the dataset is too
  // small (<=2 points) to compute a meaningful median.
  const points: Array<{ sales: number; lossToSales: number; totalAbsNominal: number; code: string; v: OutletAggLike }> = [];
  for (const [code, v] of byOutlet) {
    const sales = v.sales;
    // FIX P0-1: direction from signedQtyDev (QTY-based), loss from signedQtyDev > 0
    const totalLoss = v.signedQtyDev > 0 ? v.absNominal : 0;
    const lossToSales = sales > 0 ? totalLoss / sales : 0;
    points.push({ sales, lossToSales, totalAbsNominal: v.absNominal, code, v });
  }

  const salesValues = points.map((p) => p.sales).sort((a, b) => a - b);
  const lossValues = points.map((p) => p.lossToSales).sort((a, b) => a - b);
  const medianSales = salesValues.length > 2
    ? salesValues[Math.floor(salesValues.length / 2)]
    : 500_000_000; // hardcoded fallback when too few outlets
  const medianLoss = lossValues.length > 2
    ? lossValues[Math.floor(lossValues.length / 2)]
    : 0.05; // hardcoded fallback when too few outlets

  for (const p of points) {
    const firstRow = rows.find((r) => r.outletCode === p.code);

    // Classify quadrant — P2-4: use median-based dynamic thresholds.
    let quadrant: OutletEfficiencyPoint['quadrant'] = 'STABLE';
    const isHighSales = p.sales > medianSales;
    const isHighLoss = p.lossToSales > medianLoss;

    if (isHighSales && !isHighLoss) quadrant = 'STAR';
    else if (!isHighSales && !isHighLoss) quadrant = 'STABLE';
    else if (isHighSales && isHighLoss) quadrant = 'ATTENTION';
    else if (!isHighSales && isHighLoss) quadrant = 'PROBLEM';

    result.push({
      outletCode: p.code,
      outletName: firstRow?.outletName || p.code,
      area: firstRow?.area || '',
      sales: p.sales,
      lossToSales: p.lossToSales,
      totalAbsNominal: p.totalAbsNominal,
      direction: p.v.direction || 'NEUTRAL',
      quadrant,
    });
  }

  return result.sort((a, b) => b.totalAbsNominal - a.totalAbsNominal);
}

// ------------------------------------------------------------
//  4. Cost per Rp 1000 Sales
// ------------------------------------------------------------

export function computeCostPerThousand(
  totals: Totals,
  byOutlet: Map<string, OutletAggLike>,
  rows: AggRow[]
): CostPerThousand {
  const totalDeviasi = totals.nomDeviasiTotal;
  const totalSales = totals.totalSales;

  const byOutletList = [...byOutlet.entries()]
    .map(([code, v]) => {
      const firstRow = rows.find((r) => r.outletCode === code);
      const deviasi = v.absNominal;
      const sales = v.sales;
      return {
        outletCode: code,
        outletName: firstRow?.outletName || code,
        area: firstRow?.area || '',
        costPerThousand: sales > 0 ? (deviasi / sales) * 1000 : 0,
        sales,
        deviasi,
      };
    })
    .sort((a, b) => b.costPerThousand - a.costPerThousand);

  return {
    costPerThousand: totalSales > 0 ? (totalDeviasi / totalSales) * 1000 : 0,
    totalDeviasi,
    totalSales,
    byOutlet: byOutletList.slice(0, 15),
  };
}

// ------------------------------------------------------------
//  5. Net Cost Impact Trend
// ------------------------------------------------------------

export async function computeNetCostTrend(
  client: Client,
  trendWhere: string,
  args: InValue[]
): Promise<NetCostTrendPoint[]> {
  try {
    // Query per-period: SUM(loss), SUM(surplus), sales
    const sql = `
      SELECT
        r.monthLabel AS monthLabel,
        r.weekLabel AS weekLabel,
        SUM(CASE WHEN r.nominalDeviasi > 0 THEN ABS(r.nominalDeviasi) ELSE 0 END) AS loss,
        SUM(CASE WHEN r.nominalDeviasi < 0 THEN ABS(r.nominalDeviasi) ELSE 0 END) AS surplus,
        SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS absNominal
      FROM InventoryRecord r
      JOIN Outlet o ON r.outletId = o.id
      ${trendWhere}
      GROUP BY r.monthLabel, r.weekLabel
      ORDER BY
        CAST(SUBSTR(r.monthLabel, LENGTH(r.monthLabel) - 3) AS INTEGER) * 100 +
        CASE
          WHEN r.monthLabel LIKE 'Januari%' THEN 1
          WHEN r.monthLabel LIKE 'Februari%' THEN 2
          WHEN r.monthLabel LIKE 'Maret%' THEN 3
          WHEN r.monthLabel LIKE 'April%' THEN 4
          WHEN r.monthLabel LIKE 'Mei%' THEN 5
          WHEN r.monthLabel LIKE 'Juni%' THEN 6
          WHEN r.monthLabel LIKE 'Juli%' THEN 7
          WHEN r.monthLabel LIKE 'Agustus%' THEN 8
          WHEN r.monthLabel LIKE 'September%' THEN 9
          WHEN r.monthLabel LIKE 'Oktober%' THEN 10
          WHEN r.monthLabel LIKE 'November%' THEN 11
          WHEN r.monthLabel LIKE 'Desember%' THEN 12
          ELSE 99
        END,
        CASE
          WHEN r.weekLabel LIKE '%1' AND r.weekLabel NOT LIKE '%10%' AND r.weekLabel NOT LIKE '%11%' AND r.weekLabel NOT LIKE '%12%' THEN 1
          WHEN r.weekLabel LIKE '%2' AND r.weekLabel NOT LIKE '%12%' AND r.weekLabel NOT LIKE '%20%' AND r.weekLabel NOT LIKE '%21%' THEN 2
          WHEN r.weekLabel LIKE '%3' AND r.weekLabel NOT LIKE '%13%' AND r.weekLabel NOT LIKE '%23%' AND r.weekLabel NOT LIKE '%30%' THEN 3
          WHEN r.weekLabel LIKE '%4' AND r.weekLabel NOT LIKE '%14%' AND r.weekLabel NOT LIKE '%24%' AND r.weekLabel NOT LIKE '%34%' THEN 4
          WHEN r.weekLabel LIKE '%5' AND r.weekLabel NOT LIKE '%15%' AND r.weekLabel NOT LIKE '%25%' THEN 5
          ELSE 99
        END
    `;

    const res = await client.execute({ sql, args });

    // Sales per period (MAX per outlet, then SUM)
    const salesSql = `
      SELECT
        r.monthLabel AS monthLabel,
        r.weekLabel AS weekLabel,
        MAX(r.nominalSales) AS sales
      FROM InventoryRecord r
      JOIN Outlet o ON r.outletId = o.id
      ${trendWhere}
      GROUP BY r.monthLabel, r.weekLabel, r.outletId
    `;
    const salesRes = await client.execute({ sql: salesSql, args });
    const salesByPeriod = new Map<string, number>();
    for (const s of salesRes.rows as Array<Record<string, unknown>>) {
      const key = `${s.monthLabel}|${s.weekLabel}`;
      salesByPeriod.set(key, (salesByPeriod.get(key) || 0) + (Number(s.sales) || 0));
    }

    return (res.rows as Array<Record<string, unknown>>).map((r) => {
      const loss = Number(r.loss) || 0;
      const surplus = Number(r.surplus) || 0;
      const netCost = loss - surplus;
      const key = `${r.monthLabel}|${r.weekLabel}`;
      const sales = salesByPeriod.get(key) || 0;
      return {
        weekLabel: `${r.weekLabel} ${String(r.monthLabel || '').split(' ')[0]?.slice(0, 3) || ''}`,
        loss,
        surplus,
        netCost,
        netCostRatio: sales > 0 ? (netCost / sales) * 100 : 0,
        sales,
      };
    });
  } catch (e) {
    console.error('[analysis] Net cost trend failed:', e);
    return [];
  }
}
