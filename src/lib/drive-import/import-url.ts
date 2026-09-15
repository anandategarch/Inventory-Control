// ============================================================
//  Drive Import — main entry point: importFromDriveUrl()
//  ----------------------------------------------------------
//  Supports: folder, file, sheets.
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
import { FETCH_TIMEOUT_MS, readTextCapped } from './http-safety';
import { extractDriveId } from './url-parse';
import { listDriveFolderFiles } from './folder-scan';
import { downloadDriveFile } from './download-file';
import { downloadGoogleSheetsAsCsv, getSheetsTitle } from './download-sheets';
import type { DriveImportResult } from './types';

export async function importFromDriveUrl(
  url: string,
  destDir: string
): Promise<DriveImportResult> {
  const parsed = extractDriveId(url);
  if (!parsed) {
    throw new Error(
      'Invalid Google URL. Supported formats:\n' +
      '• Google Drive folder: https://drive.google.com/drive/folders/...\n' +
      '• Google Drive file:   https://drive.google.com/file/d/...\n' +
      '• Google Sheets:       https://docs.google.com/spreadsheets/d/...'
    );
  }

  const downloadedFiles: DriveImportResult['downloadedFiles'] = [];

  if (parsed.type === 'folder') {
    // List all files in folder
    const files = await listDriveFolderFiles(parsed.id);
    if (files.length === 0) {
      throw new Error(`No .xlsx files found in the Google Drive folder (ID: ${parsed.id}). Make sure the folder is shared as "Anyone with link can view".`);
    }

    // Download each file
    for (const file of files) {
      try {
        const { localPath, size } = await downloadDriveFile(file.id, file.name, destDir);
        downloadedFiles.push({ fileName: file.name, localPath, size, success: true });
      } catch (e: unknown) {
        downloadedFiles.push({
          fileName: file.name,
          localPath: '',
          size: 0,
          success: false,
          error: (e instanceof Error ? e.message : String(e)),
        });
      }
    }

    return { folderId: parsed.id, downloadedFiles };

  } else if (parsed.type === 'sheets') {
    // Google Sheets — export as CSV directly (no Excel parsing needed!)
    try {
      const title = await getSheetsTitle(parsed.id);
      let fileName = title || `google_sheets_${parsed.id}`;
      fileName = fileName.replace(/[<>:"/\\|?*]/g, '_').trim();
      // Use .csv extension (downloaded as CSV directly)
      if (!fileName.toLowerCase().endsWith('.csv')) {
        fileName = `${fileName}.csv`;
      }

      const { localPath, size } = await downloadGoogleSheetsAsCsv(parsed.id, fileName, destDir);
      downloadedFiles.push({ fileName, localPath, size, success: true });
    } catch (e: unknown) {
      downloadedFiles.push({
        fileName: '',
        localPath: '',
        size: 0,
        success: false,
        error: (e instanceof Error ? e.message : String(e)),
      });
    }

    return { folderId: null, downloadedFiles };

  } else {
    // Single Google Drive file
    try {
      // First, get file name from Drive metadata
      const metaRes = await fetch(`https://drive.google.com/file/d/${parsed.id}/view`, {
        // FIX (BUG-3-c SEDANG-2): 60s abort — this is best-effort name
        // detection (the fallback name below is used on any failure).
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      let fileName = `drive_file_${parsed.id}.xlsx`;
      if (metaRes.ok) {
        // FIX (BUG-3-c SEDANG-2): bounded read — only the <title> tag is
        // extracted from this page.
        const html = await readTextCapped(metaRes, 2 * 1024 * 1024);
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          // Title format is usually "filename - Google Drive"
          const rawTitle = titleMatch[1].replace(/\s*-\s*Google Drive\s*$/i, '').trim();
          if (rawTitle && rawTitle.toLowerCase().endsWith('.xlsx')) {
            fileName = rawTitle;
          }
        }
      }

      const { localPath, size } = await downloadDriveFile(parsed.id, fileName, destDir);
      downloadedFiles.push({ fileName, localPath, size, success: true });
    } catch (e: unknown) {
      downloadedFiles.push({
        fileName: '',
        localPath: '',
        size: 0,
        success: false,
        error: (e instanceof Error ? e.message : String(e)),
      });
    }

    return { folderId: null, downloadedFiles };
  }
}
