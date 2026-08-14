// ============================================================
//  Shared filename helpers for manual rename feature
//  Used by both /api/import-drive and /api/ingest-process
//  to ensure consistent validation + sanitization.
// ============================================================
import { parseMonthFromFilename } from '@/lib/excel';

// Filesystem-unsafe chars + path traversal + control chars + null bytes
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Strip filesystem-unsafe chars from a filename.
 * Removes: < > : " / \ | ? * control chars (0x00-0x1f) + leading dots (hidden files / ../ traversal)
 */
export function sanitizeFileName(name: string): string {
  let cleaned = name.replace(UNSAFE_CHARS, '').trim();
  cleaned = cleaned.replace(/^\.+/, '').trim();
  return cleaned;
}

/**
 * Validate a manual filename.
 * Returns { ok, cleaned, error } where:
 * - cleaned has extension auto-appended (.xlsx default) if missing
 * - error explains why the name is invalid
 *
 * Rules:
 * 1. Must be non-empty after sanitize
 * 2. Must end with .xlsx or .csv (auto-append .xlsx if missing)
 * 3. Must contain parseable month info (via parseMonthFromFilename)
 */
export function validateManualFileName(raw: string): {
  ok: boolean;
  cleaned: string;
  error?: string;
  monthLabel?: string;
  monthKey?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, cleaned: '', error: 'Nama file tidak boleh kosong.' };
  }
  const cleaned = sanitizeFileName(trimmed);
  if (!cleaned) {
    return { ok: false, cleaned: '', error: 'Nama file mengandung karakter tidak valid.' };
  }
  // Ensure extension — default to .xlsx if missing
  const hasExt = /\.(xlsx|csv)$/i.test(cleaned);
  const withExt = hasExt ? cleaned : `${cleaned}.xlsx`;
  // Validate month info via the SAME parser the server uses downstream
  const parsed = parseMonthFromFilename(withExt);
  if (!parsed) {
    return {
      ok: false,
      cleaned: withExt,
      error: `Nama "${withExt}" tidak mengandung info bulan. Format: "BULAN TAHUN.xlsx" contoh: "MEI 2026.xlsx".`,
    };
  }
  return {
    ok: true,
    cleaned: withExt,
    monthLabel: parsed.monthLabel,
    monthKey: parsed.monthKey,
  };
}

/**
 * Resolve the final manualFileName for server-side use.
 * Returns null if manualFileName is empty/invalid (caller should fall back to auto-detect).
 * Returns the sanitized+validated filename (with extension) if valid.
 * Throws an Error with a user-friendly message if manualFileName is non-empty but invalid.
 */
export function resolveManualFileName(manualFileName: unknown): string | null {
  if (typeof manualFileName !== 'string' || !manualFileName.trim()) {
    return null; // not provided → use auto-detect
  }
  const result = validateManualFileName(manualFileName);
  if (!result.ok) {
    throw new Error(result.error || 'manualFileName tidak valid.');
  }
  return result.cleaned;
}
