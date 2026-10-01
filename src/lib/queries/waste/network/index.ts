// SPLIT-0-A: split 479-LOC network.ts → query.ts + builders.ts +
// types.ts; barrel menjaga import path. './network' (dari barrel
// waste-series.ts sebelah) dan '@/lib/queries/waste/network' tetap
// valid via folder index — importers tidak disentuh (zero-importer-
// edit split, pola GODSPLIT-W1-B/W3-B). Permukaan export identik
// dengan file asli (grep '^export' pra-split = 9 nama: 4 fungsi +
// 5 tipe); WasteMonthlyRawRow sengaja TIDAK di-re-export (module-
// private pra-split — lihat ./types.ts).
//
// W2 (Kronis vs Episodik): permukaan export barrel diperluas
// ADDITIF (+3 fungsi +2 konstanta +5 tipe dari ./persistence.ts
// dan ./types.ts) — 9 nama asli tidak berubah; semua import path
// lama tetap valid.
//
// W10 (Atribusi + Skenario Sensitivitas Residual): diperluas
// ADDITIF lagi (+1 fungsi +3 konstanta +8 tipe dari ./attribution.ts
// dan ./types.ts). ./attribution.ts adalah modul PURE (import tipe
// saja) sehingga aman di-import langsung oleh komponen client
// (decomposition-card) tanpa menarik Prisma ke bundle browser.
//
// Layout: query.ts (queryWasteNetwork + pipeline SQL 8-CTE; detektor
// spike 2σ hidup di CTE outlet_stats/monthly_final) · builders.ts
// (buildWasteMonthlyRows/buildWasteOutlets/buildWasteKpis — 3 detektor
// TS zeroWasteBigLoss/underRecording/residualDominant tetap inline
// verbatim di buildWasteOutlets, bukan fungsi mandiri) · types.ts
// (WasteMonthlyRawRow internal + 5 tipe publik) · persistence.ts
// (W2 Kronis-vs-Episodik: buildWastePersistence + fisherExact2x2 +
// classifyWastePersistence — pass murni kedua atas baris bulanan) ·
// attribution.ts (W10 Atribusi + Skenario Sensitivitas Residual:
// buildWasteAttribution — pass murni ketiga atas kpis + outlets).
// Konstanta window/ambang tetap di ../shared.ts (tidak disentuh).
// Persiapan gelombang fitur W2 (persistensi) + W11 (metric-swap) yang
// akan extend modul ini — pre-split menjaga god file tidak tumbuh
// kembali.
//
// Catatan path pada header historis di bawah (pra-split, relatif
// waste/): "./shared.ts" & "./peer-zscore.ts" = ../shared.ts &
// ../peer-zscore.ts relatif folder network/ ini.
// ============================================================
//  Waste Network Series — queryWasteNetwork (DEEP-WASTE-1)
//  --------------------------------------------------------
//  GODSPLIT-W1-B: moved verbatim out of waste-series.ts (was a
//  773-LOC two-pipeline monolith). Shared window constants +
//  helpers live in ./shared.ts; the peer z-score pipeline lives
//  in ./peer-zscore.ts; waste-series.ts is now a barrel.
//
//  Multi-month, SAME-weekLabel waste view — the in-app version
//  of the "Profil Waste Outlet" / "Data Bulanan" / "Matriks
//  Bulanan" / "Anomali Waste" / "TJPPLU Fokus" sheets from the
//  offline deep waste analysis report (Analisa-Deep-Waste-Area-1):
//
//  queryWasteNetwork — per (outlet, month) same-week waste
//     aggregates over the most recent 12 months (incl. the
//     running month), scoped by the global filters (area /
//     kelompok / PIC / outletCode): ΣABS nominalWaste/Susut/
//     Trial, LOSS-SIDE ΣABS residualNominal (BUGHUNT-R1 FIX 5:
//     only rows with nominalLossSurplus < 0 — the loss-decomposition
//     consumers, incl. residualShare = residual/totalLoss, need the
//     same grain as the denominator or the share exceeds 1),
//     Total Loss/Surplus (Excel convention), sales (MODE per
//     OutletPeriodSales), waste/sales ratio, and 4 network anomaly
//     detectors:
//       - spike            : waste/sales > mean + 2σ of the
//                            outlet's OWN months in the window
//                            (min 3 months WITH sales > 0 — the
//                            baseline skips sales=0 months rather
//                            than diluting them with forced 0s;
//                            BUGHUNT-R1 FIX 7) and std > 0 — the
//                            "spike waste > 2σ" P2 rule;
//       - zeroWasteBigLoss : ANY window month with waste ≈ 0 (≤ Rp 1)
//                            AND that month's total loss above
//                            HIGH_LOSS_NOMINAL_THRESHOLD (FIX 3:
//                            per-month grain — the threshold is a
//                            single-period value everywhere else);
//       - underRecording   : ≥ 2 months EACH with sales > 0 and
//                            waste/sales < 0.1% (FIX 4: per-month
//                            ratios, not the window aggregate);
//       - residualDominant : loss-side residual > 80% of loss AND
//                            waste explains < 10% of it.
//     The per-outlet profile rows + network KPIs are derived
//     from the monthly rows by PURE builders (testable — same
//     compute/classify split as outlet-monthly-series.ts).
//
//  GRAIN + sales MODE conventions: see ./shared.ts (moved
//  verbatim). PURELY ADDITIVE: feeds the /api/waste-series
//  route used by the Waste tab.
// ============================================================
export { buildWasteKpis, buildWasteMonthlyRows, buildWasteOutlets } from './builders';
// W2 (Kronis vs Episodik) — additive: pure persistence pass + the
// self-contained two-sided Fisher exact + the classification gate
// (constants WASTE_KRONIS_SHARE / WASTE_KRONIS_MIN_MONTHS live in
// persistence.ts, NOT ../shared.ts, to keep the W2 footprint
// conflict-free for sibling agents extending shared.ts concurrently).
export {
  buildWastePersistence,
  classifyWastePersistence,
  fisherExact2x2,
  WASTE_KRONIS_MIN_MONTHS,
  WASTE_KRONIS_SHARE,
} from './persistence';
// W10 (Atribusi + Skenario Sensitivitas Residual) — additive: pure
// attribution pass + the frozen scenario grid + the headline decile
// p + the mandatory structural disclosure (constants live in
// attribution.ts, NOT ../shared.ts — same conflict-free-footprint
// reasoning as W2 above).
export {
  buildWasteAttribution,
  WASTE_ATTRIBUTION_DECILE_P,
  WASTE_ATTRIBUTION_DISCLOSURE,
  WASTE_ATTRIBUTION_SCENARIO_P,
} from './attribution';
export { queryWasteNetwork } from './query';
export type {
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
} from './types';
