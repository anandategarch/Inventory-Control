// ============================================================
//  Drive Import — single file download
//  ----------------------------------------------------------
//  Download a single file from Google Drive.
//  Handles "virus scan warning" for large files via multiple strategies.
//
//  SPLIT-D (pure code motion): moved verbatim from
//  src/lib/drive-import.ts (old file deleted; '@/lib/drive-import'
//  now resolves to this folder's index.ts barrel — same path).
// ============================================================
import path from 'path';
import fs from 'fs/promises';
import { FETCH_TIMEOUT_MS, readTextCapped, pipelineWithByteCap } from './http-safety';

export async function downloadDriveFile(
  fileId: string,
  fileName: string,
  destDir: string
): Promise<{ localPath: string; size: number }> {
  await fs.mkdir(destDir, { recursive: true });
  // Bug: sanitize fileName — Google Drive title could contain path traversal chars
  const safeFileName = path.basename(fileName).replace(/[^\w.\- ]/g, '_');
  const localPath = path.join(destDir, safeFileName);

  // Strategy 1: Try the direct usercontent URL (most reliable for public files)
  // Google Drive redirects uc?export=download → drive.usercontent.google.com/download?id=
  // We hit the redirect target directly to avoid cookie/redirect issues.
  const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

  let res = await fetch(directUrl, {
    // FIX (BUG-3-c SEDANG-2): 60s abort — a hung Drive connection used to
    // stall until the 300s maxDuration kill.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    // FIX (BUG-3-c SEDANG-2): the virus-scan interstitial is a small form
    // page — bounded read instead of a raw res.text().
    const html = await readTextCapped(res, 512 * 1024);

    // Try to extract confirm token from form action
    // Bug 5 fix: limit [^"]* to {0,500} to prevent ReDoS
    const confirmMatch = html.match(/action="([^"]{0,500}confirm=([^"&]{1,100})[^"]{0,500})"/);
    if (confirmMatch) {
      const confirmUrl = confirmMatch[1].replace(/&amp;/g, '&');
      // FIX (AUDIT-SECURITY-PERF H2): validate confirmUrl hostname against Google
      // domains before fetching — prevents SSRF via malicious confirm-token URL
      // (attacker could craft a form action pointing to internal services).
      const ALLOWED_DOMAINS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
      let confirmParsed: URL;
      try {
        confirmParsed = new URL(confirmUrl);
      } catch {
        throw new Error(`Invalid confirm URL from Google response`);
      }
      const confirmAllowed = ALLOWED_DOMAINS.some(d => confirmParsed.hostname === d || confirmParsed.hostname.endsWith('.' + d));
      if (!confirmAllowed) {
        throw new Error(`Confirm URL hostname "${confirmParsed.hostname}" not in Google allowlist — possible SSRF`);
      }
      res = await fetch(confirmUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    const sample = (await readTextCapped(res, 4 * 1024)).slice(0, 200);
    throw new Error(`Got HTML page instead of file. File may require sign-in or is not shared publicly. Sample: ${sample}`);
  }

  // Stream the file to disk
  // FIX (BUG-3-c SEDANG-2): byte-capped pipeline — destroys the stream and
  // rejects once the download exceeds MAX_DOWNLOAD_BYTES (partial file is
  // unlinked), so a hostile/misbehaving endpoint can't fill /tmp.
  if (!res.body) throw new Error('No response body');
  await pipelineWithByteCap(res, localPath);

  const stat = await fs.stat(localPath);
  // Sanity check — file should be at least 1KB (valid xlsx is typically >5KB)
  if (stat.size < 1024) {
    const content = await fs.readFile(localPath, 'utf-8');
    await fs.unlink(localPath);
    throw new Error(`Downloaded file too small (${stat.size} bytes). Content: ${content.slice(0, 200)}`);
  }

  return { localPath, size: stat.size };
}
