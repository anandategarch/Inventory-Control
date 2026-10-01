// GODSPLIT-W3-A: split 506-LOC → monthly-series + peer-track-record (+ shared helpers); barrel menjaga import path.
//
// Importers that stay untouched (zero-importer-edit split):
//   - tests/queries/outlet-monthly-series.test.ts — deep import of
//     the window constant + 3 pure builders + both queries from
//     this exact path;
//   - src/lib/queries/index.ts — `export * from './outlets/outlet-monthly-series'`;
//   - the 2 routes (/api/outlet-monthly-series + /api/peer-track-record)
//     import via the '@/lib/queries' barrel.
//
// The named re-exports below match the pre-split export surface EXACTLY
// (grep '^export ' on the old file): 1 constant + 4 types + 5 functions.
// Module-private helpers toNum + monthWindowBound were verbatim duplicates
// of waste/shared.ts — now imported from there by both modules (the
// GODSPLIT-A consolidation) and deliberately NOT re-exported here, so the
// public surface is unchanged.

export {
  buildMonthlySeriesRows,
  buildMonthlySeriesTotal,
  OUTLET_MONTHLY_SERIES_WINDOW_MONTHS,
  queryOutletMonthlySeries,
} from './monthly-series';
export type {
  MonthlySeriesRow,
  MonthlySeriesTotal,
} from './monthly-series';
export {
  queryPeerTrackRecord,
  summarizeTrackRecord,
} from './peer-track-record';
export type {
  PeerTrackRecordRow,
  PeerTrackRecordSummary,
} from './peer-track-record';
