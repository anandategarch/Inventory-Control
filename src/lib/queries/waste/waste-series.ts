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
//
// W2 (Kronis vs Episodik): diperluas ADDITIF — +3 fungsi +2 konstanta
// +5 tipe dari ./network/persistence.ts (deep import
// '@/lib/queries/waste/network/persistence' juga tetap valid untuk
// test pure-builder tanpa db-mock). Permukaan lama tidak berubah.
//
// W1 (Liga Waste-Rate): diperluas ADDITIF — +6 fungsi +5 konstanta
// +8 tipe dari ./rate-league.ts (query + pure builder rate-league;
// deep import '@/lib/queries/waste/rate-league' juga valid untuk
// test pure-builder). Permukaan lama tidak berubah.
//
// W10 (Atribusi + Skenario Sensitivitas Residual): diperluas ADDITIF
// — +1 fungsi +3 konstanta +6 tipe dari ./network/attribution.ts
// (pure builder atribusi; deep import
// '@/lib/queries/waste/network/attribution' juga valid). Permukaan
// lama tidak berubah.

export {
  buildWasteKpis,
  buildWasteMonthlyRows,
  buildWasteOutlets,
  queryWasteNetwork,
  buildWastePersistence,
  classifyWastePersistence,
  fisherExact2x2,
  WASTE_KRONIS_MIN_MONTHS,
  WASTE_KRONIS_SHARE,
  // W10 (additive): atribusi loss W/S/T vs residual + skenario p.
  buildWasteAttribution,
  WASTE_ATTRIBUTION_DECILE_P,
  WASTE_ATTRIBUTION_DISCLOSURE,
  WASTE_ATTRIBUTION_SCENARIO_P,
} from './network';
export type {
  // W10 (additive): tipe block `attribution` + input struktural.
  WasteAttributionComponent,
  WasteAttributionDecile,
  WasteAttributionKpisInput,
  WasteAttributionOutletInput,
  WasteAttributionResult,
  WasteAttributionScenario,
  WasteKpis,
  WasteMonthMedian,
  WasteMonthMeta,
  WasteMonthlyRow,
  WasteNetworkResult,
  WasteOutletRow,
  WasteOutletPersistence,
  WastePersistenceBlock,
  WastePersistenceClass,
  WastePersistenceResult,
  WastePersistenceSummary,
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
// W1 (additive): Liga Waste-Rate — query + pure builder + helpers
// (median/MAD/robust-z) + knobs. See ./rate-league.ts for the
// methodology header.
export {
  queryWasteRateLeague,
  buildRateLeague,
  medianOf,
  madOf,
  robustZ,
  clampRateLeagueLimit,
  WASTE_RATE_LEAGUE_WINDOW_MONTHS,
  WASTE_RATE_LEAGUE_DEFAULT_LIMIT,
  WASTE_RATE_LEAGUE_MAX_LIMIT,
  WASTE_RATE_LEAGUE_MIN_OUTLETS,
  WASTE_RATE_LEAGUE_MAD_SCALE,
} from './rate-league';
export type {
  WasteRateItemRawRow,
  WasteRateOutletRawRow,
  WasteRateLeagueRow,
  WasteRateLeagueItem,
  WasteRateLeagueOmittedReason,
  WasteRateLeagueMeta,
  WasteRateLeagueResult,
} from './rate-league';
