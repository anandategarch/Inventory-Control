// GODSPLIT-W1-B: split 773-LOC monolith → network.ts + peer-zscore.ts + shared.ts;
// barrel re-export menjaga import path.
//
// Importers that stay untouched (zero-importer-edit split):
//   - tests/queries/waste-series.test.ts — deep import of the 4 pure
//     builders + both queries + 5 constants from this exact path;
//   - src/lib/queries/index.ts — `export * from './waste/waste-series'`;
//   - the 3 routes (waste-series / waste-peer-zscore / waste-top-items)
//     import via the '@/lib/queries' barrel.
//
// The named re-exports below match the pre-split export surface EXACTLY
// (grep '^export ' on the old file): 7 constants + 7 types + 6 functions.
// Module-private helpers toNum / monthWindowBound moved to ./shared.ts and
// are deliberately NOT re-exported here.

export {
  buildWasteKpis,
  buildWasteMonthlyRows,
  buildWasteOutlets,
  queryWasteNetwork,
} from './network';
export type {
  WasteKpis,
  WasteMonthMeta,
  WasteMonthlyRow,
  WasteNetworkResult,
  WasteOutletRow,
} from './network';
export {
  queryWastePeerZScore,
  summarizeWastePeerZScore,
} from './peer-zscore';
export type {
  WastePeerZScoreRow,
  WastePeerZScoreSummary,
} from './peer-zscore';
export {
  WASTE_MIN_SHARE,
  WASTE_RESIDUAL_DOMINANT_PCT,
  WASTE_SPIKE_MIN_MONTHS,
  WASTE_SPIKE_SIGMA,
  WASTE_UNDER_RECORD_PCT,
  WASTE_WINDOW_MONTHS,
  WASTE_ZSCORE_MIN_BAND,
} from './shared';
