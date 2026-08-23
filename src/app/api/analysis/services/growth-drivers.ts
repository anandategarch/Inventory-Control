// ============================================================
//  Growth Drivers — Pareto 80% analysis per metric
//  Extracted from analysis/route.ts (Phase 3 refactor)
// ============================================================
type RecWithRels = import('@/engine/analysis/types').RecWithRels;

interface DriverEntry {
  item: string;
  delta: number;
  pct: number;
  cumPct: number;
  sharePct: number;
}
interface DriverResult {
  drivers: DriverEntry[];
  remainderCount: number;
  remainderPct: number;
}
export interface GrowthDriverMetric {
  metric: string;
  label: string;
  groupBy: 'outlet' | 'item';
  up: DriverResult;
  down: DriverResult;
}

export function computeGrowthDrivers(
  currentRecs: RecWithRels[],
  prevRecs: RecWithRels[],
): GrowthDriverMetric[] {
  const metrics = [
    { key: 'sales', field: 'nominalSales' as const, label: 'Sales', groupBy: 'outlet' as const },
    { key: 'bom', field: 'qtyBom' as const, label: 'BOM', groupBy: 'item' as const },
    { key: 'qtyDeviasi', field: 'qtyDeviasi' as const, label: 'QTY Deviasi', groupBy: 'item' as const },
    { key: 'nominalDeviasi', field: 'nominalDeviasi' as const, label: 'Nominal Deviasi', groupBy: 'item' as const },
  ];

  return metrics.map(metric => {
    const currByKey = new Map<string, number>();
    const prevByKey = new Map<string, number>();

    const getName = (r: RecWithRels): string => {
      if (metric.groupBy === 'outlet') {
        return r.outlet?.name || r.outlet?.code || `Outlet ${r.outletId}`;
      }
      return r.item?.name || `Item ${r.itemId}`;
    };

    for (const r of currentRecs) {
      const name = getName(r);
      const val = r[metric.field];
      const useSigned = metric.key === 'qtyDeviasi';
      if (val != null) currByKey.set(name, (currByKey.get(name) ?? 0) + (useSigned ? val : Math.abs(val)));
    }
    for (const r of prevRecs) {
      const name = getName(r);
      const val = r[metric.field];
      const useSigned = metric.key === 'qtyDeviasi';
      if (val != null) prevByKey.set(name, (prevByKey.get(name) ?? 0) + (useSigned ? val : Math.abs(val)));
    }

    const allKeys = new Set([...currByKey.keys(), ...prevByKey.keys()]);
    const positive: Array<{ item: string; delta: number; pct: number }> = [];
    const negative: Array<{ item: string; delta: number; pct: number }> = [];

    const deltaThreshold = metric.key === 'sales' || metric.key === 'nominalDeviasi' ? 1000 : 0.01;
    for (const key of allKeys) {
      const curr = currByKey.get(key) ?? 0;
      const prev = prevByKey.get(key) ?? 0;
      const delta = curr - prev;
      if (Math.abs(delta) < deltaThreshold) continue;
      const pct = prev > 0 ? delta / prev : 0;
      if (delta > 0) positive.push({ item: key, delta, pct });
      else negative.push({ item: key, delta, pct });
    }

    const computePareto = (arr: Array<{ item: string; delta: number; pct: number }>): DriverResult => {
      arr.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const totalDelta = arr.reduce((s, d) => s + Math.abs(d.delta), 0);
      if (totalDelta === 0) return { drivers: [], remainderCount: 0, remainderPct: 0 };
      let cumPct = 0;
      const drivers: DriverEntry[] = [];
      const MAX_DRIVERS = 20;
      for (const d of arr) {
        if (drivers.length >= MAX_DRIVERS) break;
        const sharePct = (Math.abs(d.delta) / totalDelta) * 100;
        cumPct += sharePct;
        drivers.push({ ...d, cumPct: Number(cumPct.toFixed(1)), sharePct: Number(sharePct.toFixed(1)) });
        if (cumPct >= 80) break;
      }
      return {
        drivers,
        remainderCount: arr.length - drivers.length,
        remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)),
      };
    };

    return {
      metric: metric.key,
      label: metric.label,
      groupBy: metric.groupBy,
      up: computePareto(positive),
      down: computePareto(negative),
    };
  });
}
