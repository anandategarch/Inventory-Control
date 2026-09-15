// ============================================================
//  Drive Import — URL parser
//  ----------------------------------------------------------
//  Extract ID + type from various Google URL formats.
//  Returns type: 'folder' | 'file' | 'sheets'
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
import type { DriveIdType } from './types';

export function extractDriveId(url: string): DriveIdType | null {
  if (!url) return null;
  const trimmed = url.trim();

  // Google Sheets: https://docs.google.com/spreadsheets/d/{ID}/edit?usp=sharing
  // Also matches /view, /copy, /export, /htmlview, etc.
  let m = trimmed.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'sheets', id: m[1] };

  // Folder: https://drive.google.com/drive/folders/{ID} or with query
  m = trimmed.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'folder', id: m[1] };

  // File: https://drive.google.com/file/d/{ID}/view (or any path after ID)
  m = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'file', id: m[1] };

  // Open: https://drive.google.com/open?id={ID}
  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'file', id: m[1] };

  // Raw ID only (44 chars typical for Drive files)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return { type: 'file', id: trimmed };
  }

  return null;
}
