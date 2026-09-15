// ============================================================
//  Settings Store — cache + DB persistence + default bootstrap
//  ----------------------------------------------------------
//  Loads settings from DB (fallback to defaults), keeps the
//  30s in-memory cache, and ensures default rows exist.
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/settings.ts (old file deleted; '@/lib/settings' now
//  resolves to this folder's index.ts barrel — same import path).
// ============================================================
import { db } from '@/lib/db';
import { SETTING_DEFINITIONS } from './definitions';

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
