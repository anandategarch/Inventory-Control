// ============================================================
//  versus — fetchVersusReportData (VERSUS-2R — NEW)
//  --------------------------------------------------------
//  User request: "aku mau sekarang dari poin 1 sampai 12 itu adalah
//  laporan versus jadi Resto BKS gol versus ckg Pak ... jadi ada dua
//  mode yaitu poin 1 sampai 12 nya Resto itu sendiri versus area atau
//  versus Resto lain yang banyak dan mode satunya lagi satu Resto itu
//  versus satu Resto lainnya" — mode 2 runs the WHOLE report pipeline
//  for BOTH outlets:
//
//    Side A (fokus)  = fetchReportData(params) with the comparator set
//                      FORCED to [versusCode] — section 13 then renders
//                      the CC-NAMES-1 duo "13. Komparasi A vs B"
//                      automatically (a user-picked ?compareOutlets in a
//                      hand-crafted URL is intentionally ignored in this
//                      mode — the versus resto IS the comparison).
//    Side B (versus) = fetchReportData with outletCode swapped to the
//                      versus resto; its comparator set is emptied
//                      (side B never renders section 13).
//
//  SEQUENTIAL on purpose (not Promise.all): the two pipelines share the
//  q-* cache rows for every NON-outlet-scoped query (the unscoped
//  custom-compare scan, q-area, q-waste-network, the population league
//  scan) — running A first warms them so B's pass hits the cache. More
//  importantly, the route's observed cold-path failure mode is Prisma
//  pool contention (AUDIT-C F4: ~17 queries fanning out on a cold
//  function); doubling that fan-out in ONE wave is the single riskiest
//  change this mode could make to the pool. Sequential keeps the wave
//  shape identical to the standard export (the retry in route.ts still
//  covers a cold-start hiccup on either side).
//
//  Name resolution: the versus headers/subheads/badges carry NAMA resto
//  (CC-NAMES-1 convention — "BKSGOL", never "resto pembanding"). The
//  names come from the Outlet master (one indexed 2-row findMany);
//  a code with no master row falls back to the dot-suffix ("1084.BKSGOL"
//  → "BKSGOL") — the pipeline's own 404 guard (ensureRecordsExist) is
//  the authority on whether the outlet has data in the period at all.
// ============================================================
import { db } from '@/lib/db';
import type { ReportData, ReportParams, FetchedReport } from '../types';
import { fetchReportData } from '../data-fetcher';

/** What the route hands to buildPdfReport in versus mode. */
export interface VersusFetched {
  /** Side A — the focus resto (params.outletCode). */
  report: FetchedReport;
  /** Side B — the versus comparator's full ReportData. */
  versusData: ReportData;
  /** Display names (Outlet master; code-suffix fallback). */
  names: { focusName: string; versusName: string };
}

/** "1084.BKSGOL" → "BKSGOL" (no dot / trailing dot → the code itself). */
function codeSuffix(code: string): string {
  const i = code.lastIndexOf('.');
  return i >= 0 && i < code.length - 1 ? code.slice(i + 1) : code;
}

/**
 * Resolve both outlets' display names from the Outlet master (PURE-ish:
 * one indexed query; exported for tests). Codes absent from the master
 * fall back to the dot-suffix so a hand-crafted URL never crashes the
 * name rendering — the data pipeline's 404 guard decides existence.
 */
export async function resolveVersusNames(
  focusCode: string,
  versusCode: string,
): Promise<{ focusName: string; versusName: string }> {
  const rows = await db.outlet.findMany({
    where: { code: { in: [focusCode, versusCode] } },
    select: { code: true, name: true },
  });
  const byCode = new Map(rows.map((r) => [r.code, r.name]));
  return {
    focusName: byCode.get(focusCode) ?? codeSuffix(focusCode),
    versusName: byCode.get(versusCode) ?? codeSuffix(versusCode),
  };
}

/**
 * Versus mode orchestrator — the route's Stage 1 replacement. Throws
 * EarlyHttpResponse (404) verbatim from EITHER side's record guard (the
 * message names the outlet that had no records, so a versus pick with no
 * data in the period is self-explanatory).
 */
export async function fetchVersusReportData(params: ReportParams): Promise<VersusFetched> {
  const versusCode = params.versusCode;
  if (!versusCode) throw new Error('fetchVersusReportData dipanggil tanpa versusCode');
  const focusCode = params.outletCode && params.outletCode !== 'all' ? params.outletCode : null;
  if (!focusCode) throw new Error('fetchVersusReportData dipanggil tanpa resto fokus');

  // Names first — cheap (indexed 2-row lookup), and the versus side's
  // pipeline below is the expensive part.
  const names = await resolveVersusNames(focusCode, versusCode);

  // Side A — the focus resto. Section 13's comparator set is FORCED to
  // the versus resto (see the header note); every other query runs on the
  // focus scope exactly like a standard export.
  const report = await fetchReportData({
    ...params,
    compareOutlets: [versusCode],
    compareAreas: [],
  });

  // Side B — the same pipeline with the outlet swapped. Comparator set
  // emptied: side B's section 13 is never rendered (hasSection gates on
  // the SHARED sections list, and drawCustomCompareSection is called on
  // side A's env only).
  const reportB = await fetchReportData({
    ...params,
    outletCode: versusCode,
    compareOutlets: [],
    compareAreas: [],
  });

  return { report, versusData: reportB.data, names };
}
