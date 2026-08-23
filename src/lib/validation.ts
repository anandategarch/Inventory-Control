// ============================================================
//  Shared Zod validation schemas for API routes.
//  Phase 4 / Sprint 1: input validation for critical routes.
// ============================================================
import { z } from 'zod';

// Month label: "Januari 2026", "Mei 2026", etc. — Indonesian month name + 4-digit year
export const monthLabelSchema = z.string().regex(/^[A-Z][a-z]+\s+20\d{2}$/).optional();

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

// /api/analysis?month=&week=&compareWeek=&area=&outlet=&item=&pic=
export const analysisQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  compareWeek: compareWeekSchema,
  area: areaSchema,
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

// /api/settings PUT body: { settings: [{ key, value }] }
export const settingsUpdateSchema = z.object({
  settings: z.array(z.object({
    key: z.string().min(1).max(100),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })).min(0).max(100),
});

// ============================================================
//  Helper: validate query params, return 400 on failure
// ============================================================
export function validateQuery<T extends z.ZodType>(
  schema: T,
  params: URLSearchParams
): { success: true; data: z.infer<T> } | { success: false; error: string } {
  // Convert URLSearchParams to plain object
  const obj: Record<string, string> = {};
  params.forEach((value, key) => {
    obj[key] = value;
  });

  const result = schema.safeParse(obj);
  if (result.success) {
    return { success: true, data: result.data };
  }
  // Format errors
  const errors = result.error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { success: false, error: `Invalid query params: ${errors}` };
}
