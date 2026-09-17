// ============================================================
//  /api/settings — CRUD for user-configurable settings
//  GET  : list all settings with definitions
//  POST : bulk update settings { values: { key: value, ... } }
//  DELETE : reset to defaults (?key=specific or all)
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  SETTING_DEFINITIONS,
  ensureDefaultSettings,
  getAllSettings,
  invalidateSettingsCache,
  type SettingDefinition,
} from '@/lib/settings';
import { invalidateAnalysisCache } from '@/lib/aggregation-cache';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import { validateBody, settingsUpdateSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

// ============================================================
//  FIX (BUG-3-c R-7): per-key numeric ranges for Settings values.
//  dataType 'number' previously accepted ANY finite number — e.g.
//  HISTORICAL_MIN_WEEKS=0 silently disabled the min-weeks guard (the
//  historical benchmark then computed Z-scores against 0 baseline
//  weeks), TOP_N_ITEMS=100000 ballooned every top-N query, and negative
//  weights inverted rankings. Ranges are deliberately generous — they
//  only catch pathological values, not legitimate tuning. Inline map per
//  the task note (avoid restructuring SETTING_DEFINITIONS).
// ============================================================
const SETTING_NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  // Detection factors (multipliers) — 1..100
  SALES_DEVIATION_FACTOR: { min: 1, max: 100 },
  BOM_DEVIATION_FACTOR: { min: 1, max: 100 },
  BOM_DISPROPORTIONATE_FACTOR: { min: 1, max: 5 }, // documented range 1.0–5.0
  // Benchmark factors
  BENCHMARK_AREA_FACTOR: { min: 1, max: 100 },
  BENCHMARK_NETWORK_FACTOR: { min: 1, max: 100 },
  HISTORICAL_ZSCORE_WARN: { min: 0, max: 10 },
  HISTORICAL_ZSCORE_HIGH: { min: 0, max: 10 },
  HISTORICAL_MIN_WEEKS: { min: 2, max: 52 }, // 0/1 defeats the guard; 52 = a year of weeks
  // CHANGE-1 thresholds
  CHANGE_ANOMALY_RATIO: { min: 1, max: 100 },
  CHANGE_MIN_PAIRS: { min: 1, max: 24 }, // ~2 years of month pairs
  CHANGE_MIN_NOMINAL: { min: 0, max: 1_000_000_000 },
  // Priority scoring weights (any non-negative weight is legitimate)
  WEIGHT_DEV_BOM: { min: 0, max: 100 },
  WEIGHT_GROWTH: { min: 0, max: 100 },
  WEIGHT_RESIDUAL: { min: 0, max: 100 },
  WEIGHT_TOLERANCE: { min: 0, max: 100 },
  WEIGHT_HISTORY: { min: 0, max: 100 },
  // Health score weights
  HEALTH_WEIGHT_DEV_BOM: { min: 0, max: 100 },
  HEALTH_WEIGHT_RESIDUAL: { min: 0, max: 100 },
  HEALTH_WEIGHT_LOSS_TO_SALES: { min: 0, max: 100 },
  HEALTH_WEIGHT_ABNORMAL: { min: 0, max: 100 },
  // Ranking sizes
  TOP_N_ITEMS: { min: 1, max: 100 },
  TOP_N_OUTLETS: { min: 1, max: 100 },
  TOP_N_DEVIASI_RANK: { min: 1, max: 200 },
  // Nominal thresholds (IDR) — non-negative, sane upper bound
  HIGH_LOSS_NOMINAL_THRESHOLD: { min: 0, max: 100_000_000_000 },
  P2_NOMINAL_THRESHOLD: { min: 0, max: 100_000_000_000 },
};

interface SettingWithMeta extends SettingDefinition {
  value: string;
  updatedAt: Date | null;
}

export async function GET() {
  try {
    await ensureDefaultSettings();
    const dbSettings = await db.setting.findMany({
      select: { key: true, value: true, updatedAt: true, updatedBy: true },
    });
    const dbMap = new Map(dbSettings.map((s) => [s.key, s]));

    const result: SettingWithMeta[] = SETTING_DEFINITIONS.map((def) => {
      const dbRow = dbMap.get(def.key);
      return {
        ...def,
        value: dbRow?.value ?? def.defaultValue,
        updatedAt: dbRow?.updatedAt ?? null,
      };
    });

    // Group by category for UI
    const byCategory: Record<string, SettingWithMeta[]> = {};
    for (const s of result) {
      if (!byCategory[s.category]) byCategory[s.category] = [];
      byCategory[s.category].push(s);
    }

    return NextResponse.json({
      success: true,
      settings: result,
      byCategory,
      categories: Object.keys(byCategory).sort(),
    }, {
      headers: {
        // Prevent browser/proxy caching — settings must always be fresh from DB
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (e: unknown) {
    // P23 D4: 'Internal server error' → ID ('Gagal …' convention, see ingest services).
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Gagal memproses permintaan" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // FIX (DEEP-AUDIT-API-5): Rate limit settings mutation endpoint
    const ip = getClientIP(req);
    const rl = rateLimit(`settings:${ip}`, RATE_LIMITS.settings.maxRequests, RATE_LIMITS.settings.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit sebelum mencoba lagi.' },
        { status: 429 }
      );
    }

    await ensureDefaultSettings();
    const body = await req.json();

    // Sprint 1: Zod input validation (values map + optional updatedBy)
    const validation = validateBody(settingsUpdateSchema, body);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }

    // FIX (BUG-3-c SEDANG-3): read from the VALIDATED payload (not the raw
    // body) — settingsUpdateSchema's value-type bounds (string/number/boolean
    // per key) used to be decorative because both fields were re-read from
    // the raw JSON.
    const values: Record<string, string | number | boolean> = validation.data.values ?? {};
    const updatedBy: string | undefined = validation.data.updatedBy;

    if (Object.keys(values).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No values provided' },
        { status: 400 }
      );
    }

    // Validate keys exist in definitions
    const validKeys = new Set(SETTING_DEFINITIONS.map((d) => d.key));
    const updates: Array<{ key: string; value: string }> = [];
    const errors: Array<{ key: string; error: string }> = [];

    for (const [key, rawValue] of Object.entries(values)) {
      if (!validKeys.has(key)) {
        errors.push({ key, error: 'Unknown setting key' });
        continue;
      }
      const def = SETTING_DEFINITIONS.find((d) => d.key === key)!;
      let value = String(rawValue).trim();

      // Validate based on dataType
      if (def.dataType === 'number' || def.dataType === 'percent') {
        let n = Number(value);
        if (isNaN(n)) {
          errors.push({ key, error: `${def.label} must be a number` });
          continue;
        }
        // FIX (BUG-3-c R-7): per-key numeric range — reject out-of-range values
        // with a clear per-key error (a lone bad key yields a 400 below; mixed
        // batches keep the existing partial-success + errors contract).
        // Applies to dataType 'number' only: 'percent' is already normalized
        // to 0–1 below (its own well-defined range).
        if (def.dataType === 'number') {
          const range = SETTING_NUMBER_RANGES[key];
          if (range && (n < range.min || n > range.max)) {
            errors.push({ key, error: `${def.label} harus di antara ${range.min} dan ${range.max} (diterima: ${n})` });
            continue;
          }
        }
        // BUG 1.4 fix: percent values must be 0-1. If user enters 0-100, normalize.
        // Previously the if-body was EMPTY — value 50 was stored as "50" (5000%),
        // silently breaking all anomaly detection.
        if (def.dataType === 'percent') {
          if (n < 0) {
            errors.push({ key, error: `${def.label} cannot be negative` });
            continue;
          }
          // If user enters value > 1, treat as percentage and normalize to 0-1
          // e.g., 50 → 0.5, 5 → 0.05, 0.5 → 0.5 (already normalized)
          if (n > 1) {
            n = n / 100;
            value = String(n);
          }
        }
      } else if (def.dataType === 'boolean') {
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(value.toLowerCase())) {
          errors.push({ key, error: `${def.label} must be true/false` });
          continue;
        }
      }

      updates.push({ key, value });
    }

    if (updates.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No valid settings to update',
        errors: errors.length > 0 ? errors : undefined,
      }, { status: 400 });
    }

    // BUG 1.3 fix: wrap all upserts in a transaction so partial failures don't
    // leave the DB in an inconsistent state with stale caches.
    await db.$transaction(
      updates.map(({ key, value }) => {
        const def = SETTING_DEFINITIONS.find((d) => d.key === key)!;
        return db.setting.upsert({
          where: { key },
          update: { value, updatedBy },
          create: {
            key,
            value,
            category: def.category,
            label: def.label,
            description: def.description,
            dataType: def.dataType,
            updatedBy,
          },
        });
      })
    );

    invalidateSettingsCache();

    // Bug 4 fix: clear analysis cache when settings change (avoid stale data)
    // FIX Medium #1: invalidate DB-level AggregationCache too.
    // PERF-CACHE-05: await invalidation (was fire-and-forget) — guarantees the
    // client's next read after the mutation returns sees fresh data.
    await invalidateAnalysisCache();

    return NextResponse.json({
      success: true,
      updated: updates.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e: unknown) {
    // P23 D4: 'Internal server error' → ID ('Gagal …' convention, see ingest services).
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Gagal memproses permintaan" },
      { status: 500 }
    );
  }
}

// Reset to defaults
export async function DELETE(req: NextRequest) {
  try {
    // FIX (AUDIT7-BE-8): DELETE handler had NO rate limit — POST was rate-limited
    // (`settings:${ip}` bucket) but DELETE wasn't, leaving an unbounded DoS vector
    // for the destructive reset endpoint (30 upserts per call when no `?key=` is
    // provided). Uses a SEPARATE bucket `settings-delete:${ip}` so an attacker
    // who exhausts the POST bucket can still spam DELETE on a separate counter.
    const ip = getClientIP(req);
    const rl = rateLimit(`settings-delete:${ip}`, RATE_LIMITS.settings.maxRequests, RATE_LIMITS.settings.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit sebelum mencoba lagi.' },
        { status: 429 }
      );
    }

    const url = new URL(req.url);
    const key = url.searchParams.get('key');

    if (key) {
      // Reset specific key — single upsert, atomic by itself.
      const def = SETTING_DEFINITIONS.find((d) => d.key === key);
      if (!def) {
        return NextResponse.json(
          { success: false, error: 'Unknown setting key' },
          { status: 400 }
        );
      }
      await db.setting.upsert({
        where: { key },
        update: { value: def.defaultValue, updatedBy: 'reset' },
        create: {
          key,
          value: def.defaultValue,
          category: def.category,
          label: def.label,
          description: def.description,
          dataType: def.dataType,
          updatedBy: 'reset',
        },
      });
    } else {
      // FIX-A-6 (BUG-5-14): Reset all to defaults — wrap in a single transaction
      // so the DB is never left in a partial-reset state. If one upsert fails
      // midway (e.g., DB timeout on the 5th of 30 settings), the entire batch
      // rolls back. Mirrors the POST handler pattern at line ~139.
      await db.$transaction(
        SETTING_DEFINITIONS.map((def) =>
          db.setting.upsert({
            where: { key: def.key },
            update: { value: def.defaultValue, updatedBy: 'reset' },
            create: {
              key: def.key,
              value: def.defaultValue,
              category: def.category,
              label: def.label,
              description: def.description,
              dataType: def.dataType,
              updatedBy: 'reset',
            },
          })
        )
      );
    }

    invalidateSettingsCache();

    // FIX (BUG2-SEC-1): clear analysis cache on settings reset — was missing!
    // The POST handler calls invalidateAnalysisCache() (line 191) but DELETE didn't.
    // Threshold changes affect rule evaluation (TOLERANCE_BREACH, HISTORICAL, etc.)
    // so stale analysis cache would show old rule flags for up to 5 min.
    // PERF-CACHE-05: await invalidation (was fire-and-forget) — guarantees the
    // client's next read after the mutation returns sees fresh data.
    await invalidateAnalysisCache();

    return NextResponse.json({
      success: true,
      message: key ? `Reset ${key} to default` : 'All settings reset to defaults',
    });
  } catch (e: unknown) {
    // P23 D4: 'Internal server error' → ID ('Gagal …' convention, see ingest services).
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Gagal memproses permintaan" },
      { status: 500 }
    );
  }
}
