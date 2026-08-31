// ============================================================
//  Ingestion — Excel/CSV File Discovery
//  --------------------------------------------------------
//  Scans a directory for .xlsx / .csv files (excludes Excel
//  lock files starting with `~$`). Returns absolute paths.
//  Returns [] on directory read failure (silent — caller
//  reports "no files found" via the orchestrator).
// ============================================================
import path from 'path';
import fs from 'fs/promises';
import { DATA_DIR } from './safe-path';

export async function findExcelFiles(dirOverride?: string): Promise<string[]> {
  const dir = dirOverride || DATA_DIR;
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.csv')) && !f.startsWith('~$'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
