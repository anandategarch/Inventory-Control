// ============================================================
//  METRIC DEFINITIONS — Single Source of Truth
//  --------------------------------------------------------
//  Semua perhitungan metric di aplikasi HARUS mengikuti definisi ini.
//  Jangan hitung metric di tempat lain — gunakan fungsi dari
//  src/lib/metrics/*.ts yang mengimplementasikan definisi ini.
//
//  Sesuai Master Context — Inventory Control Intelligence Platform.
// ============================================================

/**
 * Dev/BOM per-row:
 *   ABS(QTY DEVIASI) / ABS(QTY BOM)
 *
 * Master context #32: Deviation/BOM = SUM(ABS(QTY Deviation)) / SUM(ABS(QTY BOM))
 *
 * NOTE: pctQtyDeviasiToBom dari Excel seharusnya = ini, tapi
 * bisa beda karena Excel rounding. Untuk konsistensi, selalu
 * hitung ulang dari qtyDeviasi dan qtyBom.
 */
export const DEV_BOM_PER_ROW = 'Math.abs(qtyDeviasi) / Math.abs(qtyBom)';

/**
 * Dev/BOM aggregate (per outlet/area/network):
 *   SUM(ABS(QTY DEVIASI)) / SUM(ABS(QTY BOM))
 *
 * BUKAN: AVG(ABS(pctQtyDeviasiToBom)) — ini rata-rata ratio per item,
 * yang bisa memberi hasil berbeda jika item dengan BOM kecil
 * memiliki deviasi tinggi.
 *
 * Aggregate ratio = total deviation / total volume = weighted average.
 */
export const DEV_BOM_AGGREGATE = 'SUM(absQtyDeviasi) / SUM(absQtyBom)';

/**
 * Sales per outlet:
 *   MODE (most frequent nominalSales value per outlet)
 *   Tie-break: smaller value wins (konsisten SQL + JS)
 *
 * Master context #30: Sales merupakan outlet-level field (deduplicated).
 * Master context #12: Sales vs Deviation untuk context kewajaran.
 */
export const SALES_MODE = 'MODE(nominalSales) per outlet — tie: smaller value wins';

/**
 * Gross Deviation:
 *   QTY DEVIASI (Stok Fisik - Stok Sistem)
 *   Signed: positive = LOSS, negative = SURPLUS
 *
 * Master context #8: QTY DEVIASI = Gross Deviation (Layer 1)
 */
export const GROSS_DEVIATION = 'qtyDeviasi (signed, from Excel)';

/**
 * Net Deviation:
 *   QTY LOSS/SURPLUS = Gross Deviation - Waste - Susut - Trial
 *   Signed: positive = LOSS, negative = SURPLUS
 *
 * Master context #11: Three-Layer — Net = Gross - Explained (W+S+T)
 */
export const NET_DEVIATION = 'qtyLossSurplus (signed, from Excel)';

/**
 * Nominal Deviasi (GROSS):
 *   QTY DEVIASI × Price
 *
 * Master context #8: NOMINAL DEVIASI = GROSS Deviation × Price
 */
export const NOMINAL_DEVIASI_GROSS = 'absNominalDeviasi (GROSS financial impact)';

/**
 * Nominal Loss/Surplus (NET):
 *   QTY LOSS/SURPLUS × Price
 *
 * Master context #9: NOMINAL LOSS/SURPLUS = NET Deviation × Price
 */
export const NOMINAL_LOSS_SURPLUS_NET = 'absNominalLossSurplus (NET financial impact)';

/**
 * Residual:
 *   ABS(Net Deviation) — clamp to 0 if over-explained
 *   residual = Math.max(0, ABS(qtyDeviasi) - ABS(waste + susut + trial))
 *
 * Master context #11: Residual = sisa setelah W+S+T (unexplained deviation)
 */
export const RESIDUAL = 'Math.max(0, absDev - explained)';

/**
 * Residual Ratio:
 *   ABS(Residual) / ABS(QTY DEVIASI)
 *
 *   Berapa % dari gross deviation yang belum terjelaskan.
 */
export const RESIDUAL_RATIO = 'residualQty / absQtyDeviasi (0-1)';

/**
 * Explained %:
 *   (Waste + Susut + Trial) / Gross Deviation
 *
 *   Berapa % dari gross deviation yang sudah dijelaskan.
 *   Master context #10: Waste/Susut/Trial menjelaskan bagian deviation
 */
export const EXPLAINED_PCT = '(absWaste + absSusut + absTrial) / absQtyDeviasi';

/**
 * Growth:
 *   (Current - Previous) / ABS(Previous)
 *   Signed: positive = increasing, negative = decreasing
 *
 * Master context #31: Growth = (curr - prev) / |prev|
 * NOTE: Tidak bisa dihitung dari zero base (prev = 0 → null)
 */
export const GROWTH = '(curr - prev) / Math.abs(prev)';

/**
 * Growth (magnitude, for consumption columns BOM/COM):
 *   (ABS(Current) - ABS(Previous)) / ABS(Previous)
 *   Karena BOM/COM bernilai negatif (consumption), gunakan absolute.
 */
export const GROWTH_ABS = '(Math.abs(curr) - Math.abs(prev)) / Math.abs(prev)';

/**
 * Z-Score:
 *   (ABS(current Dev/BOM) - mean(weekly aggregate Dev/BOM))
 *   / STDDEV_SAMP(weekly aggregate Dev/BOM)
 *
 * Aturan:
 *   - Each week = 1 observation (aggregate Dev/BOM = SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom)))
 *   - BUKAN row-level AVG(ABS(pctQtyDeviasiToBom)) — itu weighted by row count
 *   - Sample variance (N-1, Bessel's correction)
 *   - Exclude current period dari historical stats
 *   - Require n >= HISTORICAL_MIN_WEEKS (default 4) — n = WEEK count, bukan row count
 *
 * Master context #19: Historical Analysis — Magnitude + Direction + Consistency
 */
export const Z_SCORE = '(|current| - mean(weekly)) / stdDev(weekly) — sample variance, exclude current';

/**
 * Historical Benchmark Flag:
 *   Berdasarkan Z-Score (historical comparison), BUKAN area/network comparison
 *   zScore > HISTORICAL_ZSCORE_HIGH → HISTORICAL_HIGH (outlier vs pola sendiri)
 *   zScore > HISTORICAL_ZSCORE_WARN → HISTORICAL_WARNING
 *
 * FIX (audit issue #10): Renamed from ABOVE_NETWORK_AVG/ABOVE_AREA_AVG to
 * HISTORICAL_HIGH/HISTORICAL_WARNING — nama lama menyesatkan karena
 * zScore adalah perbandingan vs HISTORY sendiri, BUKAN vs outlet lain.
 *
 * Area/network comparison ada di computeBenchmark() (benchmark.ts)
 * dengan flag ABOVE_NETWORK/ABOVE_AREA yang terpisah.
 */
export const BENCHMARK_FLAG = 'from zScore vs historical — HISTORICAL_HIGH/HISTORICAL_WARNING';

/**
 * Health Score:
 *   30% Dev/BOM + 25% Residual + 25% Loss/Sales + 20% Abnormal
 *   Each metric normalized to 0-100 (100 = healthy, 0 = critical)
 *   Clamp 0-100
 *
 * Master context #33: Skor = 30% + 25% + 25% + 20%
 *
 * DevBOM: <5% → 100, >50% → 0 (linear)
 * Residual: <20% → 100, >80% → 0 (linear)
 * Loss/Sales: <2% → 100, >15% → 0 (linear)
 * Abnormal: abnormal / (warning + abnormal), 0% → 100, >50% → 0 (linear)
 */
export const HEALTH_SCORE_WEIGHTS = {
  devBom: 0.30,
  residual: 0.25,
  lossToSales: 0.25,
  abnormal: 0.20,
} as const;

export const HEALTH_SCORE_THRESHOLDS = {
  devBom: { good: 0.05, bad: 0.50 },     // <5% → 100, >50% → 0
  residual: { good: 0.20, bad: 0.80 },    // <20% → 100, >80% → 0
  lossToSales: { good: 0.02, bad: 0.15 }, // <2% → 100, >15% → 0
  abnormal: { good: 0.0, bad: 0.50 },     // 0% → 100, >50% → 0
} as const;

/**
 * Priority P1/P2/P3:
 *   FIX (audit issue #5): Master rule uses OR logic, not AND.
 *
 *   P1: absNominalLossSurplus > P1_NOMINAL_THRESHOLD
 *       OR residualRatio > RESIDUAL_LOSS_HIGH_PCT
 *       OR zScore > HISTORICAL_ZSCORE_HIGH
 *       OR isOverExplained (fraud red flag)
 *   P2: absNominalLossSurplus > P2_NOMINAL_THRESHOLD
 *       OR residualRatio > RESIDUAL_LOSS_WARN_PCT
 *       OR absDevBom > STD_DEVIASI_BOM_PCT
 *   P3: lainnya
 *
 * Thresholds dari Settings:
 *   P1_NOMINAL_THRESHOLD = HIGH_LOSS_NOMINAL_THRESHOLD (default 50,000,000)
 *   P2_NOMINAL_THRESHOLD = P2_NOMINAL_THRESHOLD (default 10,000,000)
 *   RESIDUAL_LOSS_HIGH_PCT = 0.70
 *   RESIDUAL_LOSS_WARN_PCT = 0.50
 *   STD_DEVIASI_BOM_PCT = 0.05
 *   HISTORICAL_ZSCORE_HIGH = 2.0
 *
 * Master context: P1 = critical financial OR operational anomaly.
 * Previously: AND logic (high nominal AND high devBom) → terlalu konservatif,
 * banyak anomaly high-residual tapi nominal kecil terlewat.
 */
export const PRIORITY_DEFINITIONS = {
  p1: 'high nominal OR high residual OR high zScore OR over-explained',
  p2: 'medium nominal OR warn residual OR high devBom',
  p3: 'normal',
} as const;

/**
 * Direction:
 *   Berdasarkan NET DEVIATION (qtyLossSurplus), BUKAN GROSS (qtyDeviasi)
 *   Net > 0 → LOSS (over-consumption)
 *   Net < 0 → SURPLUS (under-consumption)
 *   Net = 0 → NEUTRAL
 *
 * Master context #9: Direction dari Net Deviation
 * Fallback: jika qtyLossSurplus null, gunakan qtyDeviasi (GROSS)
 *
 * FIX (audit issue #14): computeDirection() implemented in deviation.ts
 * — single source of truth. Sebelumnya classifyDirection() duplicate
 * di transform.ts + outlet-focus/route.ts.
 */
export type Direction = 'LOSS' | 'SURPLUS' | 'NEUTRAL';
export const DIRECTION = 'from qtyLossSurplus (NET) — fallback to qtyDeviasi (GROSS)';

/**
 * Three-Layer Deviation:
 *   Layer 1: Gross Deviation = QTY DEVIASI (Stok Fisik - Stok Sistem)
 *   Layer 2: Explained = Waste + Susut + Trial
 *   Layer 3: Net Deviation = Gross - Explained = QTY LOSS/SURPLUS
 *
 * Master context #11: Tiga lapisan deviation
 */
export const THREE_LAYER_DEVIATION = {
  gross: 'QTY DEVIASI (Layer 1)',
  explained: 'Waste + Susut + Trial (Layer 2)',
  net: 'QTY LOSS/SURPLUS = Gross - Explained (Layer 3)',
} as const;
