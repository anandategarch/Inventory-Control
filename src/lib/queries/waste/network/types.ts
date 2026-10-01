// ============================================================
//  SPLIT-0-A: types deret waste jaringan — dipindah VERBATIM
//  dari network.ts (479 LOC; barrel: ./index.ts — import path
//  './network' dari waste-series.ts dan '@/lib/queries/waste/
//  network' tidak berubah).
//
//  Satu-satunya perubahan non-verbatim di file ini:
//  WasteMonthlyRawRow (interface module-private pra-split) kini
//  di-export agar sibling di folder ini (query.ts sebagai tipe
//  generic $queryRaw, builders.ts sebagai parameter
//  buildWasteMonthlyRows) dapat memakainya. Nama ini TIDAK
//  di-re-export dari barrel — pola yang sama dengan toNum /
//  monthWindowBound di ../shared.ts sejak GODSPLIT-W1-B —
//  sehingga permukaan publik modul tetap identik dengan
//  pra-split (grep '^export' file asli = 9 nama: 4 fungsi +
//  5 tipe).
//
//  W2 (Kronis vs Episodik): ditambahkan ADDITIF — field optional
//  persistenceClass dkk. pada WasteOutletRow + block
//  WasteNetworkResult.persistence + 5 tipe baru (semuanya murni
//  tambahan; tidak ada nama lama yang diubah/dihapus; lihat
//  ./persistence.ts untuk kontrak + logika keputusan).
// ============================================================

// ------------------------------------------------------------
// 1. Network waste series — types
// ------------------------------------------------------------

/** Raw SQL row (bigint aggregates coerced in buildWasteMonthlyRows). */
export interface WasteMonthlyRawRow {
  outletCode: string;
  outletName: string;
  area: string;
  monthKey: string;
  monthLabel: string;
  sales: number | bigint;
  waste: number | bigint;
  susut: number | bigint;
  trial: number | bigint;
  residual: number | bigint;
  totalLoss: number | bigint;
  totalSurplus: number | bigint;
  spike: number | bigint;
  dqError: boolean;
  dqErrorCount: number | bigint;
}

export interface WasteMonthlyRow {
  outletCode: string;
  outletName: string;
  area: string;
  monthKey: string;
  monthLabel: string;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  /** waste / sales (0 when sales is 0/absent). */
  wasteToSales: number;
  /** waste / totalLoss (0 when totalLoss is 0). */
  wasteShareOfLoss: number;
  /** residual / totalLoss (0 when totalLoss is 0). */
  residualShare: number;
  /** waste/sales > mean + 2σ of the outlet's own window (min 3 months). */
  spike: boolean;
  dqError: boolean;
  dqErrorCount: number;
}

export interface WasteOutletRow {
  outletCode: string;
  outletName: string;
  area: string;
  months: number;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  wasteShareOfLoss: number;
  residualShare: number;
  /** Months with a waste spike in the window. */
  spikeMonths: number;
  /** 1 = highest waste/sales among the scoped outlets (competition ranking). */
  rankWasteToSales: number;
  zeroWasteBigLoss: boolean;
  underRecording: boolean;
  residualDominant: boolean;
  // ----------------------------------------------------------
  // W2 (Kronis vs Episodik) — ADDITIVE optional fields, merged onto
  // each outlet row by queryWasteNetwork via buildWastePersistence.
  // Optional because buildWasteOutlets (the base builder) does not
  // compute them (they need the per-month NETWORK medians) — consumers
  // must treat them as possibly-absent (old cached payloads).
  // Full contract + decision log: ./persistence.ts header.
  // ----------------------------------------------------------
  /** Comparable months: not DQ-error AND sales > 0 (ratio defined). */
  activeMonths?: number;
  /** DQ-error months — counted SEPARATELY as invalid, never above/below. */
  invalidMonths?: number;
  /** Non-DQ months with sales = 0 (wasteToSales undefined — excluded from the share denominator). */
  zeroSalesMonths?: number;
  /** Active months with wasteToSales above that month's network median. */
  monthsAboveMedian?: number;
  /** monthsAboveMedian / activeMonths (0 when activeMonths = 0). */
  aboveMedianShare?: number;
  /** Spike (2σ) months among ACTIVE months only (DQ months excluded). */
  activeSpikeMonths?: number;
  /** KRONIS / EPISODIK / SEHAT / TERBATAS — always INDIKASI (see persistence.ts). */
  persistenceClass?: WastePersistenceClass;
}

export interface WasteMonthMeta {
  monthKey: string;
  monthLabel: string;
  dqError: boolean;
  dqErrorCount: number;
}

export interface WasteKpis {
  outlets: number;
  months: number;
  sales: number;
  waste: number;
  susut: number;
  trial: number;
  residual: number;
  totalLoss: number;
  totalSurplus: number;
  wasteToSales: number;
  /** Outlets with waste ≈ 0 but big loss. */
  zeroWasteBigLossOutlets: number;
  /** Outlets with waste/sales < 0.1% for ≥ 2 months. */
  underRecordingOutlets: number;
  /** Outlets whose residual dominates loss while waste explains < 10%. */
  residualDominantOutlets: number;
  /** Total (outlet, month) cells flagged as waste spikes. */
  spikeCells: number;
}

export interface WasteNetworkResult {
  months: WasteMonthMeta[];
  monthly: WasteMonthlyRow[];
  outlets: WasteOutletRow[];
  kpis: WasteKpis;
  /**
   * W2 (Kronis vs Episodik) — ADDITIVE network-level persistence block
   * (transition matrix + persistence ratio + Fisher exact p + class
   * distribution + per-month medians). Always present in the
   * queryWasteNetwork response; the /api/waste-series route forwards
   * it under the same key. Older consumers ignore it.
   */
  persistence: WastePersistenceBlock;
}

// ------------------------------------------------------------
// 2. W2 — Kronis vs Episodik persistence types (additive)
// ------------------------------------------------------------

/** W2: per-outlet persistence class. All classes are INDIKASI (statistical indication, not proof). */
export type WastePersistenceClass = 'KRONIS' | 'EPISODIK' | 'SEHAT' | 'TERBATAS';

/** W2: per-outlet persistence metrics (merged onto WasteOutletRow as ADDITIVE optional fields). */
export interface WasteOutletPersistence {
  outletCode: string;
  /** Comparable months: not DQ-error AND sales > 0 (ratio defined). */
  activeMonths: number;
  /** DQ-error months — counted SEPARATELY as invalid, never above/below. */
  invalidMonths: number;
  /** Non-DQ months with sales = 0 (wasteToSales undefined — excluded from the share denominator). */
  zeroSalesMonths: number;
  /** Active months with wasteToSales above that month's network median. */
  monthsAboveMedian: number;
  /** monthsAboveMedian / activeMonths (0 when activeMonths = 0). */
  aboveMedianShare: number;
  /** Spike (2σ) months among ACTIVE months only (DQ months excluded). */
  activeSpikeMonths: number;
  persistenceClass: WastePersistenceClass;
}

/** W2: per-month network median of wasteToSales over the month's ACTIVE outlets (seasonality control). */
export interface WasteMonthMedian {
  monthKey: string;
  monthLabel: string;
  medianWasteToSales: number;
  /** Active outlets that month (the median's n). */
  activeOutlets: number;
}

/** W2: network-level persistence summary — the numbers behind the "Kronis vs Episodik" card. */
export interface WastePersistenceSummary {
  /** t high → t+1 high (consecutive active month pairs, network-wide). */
  transitionHH: number;
  /** t high → t+1 low. */
  transitionHL: number;
  /** t low → t+1 high. */
  transitionLH: number;
  /** t low → t+1 low. */
  transitionLL: number;
  /** HH + HL + LH + LL. */
  transitionPairs: number;
  /** HH / (HH + HL); null when no high-start pairs. */
  pHighNextGivenHigh: number | null;
  /** LH / (LH + LL); null when no low-start pairs. */
  pHighNextGivenLow: number | null;
  /** [HH/(HH+HL)] / [LH/(LH+LL)]; null when undefined (never ±Infinity — JSON-safe). */
  persistenceRatio: number | null;
  /** Two-sided Fisher exact p on [[HH, HL], [LH, LL]]; null when no pairs. */
  fisherP: number | null;
  /** Months with a computable median (≥ 1 active outlet). */
  monthsWithMedian: number;
  /** Smallest active-outlet count among those months (surfaces degenerate n=1 months). */
  minActiveOutletsPerMonth: number;
  classDistribution: {
    kronis: number;
    episodik: number;
    sehat: number;
    terbatas: number;
  };
  /** Epistemic label (house convention): the classes are indication, not proof. */
  epistemicLabel: 'INDIKASI';
}

/** W2: the top-level `persistence` response block — summary + per-month medians. */
export interface WastePersistenceBlock {
  summary: WastePersistenceSummary;
  medians: WasteMonthMedian[];
}

/** W2: full builder output (per-outlet metrics + medians + summary). */
export interface WastePersistenceResult {
  outlets: WasteOutletPersistence[];
  medians: WasteMonthMedian[];
  summary: WastePersistenceSummary;
}
