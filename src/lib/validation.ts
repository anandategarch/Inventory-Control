// ============================================================
//  Zod validation schemas for API endpoints
//  Bug #3 fix: Input validation
//  Prevents malformed input from crashing API routes
// ============================================================
import { z } from 'zod';

// ============================================================
//  /api/ingest — POST body
//  manualFileName: optional override for the basename-derived filename
//  (fixes "Loading Google Sheet" when importing from Google Drive/Sheets)
// ============================================================
export const ingestBodySchema = z.object({
  filePath: z.string().max(500).optional(),
  dir: z.string().max(500).optional(),
  fileName: z.string().max(255).optional(),
  manualFileName: z.string().max(255).optional(),
  precomputedHash: z.string().max(128).optional(),
}).strict().optional().default({});

// ============================================================
//  /api/import-drive — POST body
//  manualFileName: optional override — when set, server uses this name
//  instead of the downloaded filename (fixes "Loading Google Sheet").
// ============================================================
export const importDriveBodySchema = z.object({
  url: z.string().url().max(2000),
  manualFileName: z.string().max(255).optional(),
}).strict();

// ============================================================
//  /api/settings — POST body (bulk update)
// ============================================================
export const settingsPostBodySchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  updatedBy: z.string().max(100).optional(),
}).strict();

// ============================================================
//  /api/settings — DELETE (query params handled in route)
// ============================================================
export const settingsDeleteQuerySchema = z.object({
  key: z.string().max(100).optional(),
}).strict().optional();

// ============================================================
//  /api/analysis — GET query params
// ============================================================
export const analysisQuerySchema = z.object({
  month: z.string().max(50).optional(),
  week: z.string().max(20).optional(),
  compareWeek: z.string().max(100).optional(), // may contain ||| for cross-month
  area: z.string().max(100).optional(),
  outlet: z.string().max(50).optional(),
  item: z.string().max(200).optional(),
  pic: z.string().max(100).optional(),
}).strict().partial();

// ============================================================
//  /api/drilldown — GET query params
// ============================================================
export const drilldownQuerySchema = z.object({
  outletCode: z.string().max(50).optional(),
  itemName: z.string().max(200).optional(),
  weekLabel: z.string().max(200).optional(), // may be comma-separated
  monthLabel: z.string().max(200).optional(), // may be comma-separated
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict().partial();

// ============================================================
//  Safe parse helper — returns { data, error }
// ============================================================
export function safeParse<T>(schema: z.ZodSchema<T>, input: unknown): { data: T | null; error: string | null } {
  const result = schema.safeParse(input);
  if (result.success) {
    return { data: result.data, error: null };
  }
  const errMessages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { data: null, error: errMessages };
}
