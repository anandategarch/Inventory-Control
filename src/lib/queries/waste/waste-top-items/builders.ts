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
  WasteMetric,
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
 *
 * W11 (Paritas Susut & Trial) — additive optional `metric`:
 *   - the per-item susut/trial aggregates + their shares/cumulatives are
 *     ALWAYS mapped (all three metric families coexist on every row);
 *   - `metric` ONLY selects which field the per-outlet breakdown is
 *     SORTED + CAPPED on (default 'waste' = the pre-W11 behavior,
 *     byte-identical). The top-N ORDERING itself happens in the SQL
 *     round trip (the LIMIT must apply after the ordering) — this
 *     builder receives the rows in the query's order and the
 *     cumulative-share fields are running sums in that INPUT order:
 *     meaningful for the active metric, harmless otherwise.
 */
export function buildWasteTopItems(
  itemRows: WasteItemRawRow[],
  breakdownRows: WasteItemOutletRawRow[],
  windowMonths: number = WASTE_TOP_ITEMS_WINDOW_MONTHS,
  metric: WasteMetric = 'waste',
): WasteTopItemsResult {
  if (itemRows.length === 0) {
    return {
      items: [],
      populationTotal: 0,
      lastMonthKey: null,
      prevMonthKey: null,
      windowMonths,
      quadrant: null,
      // W11 additive defaults (empty-input shape).
      metric,
      susutPopulationTotal: 0,
      trialPopulationTotal: 0,
      fingerprint: null,
      trialScreen: [],
    };
  }
  const populationTotal = toNum(itemRows[0].populationTotal);
  // W11: the parity population totals ride the same round-1 window
  // functions (SUM() OVER ()) — pre-LIMIT sums, so the top-N slice's
  // shares always divide by the FULL scope total, not the slice.
  const susutPopulationTotal = toNum(itemRows[0].susutPopulationTotal);
  const trialPopulationTotal = toNum(itemRows[0].trialPopulationTotal);
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
      // W11 additive: per-outlet susut/trial companions (the breakdown
      // line can follow the ACTIVE metric).
      susut: toNum(b.susut),
      trial: toNum(b.trial),
    });
    byItemBreakdown.set(b.itemId, list);
  }
  let cumulative = 0;
  let susutCumulative = 0;
  let trialCumulative = 0;
  // W11: the breakdown sorts + caps on the ACTIVE metric's field so the
  // top-8 slice follows what the table leads with (default waste = the
  // pre-W11 sort, byte-identical).
  const breakdownKey = (b: WasteItemOutletBreakdown): number =>
    metric === 'susut' ? b.susut : metric === 'trial' ? b.trial : b.waste;
  const items: WasteTopItemRow[] = itemRows.map((r) => {
    const totalWaste = toNum(r.totalWaste);
    const share = populationTotal > 0 ? totalWaste / populationTotal : 0;
    cumulative += share;
    // W11: same mechanical share/cumulative treatment for the two parity
    // metrics (0-guarded populations, running sums in INPUT order).
    const susutNominal = toNum(r.totalSusut);
    const trialNominal = toNum(r.totalTrial);
    const susutShare = susutPopulationTotal > 0 ? susutNominal / susutPopulationTotal : 0;
    const trialShare = trialPopulationTotal > 0 ? trialNominal / trialPopulationTotal : 0;
    susutCumulative += susutShare;
    trialCumulative += trialShare;
    const breakdown = (byItemBreakdown.get(r.itemId) ?? [])
      .sort((a, b) => breakdownKey(b) - breakdownKey(a) || a.outletCode.localeCompare(b.outletCode))
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
      // W11 (additive): parity aggregates mapped straight from the same
      // round-1 scan; fingerprint null default — queryWasteTopItems fills
      // it via buildFingerprint (pure callers keep null).
      susutNominal,
      susutQty: toNum(r.susutQty),
      trialNominal,
      trialQty: toNum(r.trialQty),
      bomQty: toNum(r.bomQty),
      trialMonthsActive: toNum(r.trialMonthsActive),
      susutShare,
      trialShare,
      susutCumulativeShare: susutPopulationTotal > 0 ? susutCumulative : 0,
      trialCumulativeShare: trialPopulationTotal > 0 ? trialCumulative : 0,
      fingerprint: null,
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
    // W11 (additive): parity population totals + the metric echo; the
    // fingerprint summary + trial screen are filled by queryWasteTopItems
    // (pure callers keep the null/empty defaults).
    metric,
    susutPopulationTotal,
    trialPopulationTotal,
    fingerprint: null,
    trialScreen: [],
  };
}
