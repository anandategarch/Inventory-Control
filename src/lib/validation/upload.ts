// ============================================================
//  Route-specific schemas — upload / ingest pipeline.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema per consumer route:
//  /api/ingest, /api/ingest-upload, /api/ingest-process
//  (POST + ./services/delete-mode.ts DELETE),
//  ./ingest-process/services/shared.ts (type-only),
//  /api/import-drive.
// ============================================================
import { z } from 'zod';
import { noControlChars, weekLabelSchema } from './shared';

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

// /api/ingest-process POST body: { mode, fileName, fileHash, fileSize?, ext?, manualFileName?, numberLocale?, weekLabel?, weeksToImport?, monthLabel? }
// FIX (BUG-3-c SEDANG-3): the route used to read `weekLabel` / `weeksToImport`
// from the RAW body even though this schema existed — the schema's bounds
// were decorative. weekLabel now reuses the shared weekLabelSchema (regex +
// no-control-chars) and weeksToImport is explicitly bounded (≤12 entries of
// ≤20 chars — the CFG_RECON week model is W1–W5 per file, 12 is a generous
// ceiling against row-key abuse via oversized arrays).
export const ingestProcessBodySchema = z.object({
  mode: z.string().min(1).max(50),
  fileName: z.string().min(1).max(255),
  fileHash: z.string().min(1).max(128),
  fileSize: z.number().int().min(0).optional(),
  ext: z.string().max(20).optional(),
  manualFileName: z.string().max(255).optional(),
  numberLocale: z.enum(['auto', 'id', 'us']).optional(),
  weekLabel: weekLabelSchema,
  weeksToImport: z.array(z.string().max(20)).max(12).optional(),
  monthLabel: z.string().max(30).optional(),
});

// FIX (AUDIT8-ROLLBACK-1, Item 10): DELETE /api/ingest-process had NO Zod
// body validation — raw `const { fileHash } = body` was used to delete chunks.
// This is the cleanup-after-import endpoint, so the fileHash must match the
// same hex-string shape enforced by POST (SAFE_FILEHASH_RE in the route).
// Validation lives here (not the route) so the schema is co-located with
// ingestProcessBodySchema for consistency.
// fileHash is OPTIONAL because the DELETE handler treats missing fileHash as
// "delete nothing" (no-op return) — preserving existing behavior.
export const ingestProcessDeleteBodySchema = z.object({
  fileHash: z.string().min(8).max(128).regex(/^[a-f0-9]{8,128}$/i).optional(),
}).strict();

// /api/import-drive POST body: { url, manualFileName?, numberLocale? }
export const importDriveBodySchema = z.object({
  url: z.string().url(),
  // FIX (BUG-3-c SEDANG-4): manualFileName had NO bound — a multi-megabyte
  // string passed Zod and flowed into validateManualFileName/logging. Bound
  // to 255 (filename ceiling, matching ingestPostBodySchema) + reject control
  // characters (they can never be legal in a filename).
  manualFileName: z.string().max(255).refine(noControlChars).optional(),
  numberLocale: z.enum(['auto', 'id', 'us']).optional(),
});
