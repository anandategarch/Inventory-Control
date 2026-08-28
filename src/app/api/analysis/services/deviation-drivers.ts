// ============================================================
//  Deviation Drivers — Pareto 80% per deviation category
//  Extracted from analysis/route.ts (Phase 3 refactor)
// ============================================================
import type { DeviationDriverItemRow } from '@/lib/queries/dashboard';

interface DeviationDriver {
  item: string;
  qty: number;
  nominal: number;
  sharePct: number;
  cumPct: number;
}
export interface DeviationDriverCategory {
  category: 'waste' | 'susut' | 'trial' | 'residual';
  label: string;
  drivers: DeviationDriver[];
  remainderCount: number;
  remainderPct: number;
}

export function computeDeviationDrivers(
  deviationDriverRows: DeviationDriverItemRow[],
): DeviationDriverCategory[] {
  // FIX (AUDIT8-ROLLBACK-1, Item 16): Cap drivers per category to prevent
  // payload DoS. A category with 1000+ items where each contributes <0.1%
  // would otherwise produce 1000+ driver rows, blowing up payload size +
  // frontend render time. 20 is sufficient — Pareto 80% usually falls within
  // the top 5-10 items; anything beyond 20 is statistically not a "driver".
  const MAX_DRIVERS_PER_CATEGORY = 20;

  const categories = [
    { key: 'waste' as const, label: 'Waste', qtyField: 'wasteQty' as const, nomField: 'wasteNominal' as const },
    { key: 'susut' as const, label: 'Susut', qtyField: 'susutQty' as const, nomField: 'susutNominal' as const },
    { key: 'trial' as const, label: 'Trial', qtyField: 'trialQty' as const, nomField: 'trialNominal' as const },
    { key: 'residual' as const, label: 'Residual', qtyField: 'residualQty' as const, nomField: 'residualNominal' as const },
  ];

  return categories.map(cat => {
    const rows = deviationDriverRows
      .map(r => ({ item: r.itemName, qty: Number(r[cat.qtyField]) || 0, nominal: Number(r[cat.nomField]) || 0 }))
      .filter(r => r.qty > 0);

    rows.sort((a, b) => b.qty - a.qty);

    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    if (totalQty === 0) {
      return { category: cat.key, label: cat.label, drivers: [], remainderCount: 0, remainderPct: 0 };
    }

    let cumPct = 0;
    const drivers: DeviationDriver[] = [];
    for (const r of rows) {
      const sharePct = (r.qty / totalQty) * 100;
      cumPct += sharePct;
      drivers.push({
        item: r.item,
        qty: Number(r.qty.toFixed(2)),
        nominal: Number(r.nominal.toFixed(0)),
        sharePct: Number(sharePct.toFixed(1)),
        cumPct: Number(cumPct.toFixed(1)),
      });
      // FIX (AUDIT8-ROLLBACK-1, Item 16): break on Pareto 80% OR hard cap,
      // whichever comes first.
      if (cumPct >= 80 || drivers.length >= MAX_DRIVERS_PER_CATEGORY) break;
    }

    return {
      category: cat.key,
      label: cat.label,
      drivers,
      remainderCount: rows.length - drivers.length,
      remainderPct: Number(Math.max(0, 100 - cumPct).toFixed(1)),
    };
  });
}
