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
    label: 'Standar Susut Maksimal',
    description: 'Persentase maksimal susut yang dianggap wajar (mis. 10% = 0.10). Melebihi ini akan ditandai WARNING.',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.10',
  },
  {
    key: 'STD_WASTE_PCT',
    label: 'Standar Waste Maksimal',
    description: 'Persentase maksimal waste yang dianggap wajar.',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.05',
  },
  {
    key: 'STD_TRIAL_PCT',
    label: 'Standar Trial Maksimal',
    description: 'Persentase maksimal trial yang dianggap wajar.',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.03',
  },
  {
    key: 'STD_DEVIASI_BOM_PCT',
    label: 'Standar Deviasi/BOM Maksimal',
    description: 'Persentase maksimal deviation/BOM yang dianggap wajar (overall).',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.05',
  },
  {
    key: 'FALLBACK_TOLERANCE_PCT',
    label: 'Tolerance Fallback (jika belum diset di data)',
    description: 'Persentase tolerance yang dipakai jika kolom %TOLERANSI di Excel berisi "BELUM ADA TOLERANSI".',
    category: 'TOLERANCE',
    dataType: 'percent',
    defaultValue: '0.05',
  },

  // ===== GROWTH (deteksi mismatch pertumbuhan) =====
  {
    key: 'SALES_DEVIATION_FACTOR',
    label: 'Faktor Sales vs Deviasi Mismatch',
    description: 'Deviasi growth dianggap abnormal jika > faktor ini × Sales growth. Mis. 2.0 = deviasi naik 2x lebih cepat dari sales.',
    category: 'GROWTH',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'BOM_DEVIATION_FACTOR',
    label: 'Faktor BOM vs Deviasi Mismatch',
    description: 'Deviasi growth dianggap abnormal jika > faktor ini × BOM growth.',
    category: 'GROWTH',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'RESIDUAL_LOSS_WARN_PCT',
    label: 'Residual Loss Warning (%)',
    description: 'Persentase residual loss dari total deviation untuk flag WARNING.',
    category: 'GROWTH',
    dataType: 'percent',
    defaultValue: '0.50',
  },
  {
    key: 'RESIDUAL_LOSS_HIGH_PCT',
    label: 'Residual Loss Abnormal (%)',
    description: 'Persentase residual loss dari total deviation untuk flag ABNORMAL.',
    category: 'GROWTH',
    dataType: 'percent',
    defaultValue: '0.70',
  },

  // ===== BENCHMARK (perbandingan antar outlet) =====
  {
    key: 'BENCHMARK_AREA_FACTOR',
    label: 'Faktor Benchmark Area (vs rata-rata area)',
    description: 'Outlet dianggap abnormal jika Dev/BOM > faktor ini × rata-rata area.',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '1.5',
  },
  {
    key: 'BENCHMARK_NETWORK_FACTOR',
    label: 'Faktor Benchmark Network (vs semua outlet)',
    description: 'Outlet dianggap abnormal jika Dev/BOM > faktor ini × rata-rata network.',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'HISTORICAL_ZSCORE_WARN',
    label: 'Z-Score Historical Warning',
    description: 'Z-score minimum untuk flag WARNING (abnormal vs historical).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '1.5',
  },
  {
    key: 'HISTORICAL_ZSCORE_HIGH',
    label: 'Z-Score Historical Abnormal',
    description: 'Z-score minimum untuk flag ABNORMAL (jauh dari historical average).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '2.0',
  },
  {
    key: 'HISTORICAL_MIN_WEEKS',
    label: 'Min Weeks untuk Historical Benchmark',
    description: 'Jumlah minggu minimum untuk menghitung benchmark historical (di bawah ini, skip z-score).',
    category: 'BENCHMARK',
    dataType: 'number',
    defaultValue: '4',
  },

  // ===== PRIORITY (scoring weight) =====
  {
    key: 'WEIGHT_DEV_BOM',
    label: 'Bobot Dev/BOM (Operational Score)',
    description: 'Bobot untuk Deviation/BOM ratio dalam operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '30',
  },
  {
    key: 'WEIGHT_GROWTH',
    label: 'Bobot Growth (Operational Score)',
    description: 'Bobot untuk growth mismatch dalam operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '25',
  },
  {
    key: 'WEIGHT_RESIDUAL',
    label: 'Bobot Residual (Operational Score)',
    description: 'Bobot untuk residual loss dalam operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '20',
  },
  {
    key: 'WEIGHT_TOLERANCE',
    label: 'Bobot Tolerance Breach (Operational Score)',
    description: 'Bobot untuk tolerance breach dalam operational priority score.',
    category: 'PRIORITY',
    dataType: 'number',
    defaultValue: '15',
  },
  {
    key: 'WEIGHT_HISTORY',
    label: 'Bobot Historical (Operational Score)',
    description: 'Bobot untuk z-score historical dalam operational priority score.',
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
//  In-memory cache (avoid hitting DB every analysis request)
// ============================================================
let _settingsCache: Map<string, string> | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

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
export async function getAllSettings(forceRefresh = false): Promise<Map<string, string>> {
  if (!forceRefresh && _settingsCache && (Date.now() - _cacheLoadedAt) < CACHE_TTL_MS) {
    return _settingsCache;
  }

  await ensureDefaultSettings();
  const dbSettings = await loadSettingsFromDB();

  // Merge: start with defaults, override with DB values
  const merged = new Map<string, string>();
  for (const def of SETTING_DEFINITIONS) {
    merged.set(def.key, dbSettings.get(def.key) ?? def.defaultValue);
  }

  _settingsCache = merged;
  _cacheLoadedAt = Date.now();
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
