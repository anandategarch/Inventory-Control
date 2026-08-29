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

// ============================================================
//  Settings cache — DISABLED on serverless (Vercel)
//  In-memory cache is per-instance: when user changes a setting,
//  invalidateSettingsCache() only clears the CURRENT instance's cache.
//  Other instances still return stale values for up to CACHE_TTL_MS.
//
//  FIX (BUG6-POOL): Re-enabled cache with 30s TTL. Previously CACHE_TTL_MS=0
//  (disabled) meant EVERY getRuntimeThresholds() call hit the DB — that's
//  1 extra DB connection per /api/analysis request, contributing to pool
//  exhaustion. Settings table is tiny (20 rows) and rarely changes.
//  invalidateSettingsCache() is called on POST/DELETE /api/settings.
// ============================================================
let _settingsCache: Map<string, string> | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds — settings rarely change

async function loadSettingsFromDB(): Promise<Map<string, string>> {
  const settings = await db.setting.findMany({ select: { key: true, value: true } });
  const map = new Map<string, string>();
  for (const s of settings) {
    map.set(s.key, s.value);
  }
  return map;
}

// Initialize default settings on first run
// FIX (BUG-2-5): Previously, `count > 0` early-return meant that any
// missing setting row (deleted, or new key added in a code release) was
// never re-inserted. Now we always attempt to create missing rows and let
// `skipDuplicates: true` skip the ones that already exist.
//
// FIX (BUG2-INGEST-5): ensureDefaultSettings does a write (createMany) on
// every call. getAllSettings calls this on EVERY dashboard request → write-
// lock contention on the Setting table under concurrent load. Add a module-
// level flag so the write only happens once per process (cold start in
// serverless). Warm invocations skip the write entirely. If a new setting
// key is added in a code release, the next cold start (server restart /
// new serverless instance) will re-run ensureDefaultSettings and insert it.
// Note: the Settings UI (settings/route.ts) and POST/DELETE routes use
// upsert (not delete), so default rows are never removed by the app — the
// flag stays valid for the entire process lifetime.
let _defaultsEnsured = false;

export async function ensureDefaultSettings(): Promise<void> {
  // FIX (BUG2-INGEST-5): Skip the write if defaults were already ensured in
  // this process. The Setting table is tiny (32 rows) and skipDuplicates
  // would be a no-op anyway, but the write lock acquisition is the real
  // cost under concurrent load. Skipping eliminates the lock contention.
  if (_defaultsEnsured) return;

  const data = SETTING_DEFINITIONS.map((d) => ({
    key: d.key,
    value: d.defaultValue,
    category: d.category,
    label: d.label,
    description: d.description,
    dataType: d.dataType,
  }));

  // FIX: `skipDuplicates: true` is PostgreSQL-only (not supported in SQLite).
  // Use try/catch to handle both providers — on SQLite, fallback to per-row upsert.
  try {
    await db.setting.createMany({ data, skipDuplicates: true });
  } catch {
    // SQLite fallback — upsert each setting individually
    for (const d of data) {
      await db.setting.upsert({
        where: { key: d.key },
        update: {},
        create: d,
      }).catch(() => {});
    }
  }
  _settingsCache = null; // force reload
  _defaultsEnsured = true; // mark as initialized for this process
}

// Get all settings (merged: DB overrides defaults)
// FIX (BUG6-POOL): Re-enabled cache with 30s TTL to avoid DB hit on every request.
export async function getAllSettings(forceRefresh = false): Promise<Map<string, string>> {
  // Check cache first (unless forceRefresh)
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

  // Update cache
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
  // FIX (FIX-SETTINGS / BUG-BOM-EVAL-03): configurable threshold for the
  // BOM_DEVIATION_DISPROPORTIONATE rule (decoupled from BOM_DEVIATION_FACTOR).
  BOM_DISPROPORTIONATE_FACTOR: number;
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
  // FIX (AUDIT8-ROLLBACK-1, Item 15): configurable via Settings (was hardcoded 30).
  TOP_N_DEVIASI_RANK: number;
  HIGH_LOSS_NOMINAL_THRESHOLD: number;
  P2_NOMINAL_THRESHOLD: number;
  HEALTH_WEIGHT_DEV_BOM: number;
  HEALTH_WEIGHT_RESIDUAL: number;
  HEALTH_WEIGHT_LOSS_TO_SALES: number;
  HEALTH_WEIGHT_ABNORMAL: number;
  // P2 fix: Health Score thresholds (configurable via Settings)
  HEALTH_THRESH_DEV_BOM_GOOD: number;
  HEALTH_THRESH_DEV_BOM_BAD: number;
  HEALTH_THRESH_RESIDUAL_GOOD: number;
  HEALTH_THRESH_RESIDUAL_BAD: number;
  HEALTH_THRESH_LOSS_TO_SALES_GOOD: number;
  HEALTH_THRESH_LOSS_TO_SALES_BAD: number;
  HEALTH_THRESH_ABNORMAL_GOOD: number;
  HEALTH_THRESH_ABNORMAL_BAD: number;
}

export async function getRuntimeThresholds(): Promise<RuntimeThresholds> {
  const all = await getAllSettings();
  // FIX (BUG-2-4): Treat empty/whitespace strings as fallback.
  // `Number('') === 0`, so previously a cleared HISTORICAL_MIN_WEEKS
  // became 0 (bypassing the min-weeks guard). Now it returns the default.
  const num = (key: string, fallback: number): number => {
    const v = all.get(key);
    if (v == null || String(v).trim() === '') return fallback;
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
    // FIX (FIX-SETTINGS / BUG-BOM-EVAL-03): decoupled disproportionate
    // threshold (default 1.5×). SQL rule evaluator consumes via
    // thresholds.BOM_DISPROPORTIONATE_FACTOR — replaces hardcoded 1.5.
    BOM_DISPROPORTIONATE_FACTOR: num('BOM_DISPROPORTIONATE_FACTOR', 1.5),
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
    // FIX (AUDIT8-ROLLBACK-1, Item 15): read from Settings (fallback 30 matches
    // the previous hardcoded value in outlet-items/route.ts).
    TOP_N_DEVIASI_RANK: num('TOP_N_DEVIASI_RANK', 30),
    HIGH_LOSS_NOMINAL_THRESHOLD: num('HIGH_LOSS_NOMINAL_THRESHOLD', 50_000_000),
    P2_NOMINAL_THRESHOLD: num('P2_NOMINAL_THRESHOLD', 10_000_000),
    HEALTH_WEIGHT_DEV_BOM: num('HEALTH_WEIGHT_DEV_BOM', 30),
    HEALTH_WEIGHT_RESIDUAL: num('HEALTH_WEIGHT_RESIDUAL', 25),
    HEALTH_WEIGHT_LOSS_TO_SALES: num('HEALTH_WEIGHT_LOSS_TO_SALES', 25),
    HEALTH_WEIGHT_ABNORMAL: num('HEALTH_WEIGHT_ABNORMAL', 20),
    HEALTH_THRESH_DEV_BOM_GOOD: num('HEALTH_THRESH_DEV_BOM_GOOD', 0.05),
    HEALTH_THRESH_DEV_BOM_BAD: num('HEALTH_THRESH_DEV_BOM_BAD', 0.50),
    HEALTH_THRESH_RESIDUAL_GOOD: num('HEALTH_THRESH_RESIDUAL_GOOD', 0.20),
    HEALTH_THRESH_RESIDUAL_BAD: num('HEALTH_THRESH_RESIDUAL_BAD', 0.80),
    HEALTH_THRESH_LOSS_TO_SALES_GOOD: num('HEALTH_THRESH_LOSS_TO_SALES_GOOD', 0.02),
    HEALTH_THRESH_LOSS_TO_SALES_BAD: num('HEALTH_THRESH_LOSS_TO_SALES_BAD', 0.15),
    HEALTH_THRESH_ABNORMAL_GOOD: num('HEALTH_THRESH_ABNORMAL_GOOD', 0.0),
    HEALTH_THRESH_ABNORMAL_BAD: num('HEALTH_THRESH_ABNORMAL_BAD', 0.50),
  };
}
