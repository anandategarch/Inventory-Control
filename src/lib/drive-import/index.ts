// ============================================================
//  Google Drive Import Service — barrel export
//  ----------------------------------------------------------
//  Reads folder/file links from Google Drive (public links only),
//  downloads .xlsx files, and feeds them to the existing ingestion pipeline.
//
//  Supported URL formats:
//    - Folder:        https://drive.google.com/drive/folders/{FOLDER_ID}
//    - File (Drive):  https://drive.google.com/file/d/{FILE_ID}/view
//    - Open:          https://drive.google.com/open?id={FILE_ID}
//    - Direct:        https://drive.google.com/uc?id={FILE_ID}
//    - Sheets:        https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit
//                     (auto-exported as .xlsx via /export?format=xlsx)
//    - Raw ID:        {FILE_ID} (44 chars typical)
//
//  SPLIT-D (pure code motion): was src/lib/drive-import.ts (595 lines,
//  old file deleted). '@/lib/drive-import' resolves to this folder —
//  the existing caller (src/app/api/import-drive/route.ts) keeps
//  importing from the SAME path. The barrel re-exports EXACTLY the
//  old public API (no `export *` → no accidental additions):
//    ./types            — DriveFile, DriveImportResult, DriveIdType
//    ./url-parse        — extractDriveId()
//    ./http-safety      — timeouts + byte caps (internal, not re-exported)
//    ./folder-scan      — listDriveFolderFiles()
//    ./download-file    — downloadDriveFile()
//    ./download-sheets  — downloadGoogleSheetsAsCsv() + getSheetsTitle()
//    ./import-url       — importFromDriveUrl() main entry point
// ============================================================
export type { DriveFile, DriveImportResult, DriveIdType } from './types';
export { extractDriveId } from './url-parse';
export { listDriveFolderFiles } from './folder-scan';
export { downloadDriveFile } from './download-file';
export { downloadGoogleSheetsAsCsv } from './download-sheets';
export { importFromDriveUrl } from './import-url';
