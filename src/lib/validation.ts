// ============================================================
//  Shared Zod validation schemas for API routes.
//  Phase 4 / Sprint 1: input validation for critical routes.
// ============================================================
import { z } from 'zod';

// Month label: "Januari 2026", "Mei 2026", "AGUSTUS 2026", etc. — Indonesian month name + 4-digit year
// FIX (AUDIT-SECURITY-PERF C4): was /^[A-Z][a-z]+\s+20\d{2}$/ — rejected uppercase "AGUSTUS 2026".
// monthResolver normalizes case AFTER validation, so validation must accept any case.
export const monthLabelSchema = z.string().regex(/^[A-Za-z]+\s+20\d{2}$/).optional();

// Week label: "WEEK 1", "WEEK 2", "WEEK 4"
export const weekLabelSchema = z.string().regex(/^WEEK\s+[0-9]+$/i).optional();

// Outlet code: "1016.MLGJAK", "1251.CBIPAS" — alphanumeric + dot
export const outletCodeSchema = z.string().min(1).max(50).optional();

// Item name: free text, max 200 chars
export const itemNameSchema = z.string().min(1).max(200).optional();

// Area name: "JAWA TIMUR 1", "BANTEN" — uppercase + optional number
export const areaSchema = z.string().min(1).max(50).optional();

// PIC name: free text, max 100 chars
export const picSchema = z.string().min(1).max(100).optional();

// Compare week: "WEEK 1" or "WEEK 1|||Juli 2026" (cross-month)
export const compareWeekSchema = z.string().min(3).max(100).optional();

// Limit: positive integer, max 500
export const limitSchema = z.coerce.number().int().min(1).max(500).optional();

// Cursor: positive integer (record ID)
export const cursorSchema = z.coerce.number().int().positive().optional();

// ============================================================
//  Route-specific schemas
// ============================================================

// Kelompok: 3-char prefix from outlet code name segment (e.g. "BDG", "MLG")
// FIX (BUG-BE-8 / BUG-EDGE-3 / BUG-PERF-6): was missing from these schemas —
// a 1000-char kelompok would pass through unvalidated.
export const kelompokSchema = z.string().min(1).max(50).optional();

// /api/analysis?month=&week=&compareWeek=&area=&kelompok=&outlet=&item=&pic=
export const analysisQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  compareWeek: compareWeekSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  item: itemNameSchema,
  pic: picSchema,
});

// /api/drilldown?outletCode=&itemName=&weekLabel=&monthLabel=&limit=&cursor=
export const drilldownQuerySchema = z.object({
  outletCode: outletCodeSchema,
  itemName: itemNameSchema,
  weekLabel: weekLabelSchema,
  monthLabel: monthLabelSchema,
  limit: limitSchema,
  cursor: cursorSchema,
});

// /api/outlet-items?outletCode=&month=&week=&compareWeek=
export const outletItemsQuerySchema = z.object({
  outletCode: z.string().min(1).max(50), // required
  month: monthLabelSchema,
  week: weekLabelSchema,
  compareWeek: compareWeekSchema,
  compareMonth: monthLabelSchema,
});

// /api/item-history?outletCode=&itemName=&month=&week=
export const itemHistoryQuerySchema = z.object({
  outletCode: z.string().min(1).max(50), // required
  itemName: z.string().min(1).max(200), // required
  month: monthLabelSchema,
  week: weekLabelSchema,
});

// /api/settings POST body: { values: { key: value, ... }, updatedBy? }
// `values` is a map of setting key → string value (server-side type-checks per def).
export const settingsUpdateSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  updatedBy: z.string().max(100).optional(),
});

// /api/recommendations?month=&week=&prevWeek=&prevMonth=&limit=&area=&kelompok=&outletCode=&pic=
export const recommendationsQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  prevWeek: weekLabelSchema,
  prevMonth: monthLabelSchema,
  limit: limitSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  outletCode: outletCodeSchema,
  pic: picSchema,
});

// /api/pareto?month=&week=&area=&kelompok=&pic=&parentDim=&childDim=
// FIX (AUDIT7-BE-4): was reading raw url.searchParams.get() with no Zod
// validation — inconsistent with /api/analysis + /api/recommendations.
// parentDim + childDim included for forward-compat with the multi-nesting
// feature (AUDIT7-BE-1 — backend not yet implemented). Strict enum prevents
// arbitrary strings from reaching downstream SQL/JS consumers.
export const paretoQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  area: areaSchema,
  kelompok: kelompokSchema,
  pic: picSchema,
  parentDim: z.enum(['item', 'outlet', 'area', 'kelompok', 'pic']).optional(),
  childDim: z.enum(['item', 'outlet', 'area', 'kelompok', 'pic']).optional(),
});

// /api/peer-comparison?outletCode=&month=&week=&mode=&limit=&kelompok=
// FIX (BUG2-RESTO-1 / FIX-P1-PEER-1): kelompok scopes the PEER set only —
// the focus outlet is always queried by outletCode regardless.
export const peerComparisonQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  mode: z.enum(['week', 'month']).optional(),
  limit: limitSchema,
  kelompok: kelompokSchema,
});

// /api/peer-comparison/items?outletCode=&month=&week=&kelompok=
export const peerComparisonItemsQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/peer-comparison/trend?outletCode=&month=&week=&kelompok=
export const peerComparisonTrendQuerySchema = z.object({
  outletCode: z.string().min(1).max(50),
  month: monthLabelSchema,
  week: weekLabelSchema,
  kelompok: kelompokSchema,
});

// /api/export-report?month=&week=&sections=&area=&kelompok=&outlet=&item=&pic=
export const exportReportQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  sections: z.string().optional(),
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  item: itemNameSchema,
  pic: picSchema,
  compareWeek: compareWeekSchema,
  compareMonth: monthLabelSchema,
});

// /api/data (GET — optional ?fileId=N, DELETE — ?month=&monthKey=&fileId=&all=&confirm=)
// DELETE supports cascade delete by month / fileId / all (with confirm).
export const dataDeleteQuerySchema = z.object({
  month: z.string().max(50).optional(),       // legacy: monthLabel (resolved to monthKey server-side)
  monthKey: z.string().max(10).optional(),     // preferred: "YYYY-MM" (case-insensitive)
  fileId: z.coerce.number().int().optional(),
  all: z.enum(['true', '1', 'yes']).optional(),
  confirm: z.enum(['true', '1', 'yes']).optional(),
});

// /api/migrate-direction (POST — no body params needed, but add for completeness)
export const migrateDirectionQuerySchema = z.object({}).optional();

// /api/status (GET — no params)
export const statusQuerySchema = z.object({}).optional();

// /api/pic?outletCode= (GET/DELETE)
export const picQuerySchema = z.object({
  outletCode: z.string().min(1).max(50).optional(),
});

// /api/pic POST body: { outletCode, pic }
export const picPostBodySchema = z.object({
  outletCode: z.string().min(1).max(50),
  pic: z.string().min(1).max(100),
});

// /api/ingest POST body: flexible shape passed to processIngestion.
// Body can be {} (auto-scan DATA_DIR) or { filePath, dir, fileName, manualFileName, numberLocale }.
// All fields optional — processIngestion handles defaults.
export const ingestPostBodySchema = z.object({
  filePath: z.string().max(1024).optional(),
  dir: z.string().max(1024).optional(),
  fileName: z.string().max(255).optional(),
  fileHash: z.string().max(128).optional(),
  totalChunks: z.number().int().min(1).max(1000).optional(),
  monthLabel: z.string().max(30).optional(),
  manualFileName: z.string().max(255).optional(),
  numberLocale: z.enum(['auto', 'id', 'us']).optional(),
}).optional().default({});

// /api/ingest-upload POST: form-data fields (validated as object after extraction).
// `chunk` (File) is validated separately by size checks in the route.
export const ingestUploadBodySchema = z.object({
  fileHash: z.string().min(1).max(128),
  chunkIndex: z.coerce.number().int().min(0),
  totalChunks: z.coerce.number().int().min(1).max(1000),
  fileName: z.string().min(1).max(255),
  fileSize: z.coerce.number().int().min(0).optional(),
});

// /api/ingest-process POST body: { mode, fileName, fileHash, fileSize?, ext?, manualFileName?, numberLocale?, weekLabel?, monthLabel? }
export const ingestProcessBodySchema = z.object({
  mode: z.string().min(1).max(50),
  fileName: z.string().min(1).max(255),
  fileHash: z.string().min(1).max(128),
  fileSize: z.number().int().min(0).optional(),
  ext: z.string().max(20).optional(),
  manualFileName: z.string().max(255).optional(),
  numberLocale: z.enum(['auto', 'id', 'us']).optional(),
  weekLabel: z.string().max(30).optional(),
  monthLabel: z.string().max(30).optional(),
});

// /api/import-drive POST body: { url, manualFileName?, numberLocale? }
export const importDriveBodySchema = z.object({
  url: z.string().url(),
  manualFileName: z.string().optional(),
  numberLocale: z.enum(['auto', 'id', 'us']).optional(),
});

// ============================================================
//  Helper: validate query params, return 400 on failure
// ============================================================
export function validateQuery<T extends z.ZodType>(
  schema: T,
  params: URLSearchParams
): { success: true; data: z.infer<T> } | { success: false; error: string } {
  const obj: Record<string, string> = {};
  params.forEach((value, key) => {
    obj[key] = value;
  });
  const result = schema.safeParse(obj);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { success: false, error: `Invalid query params: ${errors}` };
}

// ============================================================
//  Helper: validate POST/PUT body, return 400 on failure
// ============================================================
export function validateBody<T extends z.ZodType>(
  schema: T,
  body: unknown
): { success: true; data: z.infer<T> } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { success: false, error: `Invalid body: ${errors}` };
}
