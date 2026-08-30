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
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Internal server error" },
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

    const values: Record<string, string> = body.values || {};
    const updatedBy: string | undefined = body.updatedBy;

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

    // Audit log
    // FIX (AUDIT8-ROLLBACK-1, Item 11): fire-and-forget — never await audit log writes.
    db.auditLog.create({
      data: {
        action: 'SETTINGS_UPDATE',
        detail: `Updated ${updates.length} settings: ${updates.map((u) => u.key).join(', ')}`,
      },
    }).catch(() => {});

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
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Internal server error" },
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

    // FIX (BUG2-STATE-5): audit log is fire-and-forget (low priority) — don't await.
    // The cache invalidation above IS awaited (PERF-CACHE-05) — correctness-critical
    // so the client doesn't see stale thresholds on next read.
    db.auditLog.create({
      data: {
        action: 'SETTINGS_RESET',
        detail: key ? `Reset ${key} to default` : 'Reset all settings to defaults',
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      message: key ? `Reset ${key} to default` : 'All settings reset to defaults',
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, error: process.env.NODE_ENV === "development" ? (e instanceof Error ? e.message : String(e)) : "Internal server error" },
      { status: 500 }
    );
  }
}
