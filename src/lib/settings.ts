// ============================================================
//  Settings Manager — load settings from DB, fallback to defaults
// ============================================================
import { db } from '@/lib/db';

// ============================================================
//  Setting definitions — what each setting means & default value
//  Edit this list to add new configurable settings.
//  Categories: TOLERANCE | GROWTH | PRIORITY | BENCHMARK | GENERAL
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
  {
    key: 'HIGH_LOSS_NOMINAL_THRESHOLD',
    label: 'Threshold Nominal Loss Tinggi (IDR)',
    description: 'Nominal loss di atas ini akan ditandai sebagai HIGH_LOSS_NOMINAL. Dalam Rupiah.',
    category: 'TOLERANCE',
    dataType: 'number',
    defaultValue: '1000000',
  },
];

// ============================================================
//  Settings cache — DISABLED on serverless (Vercel)
//  In-memory cache is per-instance: when user changes a setting,
//  invalidateSettingsCache() only clears the CURRENT instance's cache.
//  Other instances still return stale values for up to 30s.
//  Fix: always read from DB (Setting table is tiny — 20 rows, <5ms).
// ============================================================
let _settingsCache: Map<string, string> | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 0; // 0 = disabled (always read from DB)

async function loadSettingsFromDB(): Promise<Map<string, string>> {
  const settings = await db.setting.findMany({ select: { key: true, value: true } });
  const map = new Map<string, string>();
  for (const s of settings) {
    map.set(s.key, s.value);
  }
  return map;
}

// Initialize default settings on first run
export async function ensureDefaultSettings(): Promise<void> {
  const count = await db.setting.count();
  if (count > 0) return; // already initialized

  const data = SETTING_DEFINITIONS.map((d) => ({
    key: d.key,
    value: d.defaultValue,
    category: d.category,
    label: d.label,
    description: d.description,
    dataType: d.dataType,
  }));

  await db.setting.createMany({ data });
  _settingsCache = null; // force reload
}

// Get all settings (merged: DB overrides defaults)
// NOTE: cache disabled (CACHE_TTL_MS = 0) — always reads from DB
// to ensure consistency across Vercel serverless instances.
export async function getAllSettings(forceRefresh = false): Promise<Map<string, string>> {
  // Cache disabled — always read from DB
  await ensureDefaultSettings();
  const dbSettings = await loadSettingsFromDB();

  // Merge: start with defaults, override with DB values
  const merged = new Map<string, string>();
  for (const def of SETTING_DEFINITIONS) {
    merged.set(def.key, dbSettings.get(def.key) ?? def.defaultValue);
  }

  return merged;
}

// Get a single setting as string
export async function getSetting(key: string): Promise<string | null> {
  const all = await getAllSettings();
  return all.get(key) ?? null;
}

// Get setting as number
export async function getSettingNumber(key: string): Promise<number | null> {
  const v = await getSetting(key);
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Get setting as boolean
export async function getSettingBool(key: string): Promise<boolean> {
  const v = await getSetting(key);
  return v === 'true' || v === '1' || v === 'yes';
}

// Invalidate cache (call after update)
export function invalidateSettingsCache(): void {
  _settingsCache = null;
  _thresholdsVersionCache = null; // Phase 3: invalidate version cache too
}

// ============================================================
//  thresholdsVersion — cache DISABLED on serverless (same per-instance issue)
// ============================================================
let _thresholdsVersionCache: number | null = null;
let _thresholdsVersionAt = 0;
const VERSION_CACHE_TTL_MS = 0; // 0 = disabled (always read from DB)

export async function getThresholdsVersion(): Promise<number> {
  // Cache disabled — always read from DB for consistency across instances
  return await db.setting.count();
}

// ============================================================
//  Convenience: get all thresholds as object (for engine use)
// ============================================================
export interface RuntimeThresholds {
  STD_SUSUT_PCT: number;
  STD_WASTE_PCT: number;
  STD_TRIAL_PCT: number;
  STD_DEVIASI_BOM_PCT: number;
  FALLBACK_TOLERANCE_PCT: number;
  SALES_DEVIATION_FACTOR: number;
  BOM_DEVIATION_FACTOR: number;
  RESIDUAL_LOSS_WARN_PCT: number;
  RESIDUAL_LOSS_HIGH_PCT: number;
  BENCHMARK_AREA_FACTOR: number;
  BENCHMARK_NETWORK_FACTOR: number;
  HISTORICAL_ZSCORE_WARN: number;
  HISTORICAL_ZSCORE_HIGH: number;
  HISTORICAL_MIN_WEEKS: number;
  WEIGHT_DEV_BOM: number;
  WEIGHT_GROWTH: number;
  WEIGHT_RESIDUAL: number;
  WEIGHT_TOLERANCE: number;
  WEIGHT_HISTORY: number;
  TOP_N_ITEMS: number;
  TOP_N_OUTLETS: number;
  HIGH_LOSS_NOMINAL_THRESHOLD: number;
}

export async function getRuntimeThresholds(): Promise<RuntimeThresholds> {
  const all = await getAllSettings();
  const num = (key: string, fallback: number): number => {
    const v = all.get(key);
    if (v == null) return fallback;
    const n = Number(v);
    return isNaN(n) ? fallback : n;
  };
  return {
    STD_SUSUT_PCT: num('STD_SUSUT_PCT', 0.10),
    STD_WASTE_PCT: num('STD_WASTE_PCT', 0.05),
    STD_TRIAL_PCT: num('STD_TRIAL_PCT', 0.03),
    STD_DEVIASI_BOM_PCT: num('STD_DEVIASI_BOM_PCT', 0.05),
    FALLBACK_TOLERANCE_PCT: num('FALLBACK_TOLERANCE_PCT', 0.05),
    SALES_DEVIATION_FACTOR: num('SALES_DEVIATION_FACTOR', 2.0),
    BOM_DEVIATION_FACTOR: num('BOM_DEVIATION_FACTOR', 2.0),
    RESIDUAL_LOSS_WARN_PCT: num('RESIDUAL_LOSS_WARN_PCT', 0.50),
    RESIDUAL_LOSS_HIGH_PCT: num('RESIDUAL_LOSS_HIGH_PCT', 0.70),
    BENCHMARK_AREA_FACTOR: num('BENCHMARK_AREA_FACTOR', 1.5),
    BENCHMARK_NETWORK_FACTOR: num('BENCHMARK_NETWORK_FACTOR', 2.0),
    HISTORICAL_ZSCORE_WARN: num('HISTORICAL_ZSCORE_WARN', 1.5),
    HISTORICAL_ZSCORE_HIGH: num('HISTORICAL_ZSCORE_HIGH', 2.0),
    HISTORICAL_MIN_WEEKS: num('HISTORICAL_MIN_WEEKS', 4),
    WEIGHT_DEV_BOM: num('WEIGHT_DEV_BOM', 30),
    WEIGHT_GROWTH: num('WEIGHT_GROWTH', 25),
    WEIGHT_RESIDUAL: num('WEIGHT_RESIDUAL', 20),
    WEIGHT_TOLERANCE: num('WEIGHT_TOLERANCE', 15),
    WEIGHT_HISTORY: num('WEIGHT_HISTORY', 10),
    TOP_N_ITEMS: num('TOP_N_ITEMS', 10),
    TOP_N_OUTLETS: num('TOP_N_OUTLETS', 10),
    HIGH_LOSS_NOMINAL_THRESHOLD: num('HIGH_LOSS_NOMINAL_THRESHOLD', 1_000_000),
  };
}
