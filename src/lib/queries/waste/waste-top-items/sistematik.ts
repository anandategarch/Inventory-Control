// ============================================================
//  Waste Top Items — sistematik classifier (DEEP-WASTE-1)
//  --------------------------------------------------------
//  SPLIT-0-B: moved verbatim out of waste-top-items.ts. The
//  adaptive windowMonths threshold (BUGHUNT-R1 FIX 2) lives
//  here; consumed by ./builders.ts, default cap from
//  ./constants.ts. See ./index.ts for the module doc header.
// ============================================================
import { WASTE_TOP_ITEMS_WINDOW_MONTHS } from './constants';

/**
 * Window sistematik flag — recipe/process problem vs one-off incident.
 * BUGHUNT-R1 FIX 2: the threshold is ceil(ACTUAL windowMonths / 2), not
 * the 12-month cap — with a live 8-9 month window the old hardcoded 6
 * made "sistematik" nearly unreachable while the cap was never filled.
 */
export function isSistematikWasteItem(
  monthsActive: number,
  outletsActive: number,
  windowMonths: number = WASTE_TOP_ITEMS_WINDOW_MONTHS,
): boolean {
  return monthsActive >= Math.ceil(windowMonths / 2) && outletsActive >= 2;
}
