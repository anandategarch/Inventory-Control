// ============================================================
//  Google Drive Import Service
//  ----------------------------------------------------------
//  Reads folder/file links from Google Drive (public links only),
//  downloads .xlsx files, and feeds them to the existing ingestion pipeline.
//
//  Supported URL formats:
//    - Folder: https://drive.google.com/drive/folders/{FOLDER_ID}
//    - File:   https://drive.google.com/file/d/{FILE_ID}/view
//    - File:   https://drive.google.com/open?id={FILE_ID}
//    - File:   https://drive.google.com/uc?id={FILE_ID}
// ============================================================
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

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

// ============================================================
//  Extract folder/file ID from various Google Drive URL formats
// ============================================================
export function extractDriveId(url: string): { type: 'folder' | 'file'; id: string } | null {
  if (!url) return null;
  const trimmed = url.trim();

  // Folder: https://drive.google.com/drive/folders/{ID}
  let m = trimmed.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'folder', id: m[1] };

  // Folder with query: https://drive.google.com/drive/folders/{ID}?usp=sharing
  m = trimmed.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)\?/);
  if (m) return { type: 'folder', id: m[1] };

  // File: https://drive.google.com/file/d/{ID}/view
  m = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'file', id: m[1] };

  // Open: https://drive.google.com/open?id={ID}
  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return { type: 'file', id: m[1] };

  // Raw ID only (44 chars typical)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return { type: 'file', id: trimmed };
  }

  return null;
}

// ============================================================
//  List files in a public Google Drive folder
//  Uses the embedded folder view (no API key required)
// ============================================================
export async function listDriveFolderFiles(folderId: string): Promise<DriveFile[]> {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch folder listing: HTTP ${res.status}`);
  }
  const html = await res.text();

  // ============================================================
  //  Parse HTML — each file entry has this structure:
  //    <div class="flip-entry" id="entry-{FILE_ID}" ...>
  //      <a href="https://drive.google.com/file/d/{FILE_ID}/view?usp=drive_web" ...>
  //        ...
  //        <div class="flip-entry-title">{FILENAME}</div>
  //      </a>
  //    </div>
  //
  //  Strategy: extract (entry_id, file_id) pairs via the reliable file/d/ link,
  //  then match each to its filename via the flip-entry-title.
  // ============================================================
  const files: DriveFile[] = [];

  // Find all entry blocks — each starts with <div class="flip-entry" id="entry-... and ends before the next one
  const entryBlocks: Array<{ fileId: string; block: string }> = [];
  const entryStartRegex = /<div class="flip-entry"[^>]*id="entry-([^"]+)"[^>]*>/g;
  const starts: Array<{ fileId: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = entryStartRegex.exec(html)) !== null) {
    starts.push({ fileId: m[1], index: m.index });
  }

  // For each entry, extract the block from its start to the next entry's start (or end of html)
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const block = html.slice(start, end);

    // Verify the file ID appears in a file/d/ link (confirms it's a real file, not a folder/sub-element)
    const fileLinkMatch = block.match(/href="https:\/\/drive\.google\.com\/file\/d\/([^"\/]+)\/view/);
    const realFileId = fileLinkMatch ? fileLinkMatch[1] : starts[i].fileId;

    // Extract filename from flip-entry-title
    const titleMatch = block.match(/class="flip-entry-title">([^<]+)</);
    if (titleMatch) {
      const name = titleMatch[1].trim();
      if (name.toLowerCase().endsWith('.xlsx') && !name.startsWith('~$')) {
        files.push({
          id: realFileId,
          name,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
    }
  }

  // Deduplicate by file ID (in case of duplicate matches)
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  return unique;
}

// ============================================================
//  Download a single file from Google Drive
//  Handles "virus scan warning" for large files via multiple strategies
// ============================================================
export async function downloadDriveFile(
  fileId: string,
  fileName: string,
  destDir: string
): Promise<{ localPath: string; size: number }> {
  await fs.mkdir(destDir, { recursive: true });
  const localPath = path.join(destDir, fileName);

  // Strategy 1: Try the direct usercontent URL (most reliable for public files)
  // Google Drive redirects uc?export=download → drive.usercontent.google.com/download?id=
  // We hit the redirect target directly to avoid cookie/redirect issues.
  const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

  let res = await fetch(directUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/octet-stream, application/binary, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  // Strategy 2: If we got HTML (virus scan page), parse for confirm token
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const html = await res.text();

    // Try to extract confirm token from form action
    const confirmMatch = html.match(/action="([^"]*confirm=([^"&]+)[^"]*)"/);
    if (confirmMatch) {
      const confirmUrl = confirmMatch[1].replace(/&amp;/g, '&');
      res = await fetch(confirmUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': res.headers.get('set-cookie') || '',
        },
        redirect: 'follow',
      });
    } else {
      // Strategy 3: Try uc?export=download with confirm=t
      const altUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
      res = await fetch(altUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        redirect: 'follow',
      });
    }
  }

  // Final check — if still HTML, file is not accessible
  const finalContentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  if (finalContentType.includes('text/html')) {
    const sample = (await res.text()).slice(0, 200);
    throw new Error(`Got HTML page instead of file. File may require sign-in or is not shared publicly. Sample: ${sample}`);
  }

  // Stream the file to disk
  if (!res.body) throw new Error('No response body');
  const stream = Readable.fromWeb(res.body as any);
  const fileStream = createWriteStream(localPath);
  await pipeline(stream, fileStream);

  const stat = await fs.stat(localPath);
  // Sanity check — file should be at least 1KB (valid xlsx is typically >5KB)
  if (stat.size < 1024) {
    const content = await fs.readFile(localPath, 'utf-8');
    await fs.unlink(localPath);
    throw new Error(`Downloaded file too small (${stat.size} bytes). Content: ${content.slice(0, 200)}`);
  }

  return { localPath, size: stat.size };
}

// ============================================================
//  Main entry point: import from Google Drive URL
// ============================================================
export async function importFromDriveUrl(
  url: string,
  destDir: string
): Promise<DriveImportResult> {
  const parsed = extractDriveId(url);
  if (!parsed) {
    throw new Error('Invalid Google Drive URL. Please provide a folder or file link from drive.google.com');
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
      } catch (e: any) {
        downloadedFiles.push({
          fileName: file.name,
          localPath: '',
          size: 0,
          success: false,
          error: e?.message || String(e),
        });
      }
    }

    return { folderId: parsed.id, downloadedFiles };
  } else {
    // Single file
    try {
      // First, get file name from Drive metadata
      const metaRes = await fetch(`https://drive.google.com/file/d/${parsed.id}/view`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      let fileName = `drive_file_${parsed.id}.xlsx`;
      if (metaRes.ok) {
        const html = await metaRes.text();
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
    } catch (e: any) {
      downloadedFiles.push({
        fileName: '',
        localPath: '',
        size: 0,
        success: false,
        error: e?.message || String(e),
      });
    }

    return { folderId: null, downloadedFiles };
  }
}
