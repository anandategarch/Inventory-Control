// ============================================================
//  section-gates — the ?sections= need-flag resolution
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from the top of
//  fetchReportData's body (data-fetcher.ts:185-231). Computes the
//  section gates ONCE per fetch; later phases (record-guard,
//  query-batch, peer) read them from FetcherContext.gates.
// ============================================================
import type { ReportParams } from '../types';

export function computeSectionGates(sections: ReportParams['sections']): SectionGates {
  // ============================================================
  //  FIX (BUG-3-a P2): sections-aware fetching. `?sections=` used to gate
  //  only the rendering — every export paid the FULL query bill even
  //  when it rendered one section (an "exec only" export still ran q-trend
  //  + the whole top-items batch). Build the `need` set up front and gate
  //  every fetch below on it. `sections === null` (param absent) = ALL
  //  sections; `[]` (empty param — FIX BUG-3-a C4 in route.ts) = NONE.
  //  Keep this list in sync with EXPORT_SECTION_KEYS (validation.ts),
  //  ExportDialog.tsx and the hasSection() keys in pdf/pdf-builder.ts.
  // ============================================================
  // EXPORT-TRIM (user request): trimmed 13 → 6 sections — the removed keys
  // ('breakdown'/'area'/'outlets'/'pareto'/'flip'/'peer'/'coverage') are now
  // 400-rejected by validation.ts before this pipeline ever runs.
  // REFINE-1 (user request): + 'peer' (section 7 — Resto dengan Penjualan
  // Kurang Lebih Sama) + 'flip' (section 8 — Item yang Kemungkinan Plus
  // Minus antar Periode).
  // REFINE-3 (user request): + 'anomali' (section 6 — Item Anomali vs
  // Riwayat Sendiri; trend renumbered 6→7, peer 7→8, flip 8→9).
  const ALL_EXPORT_SECTIONS = ['exec', 'growth', 'topItems', 'variance', 'itemTrend', 'anomali', 'trend', 'peer', 'flip'] as const;
  const need = new Set<string>(sections ?? ALL_EXPORT_SECTIONS);
  // Section → data dependencies (verified against pdf-builder.ts, not
  // assumed; EXPORT-TRIM: only the 6 kept sections): exec renders
  // executiveSummary (q-kpis + prev q-exec-summary); growth renders the
  // SAME execSummary (growth values + _prevMetrics need the prev-period
  // row); topItems renders the 6 top tables (q-top-nominal / q-top-devbom /
  // q-topcat + prev q-topcat + 4× q-hist-catavg + REFINE-1 q-area-catavg);
  // variance → q-variance; itemTrend → q-item-trend-matrix; trend → q-trend;
  // REFINE-1: peer → q-peer-cmp + q-peer-cmp-items (serial wave — the target
  // must be resolved first); flip → q-flip-rank. The header/footer need
  // metadata only (no SQL).
  const needExec = need.has('exec');
  const needGrowth = need.has('growth');
  const needTopItems = need.has('topItems');
  const needVariance = need.has('variance');
  const needTrend = need.has('trend');
  const needPeer = need.has('peer');
  const needFlip = need.has('flip');
  // EXPORT-TRIM: sections 'breakdown' / 'area' / 'outlets' / 'pareto' /
  // 'coverage' removed — their need* gates + fetches went with them (see
  // the section map above). 'flip' + 'peer' are BACK (REFINE-1).
  const needItemTrend = need.has('itemTrend');
  // REFINE-3 — section 6 "Item Anomali vs Riwayat Sendiri".
  const needAnomali = need.has('anomali');
  // The kpis row feeds executiveSummary (exec + growth sections + the cover
  // KPI cards). Cheap: shared cached q-* row.
  const needKpis = needExec || needGrowth;
  const needPrevSummary = needExec || needGrowth;
  return {
    needExec, needGrowth, needTopItems, needVariance, needTrend, needPeer, needFlip,
    needItemTrend, needAnomali, needKpis, needPrevSummary,
  };
}

/** Section gates — which ?sections= keys are active (drives every fetch gate). */
export interface SectionGates {
  needExec: boolean;
  needGrowth: boolean;
  needTopItems: boolean;
  needVariance: boolean;
  needTrend: boolean;
  needPeer: boolean;
  needFlip: boolean;
  needItemTrend: boolean;
  needAnomali: boolean;
  needKpis: boolean;
  needPrevSummary: boolean;
}
