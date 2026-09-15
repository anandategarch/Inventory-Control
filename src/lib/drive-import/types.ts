// ============================================================
//  Drive Import — shared types
//  ----------------------------------------------------------
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

export interface DriveImportResult {
  folderId: string | null;
  downloadedFiles: Array<{
    fileName: string;
    localPath: string;
    size: number;
    success: boolean;
    error?: string;
  }>;
}

export type DriveIdType = { type: 'folder' | 'file' | 'sheets'; id: string };
