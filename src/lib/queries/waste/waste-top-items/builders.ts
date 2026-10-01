// ============================================================
//  Waste Top Items — pure builders (DEEP-WASTE-1)
//  --------------------------------------------------------
//  SPLIT-0-B: moved verbatim out of waste-top-items.ts. Merges
//  the query round-trip rows into the final Pareto rows (share,
//  cumulative share, sistematik, breakdown cap) — PURE, exported
//  for vitest. Depends on ./sistematik.ts + ./constants.ts +
//  ./types.ts; called by ./query.ts. See ./index.ts for the
//  module doc header.
// ============================================================
import {
  WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT,
  WASTE_TOP_ITEMS_WINDOW_MONTHS,
} from './constants';
import { isSistematikWasteItem } from './sistematik';
import type {
  WasteItemOutletBreakdown,
  WasteItemOutletRawRow,
  WasteItemRawRow,
  WasteTopItemRow,
  WasteTopItemsResult,
} from './types';

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Merge the per-item rows + per-(item, outlet) breakdown rows into the
 * final Pareto rows (share, cumulative share, sistematik, breakdown cap).
 * Pure.
 */
export function buildWasteTopItems(
  itemRows: WasteItemRawRow[],
  breakdownRows: WasteItemOutletRawRow[],
  windowMonths: number = WASTE_TOP_ITEMS_WINDOW_MONTHS,
): WasteTopItemsResult {
  if (itemRows.length === 0) {
    return { items: [], populationTotal: 0, lastMonthKey: null, prevMonthKey: null, windowMonths, quadrant: null };
  }
  const populationTotal = toNum(itemRows[0].populationTotal);
  const byItemBreakdown = new Map<number, WasteItemOutletBreakdown[]>();
  for (const b of breakdownRows) {
    const list = byItemBreakdown.get(b.itemId) ?? [];
    list.push({
      outletCode: b.outletCode,
      outletName: b.outletName,
      area: b.area,
      waste: toNum(b.waste),
      monthsActive: toNum(b.monthsActive),
      shareOfItem: 0,
    });
    byItemBreakdown.set(b.itemId, list);
  }
  let cumulative = 0;
  const items: WasteTopItemRow[] = itemRows.map((r) => {
    const totalWaste = toNum(r.totalWaste);
    const share = populationTotal > 0 ? totalWaste / populationTotal : 0;
    cumulative += share;
    const breakdown = (byItemBreakdown.get(r.itemId) ?? [])
      .sort((a, b) => b.waste - a.waste || a.outletCode.localeCompare(b.outletCode))
      .slice(0, WASTE_TOP_ITEMS_OUTLET_BREAKDOWN_LIMIT)
      .map((b) => ({ ...b, shareOfItem: totalWaste > 0 ? b.waste / totalWaste : 0 }));
    return {
      itemId: r.itemId,
      itemName: r.itemName,
      satuan: r.satuan,
      totalWaste,
      wasteQty: toNum(r.wasteQty),
      outletsActive: toNum(r.outletsActive),
      monthsActive: toNum(r.monthsActive),
      share,
      cumulativeShare: populationTotal > 0 ? cumulative : 0,
      lastMonthWaste: toNum(r.lastMonthWaste),
      prevMonthWaste: toNum(r.prevMonthWaste),
      sistematik: isSistematikWasteItem(toNum(r.monthsActive), toNum(r.outletsActive), windowMonths),
      byOutlet: breakdown,
      // W3 (additive): null default — queryWasteTopItems fills it from the
      // quadrant round trip via buildQuadrant; pure callers keep null.
      quadrant: null,
    };
  });
  return {
    items,
    populationTotal,
    // Filled by the caller (queryWasteTopItems) from the month keys — the
    // raw rows don't carry them (single source: the month-derivation round).
    lastMonthKey: null,
    prevMonthKey: null,
    windowMonths,
    // W3 (additive): null default — filled by queryWasteTopItems from
    // buildQuadrant; pure callers keep null.
    quadrant: null,
  };
}
