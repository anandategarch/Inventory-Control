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

export const dynamic = 'force-dynamic';

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
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureDefaultSettings();
    const body = await req.json();
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
      const value = String(rawValue).trim();

      // Validate based on dataType
      if (def.dataType === 'number' || def.dataType === 'percent') {
        const n = Number(value);
        if (isNaN(n)) {
          errors.push({ key, error: `${def.label} must be a number` });
          continue;
        }
        if (def.dataType === 'percent' && (n < 0 || n > 1)) {
          // percent can be 0-1 OR 0-100, accept both but warn
          // We'll accept 0-100 too and normalize later if needed
        }
        if (n < 0 && !key.includes('TOLERANCE') && def.dataType === 'percent') {
          errors.push({ key, error: `${def.label} cannot be negative` });
          continue;
        }
      } else if (def.dataType === 'boolean') {
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(value.toLowerCase())) {
          errors.push({ key, error: `${def.label} must be true/false` });
          continue;
        }
      }

      updates.push({ key, value });
    }

    // Apply updates via upsert
    for (const { key, value } of updates) {
      const def = SETTING_DEFINITIONS.find((d) => d.key === key)!;
      await db.setting.upsert({
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
    }

    invalidateSettingsCache();

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'SETTINGS_UPDATE',
        detail: `Updated ${updates.length} settings: ${updates.map((u) => u.key).join(', ')}`,
      },
    });

    return NextResponse.json({
      success: true,
      updated: updates.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}

// Reset to defaults
export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get('key');

    if (key) {
      // Reset specific key
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
      // Reset all to defaults
      for (const def of SETTING_DEFINITIONS) {
        await db.setting.upsert({
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
        });
      }
    }

    invalidateSettingsCache();

    await db.auditLog.create({
      data: {
        action: 'SETTINGS_RESET',
        detail: key ? `Reset ${key} to default` : 'Reset all settings to defaults',
      },
    });

    return NextResponse.json({
      success: true,
      message: key ? `Reset ${key} to default` : 'All settings reset to defaults',
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
