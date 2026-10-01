// ============================================================
//  Waste Top Items — W3 "Kuadran Sistemik vs Insiden" (pure builders)
//  --------------------------------------------------------
//  Item-level prevalence × persistence quadrant: is an item's waste a
//  GLOBAL recipe/process problem (many outlets × many months —
//  SISTEMIK) or a LOCAL one-off (INSIDEN)? Plus per-item HHI (how
//  concentrated the item's waste is across outlets) and network-level
//  paretoK + class distribution.
//
//  Methodology (findings-DEEPWASTE2-B §2 W3, Readiness-A):
//    - prevalence  = outletsActive(waste>0) / outletsWithBom — the
//      denominator counts ONLY outlets with BOM>0 for the item
//      (BUGHUNT-R1 FIX 1 discipline: mere record presence overstated
//      spread — an item stocked in 343 outlets but wasting in 1 used
//      to read 343; here an item prepped nowhere but wasting in 1
//      outlet must not read "100% prevalent" either).
//    - persistence = monthsActive / windowMonths over the REAL window
//      (FIX 2 pattern: the classification threshold is
//      ceil(ACTUAL windowMonths/2) months, NOT the 12-month cap's 6 —
//      a 9-month live window thresholds at 5 months).
//    - quadrant: SISTEMIK (prev ≥ PREVALENCE_MIN AND persistent) ·
//      MUSIMAN (widespread, not persistent) · LOKAL-KRONIS (narrow,
//      persistent) · INSIDEN (both low).
//    - HHI = Σ(share²) over the item's per-outlet waste shares from
//      the FULL outlet distribution (the query-side round trip is
//      GROUP BY outlet with NO cap — the top-8 breakdown slice would
//      truncate the tail and overstate concentration). Guard: null
//      when the item has < WASTE_QUADRANT_HHI_MIN_OUTLETS active
//      outlets (see constants.ts for why).
//
//  PURE (compute/classify split — same as buildWasteTopItems /
//  isSistematikWasteItem): input = the BUILT top-item rows + the
//  full per-(item,outlet) distribution + windowMonths; output = a
//  per-item quadrant map + network summary. No DB, no mutation of
//  the input rows (the caller merges `quadrant` onto the rows).
//  Exported for vitest.
// ============================================================
import {
  WASTE_QUADRANT_HHI_MIN_OUTLETS,
  WASTE_QUADRANT_PARETO_SHARE,
  WASTE_QUADRANT_PREVALENCE_MIN,
} from './constants';
import type {
  WasteItemOutletDistributionRawRow,
  WasteItemQuadrant,
  WasteQuadrantClass,
  WasteQuadrantSummary,
  WasteTopItemRow,
} from './types';

// toNum mirrors waste/shared.ts (kept local — the split precedent keeps
// builders.ts's toNum module-private; same defensive bigint/null coercion).
const toNum = (v: number | bigint | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The four classes in display order (SISTEMIK first — action framing). */
export const WASTE_QUADRANT_CLASSES: readonly WasteQuadrantClass[] = [
  'SISTEMIK',
  'MUSIMAN',
  'LOKAL-KRONIS',
  'INSIDEN',
] as const;

// ------------------------------------------------------------
// Pure transforms (exported for vitest)
// ------------------------------------------------------------

/**
 * HHI (Herfindahl–Hirschman Index) over per-outlet waste amounts:
 * Σ(w_i / Σw)². Pure, UNGUARDED — the <10-active-outlets guard lives in
 * buildQuadrant so this stays a plain arithmetic test surface.
 * Returns null when there is no positive waste to distribute (Σw ≤ 0 —
 * no distribution, no concentration claim).
 */
export function computeHhi(wastes: Array<number | bigint | null | undefined>): number | null {
  const values = wastes.map(toNum).filter((w) => w > 0);
  const total = values.reduce((s, w) => s + w, 0);
  if (total <= 0) return null;
  return values.reduce((s, w) => s + (w / total) ** 2, 0);
}

/**
 * Adaptive persistence threshold in MONTHS: ceil(windowMonths / 2)
 * (BUGHUNT-R1 FIX 2 — follows the REAL window, never the 12-month cap;
 * window 9 → 5, window 5 → 3, window 12 → 6).
 */
export function persistenceThresholdMonths(windowMonths: number): number {
  return Math.ceil(windowMonths / 2);
}

/**
 * Quadrant classification. `prevalence` is a fraction (null = no BOM
 * basis — treated as NOT widespread, the conservative reading: without
 * a usage denominator there is no evidence of network-wide spread).
 * `monthsActive`/`windowMonths` are raw counts so the threshold can be
 * adaptive (FIX 2) instead of comparing a fraction against a fixed 0.5.
 */
export function classifyQuadrantClass(
  prevalence: number | null,
  monthsActive: number,
  windowMonths: number,
): WasteQuadrantClass {
  const widespread = prevalence != null && prevalence >= WASTE_QUADRANT_PREVALENCE_MIN;
  const persistent = monthsActive >= persistenceThresholdMonths(windowMonths);
  if (widespread && persistent) return 'SISTEMIK';
  if (widespread && !persistent) return 'MUSIMAN';
  if (!widespread && persistent) return 'LOKAL-KRONIS';
  return 'INSIDEN';
}

/**
 * Build the W3 quadrant fields for the top items + the network summary.
 * PURE — does not mutate `items` (the caller assigns `row.quadrant`).
 *
 * @param items  the built top-item rows (share/cumulativeShare already
 *               computed by buildWasteTopItems — paretoK rides on them;
 *               outletsActive/monthsActive are the FIX 1 waste>0 counts)
 * @param distribution full per-(item, outlet) rows from the no-cap
 *                     GROUP BY round trip (waste + BOM>0 flag)
 * @param windowMonths the REAL window month count (adaptive thresholds)
 */
export function buildQuadrant(
  items: WasteTopItemRow[],
  distribution: WasteItemOutletDistributionRawRow[],
  windowMonths: number,
): { perItem: Map<number, WasteItemQuadrant>; summary: WasteQuadrantSummary } {
  // Bucket the distribution by item once — the rows arrive in SQL group
  // order but grouping here keeps the builder order-agnostic (pure).
  const byItem = new Map<number, WasteItemOutletDistributionRawRow[]>();
  for (const d of distribution) {
    const list = byItem.get(d.itemId) ?? [];
    list.push(d);
    byItem.set(d.itemId, list);
  }

  const classCounts: Record<WasteQuadrantClass, number> = {
    SISTEMIK: 0,
    MUSIMAN: 0,
    'LOKAL-KRONIS': 0,
    INSIDEN: 0,
  };
  const perItem = new Map<number, WasteItemQuadrant>();

  for (const item of items) {
    const rows = byItem.get(item.itemId) ?? [];
    // Prevalence denominator: outlets with BOM>0 for THIS item (usage
    // basis). Record presence without BOM (hasBom 0) is deliberately
    // excluded — FIX 1 discipline extended to the denominator.
    const outletsWithBom = rows.filter((r) => toNum(r.hasBom) > 0).length;
    const prevalence = outletsWithBom > 0 ? item.outletsActive / outletsWithBom : null;

    // HHI over the FULL per-outlet waste distribution (no cap). Only
    // waste>0 outlets carry shares (zeros contribute 0 anyway); the
    // guard needs the ACTIVE outlet count, which equals the number of
    // positive-waste rows (same row set as the item aggregate round).
    const activeOutletWastes = rows.map((r) => toNum(r.waste)).filter((w) => w > 0);
    const hhi =
      activeOutletWastes.length >= WASTE_QUADRANT_HHI_MIN_OUTLETS
        ? computeHhi(activeOutletWastes)
        : null;

    const quadrantClass = classifyQuadrantClass(prevalence, item.monthsActive, windowMonths);
    classCounts[quadrantClass] += 1;
    perItem.set(item.itemId, {
      quadrantClass,
      prevalence,
      outletsWithBom,
      persistence: windowMonths > 0 ? item.monthsActive / windowMonths : 0,
      hhi,
    });
  }

  // paretoK: 1-based rank of the first item whose CUMULATIVE share
  // crosses the 80% target. The rows arrive share-sorted from the SQL
  // round (buildWasteTopItems preserves that order), but the pure
  // builder re-derives nothing — it trusts cumulativeShare, exactly
  // like the Pareto card's "kumulatif ≥ 80%" highlight. Null when the
  // slice never reaches the target (tight limit over a long tail) or
  // when there is no population to share out.
  let paretoK: number | null = null;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].cumulativeShare >= WASTE_QUADRANT_PARETO_SHARE) {
      paretoK = i + 1;
      break;
    }
  }

  return {
    perItem,
    summary: {
      persistenceThresholdMonths: persistenceThresholdMonths(windowMonths),
      paretoK,
      classCounts,
      windowMonths,
    },
  };
}
