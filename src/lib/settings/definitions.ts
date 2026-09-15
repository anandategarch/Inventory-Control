// ============================================================
//  Settings Definitions — the settings catalog
//  ----------------------------------------------------------
//  What each setting means & its default value. Edit this list
//  to add new configurable settings.
//  Categories: TOLERANCE | GROWTH | PRIORITY | BENCHMARK | GENERAL
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/settings.ts (old file deleted; '@/lib/settings' now
//  resolves to this folder's index.ts barrel — same import path).
// ============================================================
export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  category: 'TOLERANCE' | 'GROWTH' | 'PRIORITY' | 'BENCHMARK' | 'GENERAL';
  dataType: 'number' | 'percent' | 'boolean' | 'text';
  defaultValue: string;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  // ===== TOLERANCE (standar maksimal deviasi yang diperbolehkan) =====
  {
    key: 'STD_SUSUT_PCT',
    label: 'Batas Maksimal Susut',
    description: 'Persentase maksimal susut yang dianggap wajar (mis. 0.10 = 10%). Melebihi ini akan ditandai sebagai peringatan.',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.10',
  },
  {
    key: 'STD_WASTE_PCT',
    label: 'Batas Maksimal Waste',
    description: 'Persentase maksimal waste yang dianggap wajar (mis. 0.05 = 5%).',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.05',
  },
  {
    key: 'STD_TRIAL_PCT',
    label: 'Batas Maksimal Trial',
    description: 'Persentase maksimal trial yang dianggap wajar (mis. 0.03 = 3%).',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.03',
  },
  {
    key: 'STD_DEVIASI_BOM_PCT',
    label: 'Batas Maksimal Deviasi/BOM',
    description: 'Persentase maksimal deviasi terhadap BOM yang dianggap wajar (mis. 0.05 = 5%).',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.05',
  },
  {
    key: 'FALLBACK_TOLERANCE_PCT',
    label: 'Toleransi Default (jika belum diset di data)',
    description: 'Persentase toleransi yang dipakai jika kolom %TOLERANSI di Excel berisi "BELUM ADA TOLERANSI".',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.05',
  },

  // ===== GROWTH (deteksi mismatch pertumbuhan) =====
  {
    key: 'SALES_DEVIATION_FACTOR',
    label: 'Faktor Deteksi Sales vs Deviasi',
    description: 'Deviasi dianggap abnormal jika pertumbuhannya > faktor ini × pertumbuhan sales. Mis. 2.0 = deviasi naik 2x lebih cepat dari sales.',
    category: 'GROWTH',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'BOM_DEVIATION_FACTOR',
    label: 'Faktor Deteksi BOM vs Deviasi',
    description: 'Deviasi dianggap abnormal jika pertumbuhannya > faktor ini × pertumbuhan BOM.',
    category: 'GROWTH',
    dataType: 'number',
    defaultValue: '2.0',
  },
  // FIX (FIX-SETTINGS / BUG-BOM-EVAL-03): New configurable threshold for the
  // BOM_DEVIATION_DISPROPORTIONATE rule. Previously the rule-evaluation SQL
  // hardcoded a 1.5× upper-bound coupled to BOM_DEVIATION_FACTOR — meaning
  // if a user lowered BOM_DEVIATION_FACTOR ≤ 1.5, the disproportionate rule
  // silently never fired (lower bound > upper bound). Decoupling to its own
  // setting fixes that. Range 1.0–5.0, default 1.5×.
  {
    key: 'BOM_DISPROPORTIONATE_FACTOR',
    label: 'Faktor Disproporsional BOM',
    description: 'Rasio pertumbuhan deviasi vs BOM untuk memicu rule BOM_DEVIATION_DISPROPORTIONATE (default: 1.5×, artinya deviasi tumbuh 1.5× lebih cepat dari BOM). Range 1.0–5.0.',
    category: 'GROWTH',
    dataType: 'number',
    defaultValue: '1.5',
  },
  {
    key: 'RESIDUAL_LOSS_WARN_PCT',
    label: 'Ambang Peringatan Residual (%)',
    description: 'Persentase residual loss dari total deviasi untuk ditandai sebagai peringatan (mis. 0.50 = 50%).',
    category: 'GROWTH',
    dataType: 'percent',
    defaultValue: '0.50',
  },
  {
    key: 'RESIDUAL_LOSS_HIGH_PCT',
    label: 'Ambang Kritis Residual (%)',
    description: 'Persentase residual loss dari total deviasi untuk ditandai sebagai abnormal/kritis (mis. 0.70 = 70%).',
    category: 'GROWTH',
    dataType: 'percent',
    defaultValue: '0.70',
  },

  // ===== BENCHMARK (perbandingan antar outlet) =====
  {
    key: 'BENCHMARK_AREA_FACTOR',
    label: 'Faktor Benchmark Area',
    description: 'Outlet dianggap abnormal jika Dev/BOM > faktor ini × rata-rata area (mis. 1.5 = 1.5x rata-rata area).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '1.5',
  },
  {
    key: 'BENCHMARK_NETWORK_FACTOR',
    label: 'Faktor Benchmark Network',
    description: 'Outlet dianggap abnormal jika Dev/BOM > faktor ini × rata-rata seluruh outlet (mis. 2.0 = 2x rata-rata network).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'HISTORICAL_ZSCORE_WARN',
    label: 'Z-Score Historical - Peringatan',
    description: 'Nilai Z-Score minimum untuk ditandai sebagai peringatan (abnormal vs pola historical). Mis. 1.5.',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '1.5',
  },
  {
    key: 'HISTORICAL_ZSCORE_HIGH',
    label: 'Z-Score Historical - Kritis',
    description: 'Nilai Z-Score minimum untuk ditandai sebagai abnormal/kritis (jauh dari rata-rata historical). Mis. 2.0.',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'HISTORICAL_MIN_WEEKS',
    label: 'Min. Minggu untuk Benchmark Historical',
    description: 'Jumlah minggu minimum untuk menghitung benchmark historical (di bawah ini, Z-Score tidak dihitung).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '4',
  },
  // CHANGE-1 ("Rata-rata Perubahan"): outlet movement vs its own average
  // same-week movement — the lens "Perubahan" on the dashboard.
  {
    key: 'CHANGE_ANOMALY_RATIO',
    label: 'Faktor Anomali Perubahan',
    description: 'Perubahan deviasi periode berjalan dianggap ANOMALI jika ≥ faktor ini × rata-rata gerak resto itu sendiri (rata-rata perubahan antar periode, same-week). Mis. 2.0 = bergerak 2× dari kebiasaannya.',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'CHANGE_MIN_PAIRS',
    label: 'Min. Pasangan Perubahan',
    description: 'Jumlah pasangan periode (same-week antar bulan) minimum sebelum rasio perubahan sebuah resto dinilai. Di bawah ini resto ditandai "riwayat kurang".',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '4',
  },
  {
    key: 'CHANGE_MIN_NOMINAL',
    label: 'Min. Nominal Gerak (IDR)',
    description: 'Gerakan nominal minimum (Rp) agar perubahan dianggap signifikan — mencegah rasio besar dari gerakan receh (mis. 100000 = Rp 100rb).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '100000',
  },

  // ===== PRIORITY (scoring weight) =====
  {
    key: 'WEIGHT_DEV_BOM',
    label: 'Bobot Dev/BOM',
    description: 'Bobot untuk rasio Deviation/BOM dalam perhitungan operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '30',
  },
  {
    key: 'WEIGHT_GROWTH',
    label: 'Bobot Pertumbuhan',
    description: 'Bobot untuk growth mismatch dalam perhitungan operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '25',
  },
  {
    key: 'WEIGHT_RESIDUAL',
    label: 'Bobot Residual',
    description: 'Bobot untuk residual loss dalam perhitungan operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '20',
  },
  {
    key: 'WEIGHT_TOLERANCE',
    label: 'Bobot Pelanggaran Toleransi',
    description: 'Bobot untuk pelanggaran toleransi dalam perhitungan operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '15',
  },
  {
    key: 'WEIGHT_HISTORY',
    label: 'Bobot Historical',
    description: 'Bobot untuk Z-Score historical dalam perhitungan operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '10',
  },

  // ===== GENERAL =====
  {
    key: 'TOP_N_ITEMS',
    label: 'Jumlah Item di Top Ranking',
    description: 'Jumlah item yang ditampilkan di Top Items (by Nominal, by Dev/BOM, dst).',
    category: 'GENERAL',
    dataType: 'number',
    defaultValue: '10',
  },
  {
    key: 'TOP_N_OUTLETS',
    label: 'Jumlah Outlet di Top Ranking',
    description: 'Jumlah outlet yang ditampilkan di Top Outlets.',
    category: 'GENERAL',
    dataType: 'number',
    defaultValue: '10',
  },
  // FIX (AUDIT8-ROLLBACK-1, Item 15): TOP_N_DEVIASI_RANK was hardcoded to 30
  // in outlet-items/route.ts. Adding as a Settings-configurable value so the
  // RankingNasionalCard row count can be tuned without a code change. Default
  // 30 matches the previous hardcoded value.
  {
    key: 'TOP_N_DEVIASI_RANK',
    label: 'Jumlah Item di Top Deviasi Rank (per Outlet)',
    description: 'Jumlah item yang ditampilkan di RankingNasionalCard untuk setiap outlet (top items by |nominalDeviasi|). Default 30.',
    category: 'GENERAL',
    dataType: 'number',
    defaultValue: '30',
  },
  {
    key: 'HIGH_LOSS_NOMINAL_THRESHOLD',
    label: 'Threshold Nominal Loss Tinggi (IDR) — P1',
    description: 'Nominal loss di atas ini akan ditandai sebagai P1 (critical). Default 50 juta sesuai master rule.',
    category: 'TOLERANCE',
    dataType: 'number',
    defaultValue: '50000000',
  },
  {
    key: 'P2_NOMINAL_THRESHOLD',
    label: 'Threshold Nominal Loss Sedang (IDR) — P2',
    description: 'Nominal loss di atas ini (tapi di bawah P1 threshold) akan ditandai sebagai P2 (warning). Default 10 juta sesuai master rule.',
    category: 'TOLERANCE',
    dataType: 'number',
    defaultValue: '10000000',
  },
  {
    key: 'HEALTH_WEIGHT_DEV_BOM',
    label: 'Bobot Dev/BOM untuk Health Score',
    description: 'Bobot Dev/BOM dalam health score (default 30). Total bobot akan dinormalisasi.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '30',
  },
  {
    key: 'HEALTH_WEIGHT_RESIDUAL',
    label: 'Bobot Residual untuk Health Score',
    description: 'Bobot Residual dalam health score (default 25).',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '25',
  },
  {
    key: 'HEALTH_WEIGHT_LOSS_TO_SALES',
    label: 'Bobot Loss/Sales untuk Health Score',
    description: 'Bobot Loss/Sales dalam health score (default 25).',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '25',
  },
  {
    key: 'HEALTH_WEIGHT_ABNORMAL',
    label: 'Bobot Abnormal untuk Health Score',
    description: 'Bobot Abnormal count dalam health score (default 20).',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '20',
  },
  {
    key: 'HEALTH_THRESH_DEV_BOM_GOOD',
    label: 'Health Threshold Dev/BOM — Sehat',
    description: 'Dev/BOM di bawah ini = skor 100 (sehat). Default 0.05 (5%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.05',
  },
  {
    key: 'HEALTH_THRESH_DEV_BOM_BAD',
    label: 'Health Threshold Dev/BOM — Kritis',
    description: 'Dev/BOM di atas ini = skor 0 (kritis). Default 0.50 (50%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.50',
  },
  {
    key: 'HEALTH_THRESH_RESIDUAL_GOOD',
    label: 'Health Threshold Residual — Sehat',
    description: 'Residual % di bawah ini = skor 100. Default 0.20 (20%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.20',
  },
  {
    key: 'HEALTH_THRESH_RESIDUAL_BAD',
    label: 'Health Threshold Residual — Kritis',
    description: 'Residual % di atas ini = skor 0. Default 0.80 (80%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.80',
  },
  {
    key: 'HEALTH_THRESH_LOSS_TO_SALES_GOOD',
    label: 'Health Threshold Loss/Sales — Sehat',
    description: 'Loss/Sales di bawah ini = skor 100. Default 0.02 (2%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.02',
  },
  {
    key: 'HEALTH_THRESH_LOSS_TO_SALES_BAD',
    label: 'Health Threshold Loss/Sales — Kritis',
    description: 'Loss/Sales di atas ini = skor 0. Default 0.15 (15%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.15',
  },
  {
    key: 'HEALTH_THRESH_ABNORMAL_GOOD',
    label: 'Health Threshold Abnormal Rate — Sehat',
    description: 'Abnormal rate di bawah ini = skor 100. Default 0.0 (0%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.0',
  },
  {
    key: 'HEALTH_THRESH_ABNORMAL_BAD',
    label: 'Health Threshold Abnormal Rate — Kritis',
    description: 'Abnormal rate di atas ini = skor 0. Default 0.50 (50%).',
    category: 'BENCHMARK',
    dataType: 'percent',
    defaultValue: '0.50',
  },
];
