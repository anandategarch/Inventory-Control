// ============================================================
//  Ingestion — Path Safety + Data Directory
//  --------------------------------------------------------
//  DATA_DIR: Vercel uses /tmp (only writable dir in serverless);
//  local dev uses data/inventory.
//
//  safePath: Bug 1 fix — Path Traversal protection. Resolves input
//  path against DATA_DIR and rejects anything escaping that dir.
//  FIX (AUDIT-SECURITY-PERF H3): tightened /tmp allow-list from
//  the previous `startsWith('/tmp/')` (which allowed ANY /tmp file)
//  to a specific list of allowed subdirs.
// ============================================================
import path from 'path';
import { logger } from '../logger';

// Vercel: /tmp is the only writable directory in serverless
// Local: use data/inventory folder
export const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : process.env.VERCEL
    ? '/tmp/inventory'
    : path.resolve(process.cwd(), 'data/inventory');

// Bug 1 fix: Path Traversal protection
export function safePath(inputPath: string): string | null {
  const resolved = path.resolve(inputPath);
  const dataDirResolved = path.resolve(DATA_DIR);
  if (resolved.startsWith(dataDirResolved + path.sep) || resolved === dataDirResolved) {
    return resolved;
  }
  if (process.env.VERCEL) {
    // FIX (AUDIT-SECURITY-PERF H3): was `resolved.startsWith('/tmp/')` — too broad,
    // attacker could access ANY file under /tmp/. Restrict to allowed subdirs only.
    const ALLOWED_TMP_SUBDIRS = ['/tmp/inventory/', '/tmp/ingest-process/'];
    if (ALLOWED_TMP_SUBDIRS.some(d => resolved.startsWith(d))) {
      return resolved;
    }
  }
  if (inputPath.includes('..') || inputPath.startsWith('~') || path.isAbsolute(inputPath) && !resolved.startsWith(dataDirResolved)) {
    logger.error("[ingest] Path traversal blocked", { error: inputPath });
    return null;
  }
  return path.join(dataDirResolved, inputPath);
}
