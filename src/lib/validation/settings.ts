// ============================================================
//  Route-specific schemas — settings.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema, one consumer route:
//  /api/settings (POST).
// ============================================================
import { z } from 'zod';

// /api/settings POST body: { values: { key: value, ... }, updatedBy? }
// `values` is a map of setting key → string value (server-side type-checks per def).
export const settingsUpdateSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  updatedBy: z.string().max(100).optional(),
});
