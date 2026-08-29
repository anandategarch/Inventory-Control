// ============================================================
//  upload-utils — shared client-side helpers for file upload dialogs.
//  --------------------------------------------------------
//  FIX (AUDIT8-ROLLBACK-1, Item 7): previously these were inlined as local
//  duplicates in src/components/filters/FileUploadDialog.tsx. The local
//  MONTH_NAMES array had drifted from the server-side MONTH_MAP (src/lib/excel.ts)
//  causing AUDIT-RENAME-9 (client ✓ then server 400). Centralising here:
//    - makes the month list a single source of truth on the client side
//    - lets other dialogs (CsvUploadDialog, DriveImportDialog) reuse the same
//      validation logic instead of re-implementing it inline (FilterBar.tsx
//      already has its own partial copy that should also be migrated).
//    - renameModeDefault is shared between FileUploadDialog's useState init
//      + reset() so the default always comes from one place.
// ============================================================

// Indonesian month names + abbreviations. MUST stay in sync with the server-side
// MONTH_MAP in src/lib/excel.ts (which also accepts: may, agt, pebruari, okteber,
// nopember). AUDIT-RENAME-9 fix: previously this list missed `may` / `agt` /
// `pebruari` / `okteber` / `nopember`, so the client accepted names the server
// rejected (and vice versa) → user saw "client ✓ then server 400".
export const MONTH_NAMES = [
  'januari','jan','februari','pebruari','feb','maret','mar','april','apr',
  'mei','may','juni','jun','juli','jul','agustus','agu','agt',
  'september','sep','oktober','okt','okteber','november','nopember','nov','desember','des',
];

/**
 * Client-side manual filename validation.
 *
 * Must contain an Indonesian month name + 2-4 digit year, and end with .xlsx/.csv.
 * Mirrors server-side validateManualFileName in src/lib/filename.ts but uses the
 * MONTH_NAMES list above (client-side substring check, not the server's parseMonthFromFilename
 * — both must accept the same set of names, hence the sync requirement).
 *
 * @returns `{ ok, cleaned?, error? }` — `cleaned` is the sanitized filename with
 *          filesystem-unsafe chars stripped and `.xlsx` extension appended if missing.
 */
export function validateManualFileName(raw: string): { ok: boolean; error?: string; cleaned?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Nama file tidak boleh kosong.' };
  // Strip filesystem-unsafe chars (mirror server-side sanitize)
  const cleaned = trimmed.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^\.+/, '').trim();
  if (!cleaned) return { ok: false, error: 'Nama file mengandung karakter tidak valid.' };
  // Ensure extension
  const hasExt = /\.(xlsx|csv)$/i.test(cleaned);
  const withExt = hasExt ? cleaned : `${cleaned}.xlsx`;
  // Must contain month name + year
  const lower = withExt.toLowerCase();
  const hasMonth = MONTH_NAMES.some(m => lower.includes(m));
  const hasYear = /\b(20\d{2}|\d{2})\b/.test(lower);
  if (!hasMonth || !hasYear) {
    return { ok: false, error: 'Format harus "BULAN TAHUN.xlsx". Contoh: "MEI 2026.xlsx" atau "17.JULI 2026.xlsx".', cleaned: withExt };
  }
  return { ok: true, cleaned: withExt };
}

/**
 * Default rename mode for the upload dialog. `'auto'` lets the server derive the
 * monthLabel from the uploaded filename; `'manual'` shows a text input pre-filled
 * with the original filename for the user to edit. Defaults to `'auto'` — most
 * uploads have a parseable filename so the extra UI is skipped.
 */
export function renameModeDefault(): 'auto' | 'manual' {
  return 'auto';
}
