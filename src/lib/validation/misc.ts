// ============================================================
//  Route-specific schemas — misc routes: master-data mutation
//  (PIC), data management (GET/DELETE), ops/meta routes
//  (migrate-direction, status — status is also consumed by
//  /api/setup).
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC) — tiny singletons merged here
//  rather than one file per 2-line schema.
// ============================================================
import { z } from 'zod';

// /api/data (GET — optional ?fileId=N, DELETE — ?month=&monthKey=&fileId=&all=&confirm=)
// DELETE supports cascade delete by month / fileId / all (with confirm).
export const dataDeleteQuerySchema = z.object({
  month: z.string().max(50).optional(),       // legacy: monthLabel (resolved to monthKey server-side)
  monthKey: z.string().max(10).optional(),     // preferred: "YYYY-MM" (case-insensitive)
  fileId: z.coerce.number().int().optional(),
  all: z.enum(['true', '1', 'yes']).optional(),
  confirm: z.enum(['true', '1', 'yes']).optional(),
});

// FIX (AUDIT8-ROLLBACK-1, Item 9): GET /api/data had NO Zod validation —
// `fileId` was parsed via raw `parseInt(fileIdParam)` + `isNaN` check only.
// Adding dataGetQuerySchema enforces the same shape as DELETE and protects
// against non-numeric / negative / overly-large fileIds reaching the DQIssue
// query (which uses fileId in a Prisma where clause — safe, but unprincipled).
export const dataGetQuerySchema = z.object({
  fileId: z.coerce.number().int().positive().optional(),
});

// /api/migrate-direction (POST — no body params needed, but add for completeness)
export const migrateDirectionQuerySchema = z.object({}).optional();

// /api/status (GET — no params; also used by /api/setup)
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
