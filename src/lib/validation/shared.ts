// ============================================================
//  Shared Zod validation schemas for API routes.
//  Phase 4 / Sprint 1: input validation for critical routes.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC) — the genuinely shared atoms
//  (used by ≥2 route schemas) + the 2 generic helpers. Every
//  domain file in this folder re-imports these atoms; routes that
//  define their schemas INLINE (flip-ranking family,
//  item-trend-rank, item-peer-comparison, price-effect,
//  item-anomali-outlets, item-search) import them directly via
//  '@/lib/validation'.
// ============================================================
import { z } from 'zod';

// FIX (BUG-3 — root cause of "export loading lama + muter terus"):
// control characters are REJECTED in every filter param, for two reasons:
//  1. buildCacheKey embeds filter values into the AggregationCache.cacheKey
//     TEXT column. A raw \u0000 makes PostgreSQL refuse the entire write
//     (SQLSTATE 22021) and the silent non-blocking failure kills caching —
//     exactly what the NUL sentinel of BUG-2-b did to every cache write in
//     production (2026-09: all requests recomputed cold, export 15-17s per
//     call). C0/DEL/C1 can never legally appear in an area name, PIC, item,
//     month or week label — verified against production data (0 rows).
//  2. Anti-forgery: the key sentinels are ESC-prefixed (\u001bALL /
//     \u001bNONE — key-builder.ts). Rejecting controls at the door keeps
//     them impossible to reproduce from user input.
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
// FIX (BUGHUNT-A2): exported so the routes that define their Zod schemas
// INLINE (flip-ranking family, item-trend-rank, item-peer-comparison,
// price-effect, item-anomali-outlets, item-search) can apply the SAME
// control-char gate to their own string fields. Previously those schemas
// skipped this refine entirely, so a control char passed validation and
// key-builder.ts's sanitizeKeyPart silently STRIPPED it — building the
// exact cache key of the real (control-free) value. The crafted request
// then cached its EMPTY result under the REAL filter's key (cache-key
// poisoning: `?pic=An%1Bdi` poisoned `pic=Andi` for the full TTL).
export const noControlChars = (v: string) => !CONTROL_CHAR.test(v);

// Month label: "Januari 2026", "Mei 2026", "AGUSTUS 2026", etc. — Indonesian month name + 4-digit year
// FIX (AUDIT-SECURITY-PERF C4): was /^[A-Z][a-z]+\s+20\d{2}$/ — rejected uppercase "AGUSTUS 2026".
// monthResolver normalizes case AFTER validation, so validation must accept any case.
export const monthLabelSchema = z.string().regex(/^[A-Za-z]+\s+20\d{2}$/).refine(noControlChars).optional();

// FIX (WASTE-DRILL): comma-separated month list for /api/drilldown — the route
// body has split→trim→dedup→sort→resolve→WHERE IN support since P2-12 (the
// "multi-period" comment in the route header), but this gate only accepted a
// SINGLE label, so the documented multi-month path was unreachable. The Waste
// tab's window drill (months of the same-week window, e.g. 8–12 labels) now
// has a schema that actually lets it through. Each element keeps the single
// month shape; whitespace around commas is tolerated (the route trims anyway).
export const multiMonthLabelSchema = z.string()
  .regex(/^([A-Za-z]+\s+20\d{2})(\s*,\s*[A-Za-z]+\s+20\d{2})+$/)
  .refine(noControlChars)
  .optional();

// Week label: "WEEK 1", "WEEK 2", "WEEK 4"
export const weekLabelSchema = z.string().regex(/^WEEK\s+[0-9]+$/i).refine(noControlChars).optional();

// Outlet code: "1016.MLGJAK", "1251.CBIPAS" — alphanumeric + dot
export const outletCodeSchema = z.string().min(1).max(50).refine(noControlChars).optional();

// Item name: free text, max 200 chars
export const itemNameSchema = z.string().min(1).max(200).refine(noControlChars).optional();

// Area name: "JAWA TIMUR 1", "BANTEN" — uppercase + optional number
export const areaSchema = z.string().min(1).max(50).refine(noControlChars).optional();

// PIC name: free text, max 100 chars
export const picSchema = z.string().min(1).max(100).refine(noControlChars).optional();

// Compare week: "WEEK 1" or "WEEK 1|||Juli 2026" (cross-month)
export const compareWeekSchema = z.string().min(3).max(100).refine(noControlChars).optional();

// Limit: positive integer, max 500
export const limitSchema = z.coerce.number().int().min(1).max(500).optional();

// Cursor: positive integer (record ID)
export const cursorSchema = z.coerce.number().int().positive().optional();

// Kelompok: 3-char prefix from outlet code name segment (e.g. "BDG", "MLG")
// FIX (BUG-BE-8 / BUG-EDGE-3 / BUG-PERF-6): was missing from these schemas —
// a 1000-char kelompok would pass through unvalidated.
export const kelompokSchema = z.string().min(1).max(50).refine(noControlChars).optional();

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
