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
}
