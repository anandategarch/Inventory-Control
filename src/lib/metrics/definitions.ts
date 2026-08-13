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
 * Master context #19: % QTY DEVIASI TO BOM = QTY DEVIASI / QTY BOM
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
 * Master context #21: Sales digunakan sebagai konteks utama
 * untuk menilai kewajaran kenaikan deviation.
 */
export const SALES_MODE = 'MODE(nominalSales) per outlet — tie: smaller value wins';

/**
 * Gross Deviation:
 *   QTY DEVIASI (Stok Fisik - Stok Sistem)
 *   Signed: positive = LOSS, negative = SURPLUS
 *
 * Master context #6: QTY DEVIASI = Gross Deviation
 */
export const GROSS_DEVIATION = 'qtyDeviasi (signed, from Excel)';

/**
 * Net Deviation:
 *   QTY LOSS/SURPLUS = Gross Deviation - Waste - Susut - Trial
 *   Signed: positive = LOSS, negative = SURPLUS
 *
 * Master context #8: Net = Gross - W - S - T
 */
export const NET_DEVIATION = 'qtyLossSurplus (signed, from Excel)';

/**
 * Nominal Deviasi (GROSS):
 *   QTY DEVIASI × Price
 *
 * Master context #13: NOMINAL DEVIASI = GROSS × Price
 */
export const NOMINAL_DEVIASI_GROSS = 'absNominalDeviasi (GROSS financial impact)';

/**
 * Nominal Loss/Surplus (NET):
 *   QTY LOSS/SURPLUS × Price
 *
 * Master context #17: NOMINAL LOSS/SURPLUS = NET × Price
 */
export const NOMINAL_LOSS_SURPLUS_NET = 'absNominalLossSurplus (NET financial impact)';

/**
 * Residual:
 *   ABS(Net Deviation) — clamp to 0 if over-explained
 *   residual = Math.max(0, ABS(qtyDeviasi) - ABS(waste + susut + trial))
 *
 * Master context #11.3: Net Deviation = sisa setelah W+S+T
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
 *   Master context #12: Gross tinggi tapi mostly explained = tidak buruk
 */
export const EXPLAINED_PCT = '(absWaste + absSusut + absTrial) / absQtyDeviasi';

/**
 * Growth:
 *   (Current - Previous) / ABS(Previous)
 *   Signed: positive = increasing, negative = decreasing
 *
 * Master context #60: Growth = (curr - prev) / |prev|
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
 *   (ABS(current Dev/BOM) - mean(ABS(historical Dev/BOM)))
 *   / STDDEV_SAMP(ABS(historical Dev/BOM))
 *
 * Aturan:
 *   - Gunakan ABS (magnitude), bukan signed value
 *   - Sample variance (N-1, Bessel's correction)
 *   - Exclude current period dari historical stats
 *   - Require n >= HISTORICAL_MIN_WEEKS (default 4)
 *
 * Master context #29: Historical harus membaca Magnitude + Direction + Consistency
 */
export const Z_SCORE = '(Math.abs(value) - mean) / stdDev — sample variance, exclude current';

/**
 * Benchmark Flag:
 *   Berdasarkan Z-Score (historical comparison), BUKAN area/network comparison
 *   zScore > BENCHMARK_NETWORK_FACTOR → ABOVE_NETWORK_AVG
 *   zScore > BENCHMARK_AREA_FACTOR → ABOVE_AREA_AVG
 *
 * NOTE: Area/network comparison adalah query terpisah (areaAnalysis)
 */
export const BENCHMARK_FLAG = 'from zScore vs historical — NOT vs other outlets';

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
 *   Dari Settings (WEIGHT_*, thresholds)
 *   BUKAN hardcoded 1M / 10% / 50%
 *
 * P1 = ABNORMAL severity (dari rule engine)
 * P2 = WARNING severity
 * P3 = NORMAL severity
 *
 * Untuk per-item priority (outlet-items, matrix, item-history):
 *   P1: absNominalLossSurplus > HIGH_LOSS_NOMINAL_THRESHOLD
 *       AND (Dev/BOM > STD_DEVIASI_BOM_PCT OR Residual > RESIDUAL_LOSS_HIGH_PCT)
 *   P2: Dev/BOM > STD_DEVIASI_BOM_PCT OR Residual > RESIDUAL_LOSS_HIGH_PCT
 *   P3: lainnya
 */
export const PRIORITY_DEFINITIONS = {
  p1: 'ABNORMAL severity OR (high nominal AND high devBom/residual)',
  p2: 'WARNING severity OR high devBom/residual',
  p3: 'NORMAL',
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
 */
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
