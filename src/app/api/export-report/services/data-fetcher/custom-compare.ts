// ============================================================
//  custom-compare — fetchCustomComparison (section 13's shape phase)
//  --------------------------------------------------------
//  CUSTOM-COMPARE (user: "misal aku pilih resto mlgpar terus sebagai
//  pembanding nya aku pilih resto lain lagi yaitu bdgsek nah ini bisa
//  export laporan pdf. atau aku juga bisa filter beberapa resto atau
//  filer pakai area gitu maksud nya").
//
//  Runs AFTER runSectionQueryBatch (the fetchPeerComparison precedent):
//  the UNSCOPED q-outlet-agg scan rows were fetched in the wave
//  (ctx.customCompareScanRows); THIS phase picks the comparison entity
//  set out of them and — only when a focus resto AND ≥1 comparator
//  exist — runs the per-item breakdown query (the comparator code list
//  is a REAL input dependency: area picks are expanded from the scan
//  rows first, so the items query cannot join the wave).
//
//  buildCustomComparison is a PURE function of its args (exported for
//  tests — expansion, focus dedupe, missing detection, ranking) so the
//  comparator semantics are verifiable without a DB.
//
//  Non-fatal by design (the fetchPeerComparison precedent): a failure
//  of the per-item query logs + degrades to items: [] — the 13.1/13.2
//  tables still render; the section never kills the whole export.
// ============================================================
import { queryCustomCompareItems } from '@/lib/queries';
import type { CustomCompareItemRow } from '@/lib/queries/outlets/custom-compare-items';
import type { OutletAggScanRow } from '@/lib/queries/outlets/outlet-agg-scan';
import { logger } from '@/lib/logger';
import type { CustomCompareData, CustomCompareEntity } from '../types';
import type { FetcherContext } from './context';

/** 13.3 row cap — 9.2 renders 8, 9.3 renders 10; a hand-picked
 *  comparison deserves a little more room. */
const CUSTOM_COMPARE_TOP_ITEMS = 15;

/**
 * Shape the comparison entity set from the UNSCOPED scan rows — PURE.
 *
 *  - focus  = the `outlet` param (Resto tab's Filter Resto), when set;
 *  - picks  = ?compareOutlets codes present in the scan (fromPick: true);
 *  - areas  = every scan outlet whose area ∈ ?compareAreas (fromArea:
 *    true) — an area pick legitimately brings its WHOLE population;
 *  - the focus is EXCLUDED from the comparator set even when it was also
 *    picked / sits in a picked area (isFocus wins — one row, amber);
 *  - picked codes absent from the scan → missingOutlets (the renderer
 *    lists them: no records this period ≠ zero deviation);
 *  - picked areas matching no scan outlet → missingAreas (typo guard);
 *  - entities ranked by |nominal deviasi| DESC (the 11.1 convention).
 */
export function buildCustomComparison(
  scanRows: OutletAggScanRow[],
  focusCode: string | null,
  pickedOutlets: string[],
  pickedAreas: string[],
): Pick<CustomCompareData,
  'focusCode' | 'focusName' | 'compareOutletCodes' | 'compareAreas'
  | 'entities' | 'missingOutlets' | 'missingAreas'
> {
  const pickSet = new Set(pickedOutlets);
  const areaSet = new Set(pickedAreas);
  const entities: CustomCompareEntity[] = [];
  const seen = new Set<string>();
  const areasSeen = new Set<string>();

  for (const r of scanRows) {
    const isFocus = focusCode != null && r.outletCode === focusCode;
    const fromPick = pickSet.has(r.outletCode);
    const fromArea = areaSet.has(r.area);
    // Every scan row's area is recorded (not just matched entities) — a
    // picked area is "missing" only when NO outlet of the period carries
    // it at all.
    areasSeen.add(r.area);
    if (!isFocus && !fromPick && !fromArea) continue;
    if (seen.has(r.outletCode)) continue;
    seen.add(r.outletCode);
    entities.push({
      outletCode: r.outletCode,
      outletName: r.outletName,
      area: r.area,
      isFocus,
      // The focus row never doubles as a comparator (dedupe rule above).
      fromPick: fromPick && !isFocus,
      fromArea: fromArea && !isFocus,
      nominalDeviasi: r.fNominalDeviasi,
      totalQtyDeviasi: r.fTotalQtyDeviasi,
      totalQtyBom: r.fTotalQtyBom,
      lossNominal: r.fLossNominal,
      sales: r.sales,
      nonZeroDevCount: r.nonZeroDevCount,
    });
  }

  // Missing detection — only DIRECT picks (an area that matched no outlet
  // at all lands in missingAreas; its (zero) outlets are not "missing").
  const missingOutlets = pickedOutlets.filter((c) => !seen.has(c));
  // The FOCUS outlet itself absent from the scan (no records this period)
  // rides the same list — "tanpa data" is information, and the renderer
  // must not claim a highlight that has no row.
  if (focusCode != null && !seen.has(focusCode)) missingOutlets.push(focusCode);
  const missingAreas = pickedAreas.filter((a) => !areasSeen.has(a));

  entities.sort((a, b) => Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi));

  const focusRow = focusCode != null ? entities.find((e) => e.isFocus) : undefined;
  return {
    focusCode: focusRow ? focusRow.outletCode : (focusCode ?? null),
    focusName: focusRow ? focusRow.outletName : null,
    compareOutletCodes: pickedOutlets,
    compareAreas: pickedAreas,
    entities,
    missingOutlets,
    missingAreas,
  };
}

/** Section 13's data — null when the section is off or no comparator was picked. */
export async function fetchCustomComparison(ctx: FetcherContext): Promise<CustomCompareData | null> {
  const { gates, customCompareScanRows } = ctx;
  const { compareOutlets, compareAreas, outletCode } = ctx.params;
  const { month } = ctx;
  const { week } = ctx.params;
  if (!gates.needCustomCompare) return null;

  const pickedOutlets = [...new Set(compareOutlets)];
  const pickedAreas = [...new Set(compareAreas)];
  if (pickedOutlets.length === 0 && pickedAreas.length === 0) return null;

  const focusCode = outletCode && outletCode !== 'all' ? outletCode : null;
  const base = buildCustomComparison(customCompareScanRows, focusCode, pickedOutlets, pickedAreas);

  // 13.3 — per-item breakdown needs a focus resto WITH records in the
  // period AND at least one comparator outlet. Without a focus the table
  // has no "sisi fokus" to compare against (the user compared the picked
  // set alone); without comparators there is nothing to average; a focus
  // with no records has no focus side at all (missingOutlets carries it).
  const comparatorCodes = base.entities.filter((e) => !e.isFocus).map((e) => e.outletCode);
  const focusPresent = base.entities.some((e) => e.isFocus);
  let items: CustomCompareItemRow[] = [];
  if (focusCode && focusPresent && comparatorCodes.length > 0) {
    try {
      items = await queryCustomCompareItems(
        focusCode,
        comparatorCodes,
        month,
        week,
        CUSTOM_COMPARE_TOP_ITEMS,
      );
    } catch (e) {
      // Non-fatal (the fetchPeerComparison precedent): 13.1/13.2 still
      // render; the renderer prints the factual "tidak tersedia" note
      // for 13.3 only.
      logger.warn('[export-report] custom-compare items query failed — degrading to empty 13.3', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { ...base, items };
}
