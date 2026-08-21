// ============================================================
//  Root Cause Engine — maps each rule code to possible root
//  causes + recommended actions for executive investigation.
//  --------------------------------------------------------
//  Pure data + lookup function — no DB calls, no side effects.
//  Used by:
//    - /api/outlet-items route (per-item rootCauses field)
//    - /api/root-causes endpoint (standalone lookup)
//    - /api/analysis route (worklist rootCauses summary)
//
//  Rule codes mirror src/config/rules.yaml. The mappings below
//  also cover variant codes referenced in the analysis spec
//  (SALES_BOM_DEVIATION_MISMATCH, SALES_DEV_DEVIATION_MISMATCH,
//   HISTORICAL_ABNORMAL_LOSS, EXCESSIVE_WASTE, EXCESSIVE_SUSUT)
//  so the engine is resilient to either naming convention.
// ============================================================

export type RootCauseSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type RootCauseCategory =
  | 'OPERATIONAL'
  | 'DATA_QUALITY'
  | 'FRAUD'
  | 'PROCUREMENT'
  | 'INVENTORY';

export interface RootCauseMapping {
  ruleCode: string;
  possibleRootCauses: string[];   // 2-4 possible causes
  recommendedActions: string[];   // 2-4 actionable steps
  severity: RootCauseSeverity;
  category: RootCauseCategory;
}

// ============================================================
//  Mappings for ALL rules in src/config/rules.yaml
//  Plus variant codes referenced by the analysis spec.
//  Ordered by rule group for maintainability.
// ============================================================
export const ROOT_CAUSE_MAPPINGS: Record<string, RootCauseMapping> = {
  // ===== TOLERANCE =====
  TOLERANCE_BREACH_HIGH: {
    ruleCode: 'TOLERANCE_BREACH_HIGH',
    possibleRootCauses: [
      'Pemakaian aktual jauh melebihi SOC/standard (operasional tidak sesuai prosedur)',
      'Salah perhitungan BOM — qty BOM terlalu rendah vs actual usage',
      'Porsioning tidak konsisten / tidak pakai timbangan',
      'Receiving discrepancy — barang diterima kurang dari yang dicatat',
    ],
    recommendedActions: [
      'Sampling pemakaian aktual per menu — bandingkan dengan SOC',
      'Audit timbangan & alat ukur — kalibrasi ulang jika perlu',
      'Verifikasi receiving report vs purchase order — cari selisih kuantitas',
      'Rekonsiliasi BOM dengan resep aktual — update master BOM jika ada perubahan',
    ],
    severity: 'HIGH',
    category: 'OPERATIONAL',
  },

  TOLERANCE_BREACH: {
    ruleCode: 'TOLERANCE_BREACH',
    possibleRootCauses: [
      'Pemakaian aktual sedikit di atas SOC (variasi operasional normal)',
      'Tolerance yang diset terlalu ketat untuk kondisi operasional',
      'Porsioning kurang konsisten — perlu training ulang',
    ],
    recommendedActions: [
      'Observasi proses produksi — identifikasi step yang menyebabkan variasi',
      'Training ulang staff dapur pada porsioning & SOP',
      'Review tolerance setting — pastikan realistis vs actual capability',
    ],
    severity: 'MEDIUM',
    category: 'OPERATIONAL',
  },

  TOLERANCE_NOT_SET_HIGH_DEV: {
    ruleCode: 'TOLERANCE_NOT_SET_HIGH_DEV',
    possibleRootCauses: [
      'Tolerance belum didefinisikan di master item — kelalaian setup',
      'Item baru belum memiliki baseline SOC yang stabil',
      'Tolerance dihapus/replaced tapi tidak di-reinput',
    ],
    recommendedActions: [
      'Set tolerance baseline segera — gunakan avg historis + 1 std dev',
      'Klasifikasikan item baru — tentukan apakah perlu trial period',
      'Audit master item — cari item lain tanpa tolerance',
    ],
    severity: 'MEDIUM',
    category: 'DATA_QUALITY',
  },

  // ===== OVER_EXPLAINED (Fraud indicator) =====
  OVER_EXPLAINED: {
    ruleCode: 'OVER_EXPLAINED',
    possibleRootCauses: [
      'Salah input angka Waste/Susut/Trial (double-entry atau typo)',
      'Pencatatan waste dibesar-besarkan untuk menutupi selisih',
      'Error formula di Excel template (referensi cell salah)',
      'Possible fraud — sengaja mencatat waste tinggi untuk manipulasi stock',
    ],
    recommendedActions: [
      'Audit fisik waste — bandingkan pencatatan vs actual waste di tempat sampah',
      'Verifikasi formula Excel template — cek referensi cell Waste/Susut/Trial',
      'Interview staff pencatatan — konfirmasi proses input',
      'Cek CCTV area dapur jika tersedia — validasi waste actual',
    ],
    severity: 'CRITICAL',
    category: 'FRAUD',
  },

  // ===== RESIDUAL LOSS =====
  RESIDUAL_LOSS_HIGH: {
    ruleCode: 'RESIDUAL_LOSS_HIGH',
    possibleRootCauses: [
      'Pencatatan Waste/Susut/Trial tidak lengkap — banyak selisih tidak dijelaskan',
      'Pencurian stock — inventory hilang tanpa pencatatan',
      'Receiving discrepancy besar — barang masuk kurang dari catatan',
      'Salah hitung stock opname (FIFO/LIFO tidak konsisten)',
    ],
    recommendedActions: [
      'Stock opname ulang — verifikasi fisik vs sistem',
      'Audit penerimaan barang — rekonsiliasi PO vs GRN vs invoice',
      'Investigasi pola pencatatan — cek siapa yang input dan kapan',
      'Implementasi SOP pencatatan waste/susut/trial yang lebih ketat',
    ],
    severity: 'CRITICAL',
    category: 'INVENTORY',
  },

  RESIDUAL_LOSS_WARN: {
    ruleCode: 'RESIDUAL_LOSS_WARN',
    possibleRootCauses: [
      'Pencatatan waste/susut kurang detail — beberapa item tidak dijelaskan',
      'Variasi operasional normal yang belum tertangkap di SOC',
      'Proses pencatatan perlu improvement — training staff',
    ],
    recommendedActions: [
      'Review SOP pencatatan — pastikan semua kategori diinput',
      'Sampling waste — verifikasi konsistensi pencatatan vs actual',
      'Training staff pencatatan — tegaskan pentingnya akurasi',
    ],
    severity: 'MEDIUM',
    category: 'OPERATIONAL',
  },

  // ===== HIGH_LOSS_NOMINAL =====
  HIGH_LOSS_NOMINAL: {
    ruleCode: 'HIGH_LOSS_NOMINAL',
    possibleRootCauses: [
      'Item high-value dengan deviation kecil tapi nominal besar (price effect)',
      'Transaksi adjustment besar — perlu verifikasi approval',
      'Receiving discrepancy untuk item mahal (seafood, daging import)',
      'Possible pencurian — item mahal hilang dari inventory',
    ],
    recommendedActions: [
      'Audit transaksi adjustment — cek approval dan dokumentasi',
      'Verifikasi receiving untuk high-value items — bandingkan PO/GRN/invoice',
      'Stock opname khusus high-value items — lebih sering dari cycle count',
      'Cek CCTV area storage high-value items',
    ],
    severity: 'HIGH',
    category: 'INVENTORY',
  },

  // ===== SALES / BOM DEVIATION MISMATCH =====
  // Covers both spec naming (SALES_BOM_DEVIATION_MISMATCH / SALES_DEV_DEVIATION_MISMATCH)
  // and rules.yaml naming (BOM_DEVIATION_MISMATCH / SALES_DEVIATION_MISMATCH).
  SALES_BOM_DEVIATION_MISMATCH: {
    ruleCode: 'SALES_BOM_DEVIATION_MISMATCH',
    possibleRootCauses: [
      'BOM master tidak update — resep berubah tapi BOM belum di-update',
      'Sales naik karena promo/menu bundle tapi BOM per item tidak menyesuaikan',
      'Error formula BOM — perhitungan otomatis salah referensi',
      'Mix penjualan bergeser ke item dengan BOM ratio berbeda',
    ],
    recommendedActions: [
      'Rekonsiliasi BOM aktual vs sistem — update master BOM',
      'Audit formula Excel BOM — cek referensi cell & perhitungan',
      'Analisa sales mix — identifikasi pergeseran menu yang dampak BOM',
      'Verifikasi receiving & transfer — cari selisih kuantitas',
    ],
    severity: 'HIGH',
    category: 'OPERATIONAL',
  },

  SALES_DEV_DEVIATION_MISMATCH: {
    ruleCode: 'SALES_DEV_DEVIATION_MISMATCH',
    possibleRootCauses: [
      'Penjualan tercatat naik tapi deviation tidak ikut naik (data entry issue)',
      'Transaksi inventory adjustment besar yang tidak terkait sales',
      'Harga jual berubah tapi BOM/nominal tidak di-rekonsiliasi',
      'Receiving/transfer tidak tercatat — stock berubah tanpa transaksi',
    ],
    recommendedActions: [
      'Audit transaksi inventory adjustment — verifikasi approval',
      'Rekonsiliasi sales report vs inventory movement',
      'Cek perubahan harga jual — pastikan konsistensi dengan BOM nominal',
      'Investigasi receiving discrepancy — cari selisih kuantitas vs PO',
    ],
    severity: 'HIGH',
    category: 'DATA_QUALITY',
  },

  // ===== HISTORICAL ABNORMAL =====
  HISTORICAL_ABNORMAL_LOSS: {
    ruleCode: 'HISTORICAL_ABNORMAL_LOSS',
    possibleRootCauses: [
      'Lonjakan pemakaian yang tidak biasa — event/promo/operasional khusus',
      'Pencatatan salah di periode ini — data outlier',
      'Pencurian atau kehilangan stock yang signifikan',
      'Perubahan supplier — kualitas barang turun causing waste naik',
    ],
    recommendedActions: [
      'Bandingkan dengan periode event sebelumnya — validasi apakah wajar',
      'Stock opname lengkap — verifikasi fisik vs sistem',
      'Audit penerimaan dari supplier baru — cek kualitas & kuantitas',
      'Investigasi transaksi adjustment di periode tersebut',
    ],
    severity: 'CRITICAL',
    category: 'INVENTORY',
  },

  HISTORICAL_ABNORMAL_SURPLUS: {
    ruleCode: 'HISTORICAL_ABNORMAL_SURPLUS',
    possibleRootCauses: [
      'Over-receiving — barang diterima lebih dari catatan PO',
      'Pencatatan sales kurang — transaksi tidak tercatat semua',
      'Salah input BOM (terlalu tinggi) causing deviasi terlihat surplus',
      'Pencatatan waste/susut terlalu rendah — actual lebih tinggi',
    ],
    recommendedActions: [
      'Audit receiving — rekonsiliasi PO vs GRN vs invoice fisik',
      'Verifikasi sales report — bandingkan dengan POS/EDP',
      'Cek formula BOM — pastikan input sesuai resep aktual',
      'Sampling waste — pastikan pencatatan tidak understated',
    ],
    severity: 'HIGH',
    category: 'DATA_QUALITY',
  },

  HISTORICAL_WARNING: {
    ruleCode: 'HISTORICAL_WARNING',
    possibleRootCauses: [
      'Tren deviation naik secara bertahap — indikasi masalah operasional',
      'Pencatatan mulai tidak konsisten — perlu training ulang',
      'Perubahan supplier atau kualitas yang belum ter-confirm',
    ],
    recommendedActions: [
      'Monitor tren mingguan — pastikan tidak berlanjut menjadi abnormal',
      'Review proses operasional — identifikasi perubahan terbaru',
      'Training ulang staff pencatatan jika perlu',
    ],
    severity: 'MEDIUM',
    category: 'OPERATIONAL',
  },

  // ===== BENCHMARK =====
  BENCHMARK_ABOVE_AREA: {
    ruleCode: 'BENCHMARK_ABOVE_AREA',
    possibleRootCauses: [
      'Outlet berperforma di bawah peer area — prosedur operasional perlu improve',
      'Staff training gap — skill tidak setara dengan outlet lain di area',
      'Equipment issue — alat tidak optimal causing waste tinggi',
    ],
    recommendedActions: [
      'Benchmarking vs best-in-class outlet di area yang sama',
      'Training exchange — kirim staff ke outlet dengan performa terbaik',
      'Audit equipment — pastikan alat produksi optimal',
    ],
    severity: 'MEDIUM',
    category: 'OPERATIONAL',
  },

  BENCHMARK_ABOVE_NETWORK: {
    ruleCode: 'BENCHMARK_ABOVE_NETWORK',
    possibleRootCauses: [
      'Outlet outlier di network — masalah sistemik perlu investigasi',
      'Management/leadership issue di outlet tersebut',
      'Pencatatan consistently salah — perlu audit proses',
      'Kondisi lokal yang unik (demografi, kompetitor, supply chain)',
    ],
    recommendedActions: [
      'Audit lengkap outlet — operasional, pencatatan, dan management',
      'Bandingkan dengan top 3 outlet di network — identifikasi gap',
      'Investigasi kondisi lokal yang mungkin unik',
      'Action plan khusus dengan timeline perbaikan yang jelas',
    ],
    severity: 'HIGH',
    category: 'OPERATIONAL',
  },

  // ===== DIRECTION FLIP =====
  DIRECTION_FLIP: {
    ruleCode: 'DIRECTION_FLIP',
    possibleRootCauses: [
      'Perubahan prosedur stock opname — timing atau metodologi berubah',
      'Pencatatan salah — salah tanda (positive vs negative) di periode ini',
      'Perubahan supplier atau batch quality yang signifikan',
      'Adjustment besar di periode sebelumnya yang menyebabkan baseline bergeser',
    ],
    recommendedActions: [
      'Verifikasi prosedur stock opname — pastikan konsistensi antar periode',
      'Audit pencatatan periode ini — cek tanda positive/negative',
      'Rekonsiliasi adjustment periode sebelumnya — cari penyebab baseline shift',
      'Interview staff — konfirmasi tidak ada perubahan prosedur yang tidak terdokumentasi',
    ],
    severity: 'HIGH',
    category: 'DATA_QUALITY',
  },

  // ===== EXCESSIVE WASTE / SUSUT =====
  EXCESSIVE_WASTE: {
    ruleCode: 'EXCESSIVE_WASTE',
    possibleRootCauses: [
      'Kualitas bahan baku buruk — supplier issue causing waste tinggi',
      'Porsioning berlebih — staff tidak ikut SOP',
      'Storage tidak optimal — bahan cepat rusak sebelum dipakai',
      'Menu engineering issue — item slow-moving causing waste expired',
    ],
    recommendedActions: [
      'Audit kualitas supplier — sampling bahan baku yang masuk',
      'Training porsioning — pastikan staff pakai timbangan & SOP',
      'Review storage — pastikan FIFO, suhu, dan kelembapan optimal',
      'Analisa menu — pertimbangkan discontinued item slow-moving',
    ],
    severity: 'HIGH',
    category: 'PROCUREMENT',
  },

  EXCESSIVE_SUSUT: {
    ruleCode: 'EXCESSIVE_SUSUT',
    possibleRootCauses: [
      'Penyimpanan tidak optimal — kelembapan/suhu tidak sesuai',
      'Evaporasi/spillage karena container tidak sealed',
      'Salah pencatatan qty awal — overstatement causing susut terlihat tinggi',
      'Item dengan karakteristik high-shrinkage yang perlu handling khusus',
    ],
    recommendedActions: [
      'Audit storage — cek suhu, kelembapan, dan container seal',
      'Verifikasi pencatatan qty awal — pastikan akurat',
      'Identifikasi item high-shrinkage — buat handling procedure khusus',
      'Training staff storage — tegaskan FIFO dan container management',
    ],
    severity: 'MEDIUM',
    category: 'INVENTORY',
  },

  // ===== Aliases — actual rules.yaml codes (so engine works regardless of naming convention) =====
  SALES_DEVIATION_MISMATCH: {
    // Alias to SALES_DEV_DEVIATION_MISMATCH (spec uses different naming)
    ruleCode: 'SALES_DEVIATION_MISMATCH',
    possibleRootCauses: [
      'Penjualan tercatat naik tapi deviation tidak ikut naik (data entry issue)',
      'Transaksi inventory adjustment besar yang tidak terkait sales',
      'Harga jual berubah tapi BOM/nominal tidak di-rekonsiliasi',
      'Receiving/transfer tidak tercatat — stock berubah tanpa transaksi',
    ],
    recommendedActions: [
      'Audit transaksi inventory adjustment — verifikasi approval',
      'Rekonsiliasi sales report vs inventory movement',
      'Cek perubahan harga jual — pastikan konsistensi dengan BOM nominal',
      'Investigasi receiving discrepancy — cari selisih kuantitas vs PO',
    ],
    severity: 'HIGH',
    category: 'DATA_QUALITY',
  },

  BOM_DEVIATION_MISMATCH: {
    // Alias to SALES_BOM_DEVIATION_MISMATCH (spec uses different naming)
    ruleCode: 'BOM_DEVIATION_MISMATCH',
    possibleRootCauses: [
      'BOM master tidak update — resep berubah tapi BOM belum di-update',
      'Sales naik karena promo/menu bundle tapi BOM per item tidak menyesuaikan',
      'Error formula BOM — perhitungan otomatis salah referensi',
      'Mix penjualan bergeser ke item dengan BOM ratio berbeda',
    ],
    recommendedActions: [
      'Rekonsiliasi BOM aktual vs sistem — update master BOM',
      'Audit formula Excel BOM — cek referensi cell & perhitungan',
      'Analisa sales mix — identifikasi pergeseran menu yang dampak BOM',
      'Verifikasi receiving & transfer — cari selisih kuantitas',
    ],
    severity: 'HIGH',
    category: 'OPERATIONAL',
  },

  HISTORICAL_ABNORMAL: {
    // Alias to HISTORICAL_ABNORMAL_LOSS (rules.yaml uses 'HISTORICAL_ABNORMAL' for LOSS direction)
    ruleCode: 'HISTORICAL_ABNORMAL',
    possibleRootCauses: [
      'Lonjakan pemakauan yang tidak biasa — event/promo/operasional khusus',
      'Pencatatan salah di periode ini — data outlier',
      'Pencurian atau kehilangan stock yang signifikan',
      'Perubahan supplier — kualitas barang turun causing waste naik',
    ],
    recommendedActions: [
      'Bandingkan dengan periode event sebelumnya — validasi apakah wajar',
      'Stock opname lengkap — verifikasi fisik vs sistem',
      'Audit penerimaan dari supplier baru — cek kualitas & kuantitas',
      'Investigasi transaksi adjustment di periode tersebut',
    ],
    severity: 'CRITICAL',
    category: 'INVENTORY',
  },
};

// ============================================================
//  getRootCauses — look up mappings for a list of rule codes.
//  - Deduplicates input
//  - Preserves input order (first occurrence wins)
//  - Skips unknown rule codes (returns only matched mappings)
// ============================================================
export function getRootCauses(ruleCodes: string[]): RootCauseMapping[] {
  const seen = new Set<string>();
  const results: RootCauseMapping[] = [];
  for (const code of ruleCodes) {
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const mapping = ROOT_CAUSE_MAPPINGS[code];
    if (mapping) {
      results.push(mapping);
    }
  }
  return results;
}

// ============================================================
//  Helper — get a single root cause mapping (or null if unknown)
// ============================================================
export function getRootCause(ruleCode: string): RootCauseMapping | null {
  return ROOT_CAUSE_MAPPINGS[ruleCode] ?? null;
}

// ============================================================
//  Helper — list all known rule codes (for UI dropdowns / debugging)
// ============================================================
export function listKnownRuleCodes(): string[] {
  return Object.keys(ROOT_CAUSE_MAPPINGS);
}
