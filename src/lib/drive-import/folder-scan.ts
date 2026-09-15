// ============================================================
//  Drive Import — folder listing + HTML parsing
//  ----------------------------------------------------------
//  List files in a public Google Drive folder using the embedded
//  folder view (no API key required), then parse the HTML to
//  extract .xlsx entries.
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
import { FOLDER_LIST_TIMEOUT_MS, readTextCapped } from './http-safety';
import type { DriveFile } from './types';

export async function listDriveFolderFiles(folderId: string): Promise<DriveFile[]> {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  const res = await fetch(url, {
    // FIX (BUG-3-c SEDANG-2): folder listing is one small HTML page — 30s
    // abort keeps a hung connection from eating the route's 300s budget.
    signal: AbortSignal.timeout(FOLDER_LIST_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch folder listing: HTTP ${res.status}`);
  }
  // FIX (BUG-3-c SEDANG-2): bounded read — the listing HTML grows with the
  // file count, so cap it generously (a folder with 10k entries ≈ 2-4MB).
  const html = await readTextCapped(res, 5 * 1024 * 1024);

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
  // Bug 5 fix: limit [^>]* to {0,500} to prevent ReDoS catastrophic backtracking
  const entryStartRegex = /<div class="flip-entry"[^>]{0,500}id="entry-([^"]{1,100})"[^>]{0,500}>/g;
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
    // Bug 5 fix: limit [^"\/]+ to {1,200}
    const fileLinkMatch = block.match(/href="https:\/\/drive\.google\.com\/file\/d\/([^"\/]{1,200})\/view/);
    const realFileId = fileLinkMatch ? fileLinkMatch[1] : starts[i].fileId;

    // Extract filename from flip-entry-title
    // Bug 5 fix: limit [^<]+ to {1,300}
    const titleMatch = block.match(/class="flip-entry-title">([^<]{1,300})</);
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
