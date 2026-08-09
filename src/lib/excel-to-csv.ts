// ============================================================
//  Excel → CSV Converter
//  ----------------------------------------------------------
//  Uses child_process to run conversion in isolated memory.
//  exceljs loads entire workbook into memory (~80MB for 15MB file),
//  so running in child process prevents main server from OOM.
//
//  Also supports Google Sheets → CSV directly (no Excel parsing!)
//  via /export?format=csv endpoint.
// ============================================================
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';

export interface ConvertResult {
  csvPath: string;
  rowCount: number;
  sheetName: string;
}

// ============================================================
//  Convert Excel to CSV via child process (isolated memory)
// ============================================================
export async function convertExcelToCsv(
  excelPath: string,
  csvPath: string
): Promise<ConvertResult> {
  const scriptPath = path.resolve(process.cwd(), 'scripts/convert-excel-to-csv.ts');

  return new Promise((resolve, reject) => {
    // Spawn bun process with increased memory limit
    const child = spawn('bun', ['run', scriptPath, excelPath, csvPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=512',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        // Parse row count from stdout
        const match = stdout.match(/Done: (\d+) rows/);
        const rowCount = match ? parseInt(match[1]) : 0;
        resolve({
          csvPath,
          rowCount,
          sheetName: 'Sheet1',
        });
      } else {
        reject(new Error(`Conversion failed (exit ${code}): ${stderr || stdout}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn conversion process: ${err.message}`));
    });

    // Timeout: 5 minutes
    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Conversion timed out after 5 minutes'));
    }, 300000);
  });
}

// ============================================================
//  Generate CSV path from Excel path (same dir, .csv extension)
// ============================================================
export function getCsvPath(excelPath: string): string {
  const dir = path.dirname(excelPath);
  const base = path.basename(excelPath, path.extname(excelPath));
  return path.join(dir, `${base}.csv`);
}

// ============================================================
//  Generate cached CSV path (includes file hash for versioning)
// ============================================================
export function getCachedCsvPath(excelPath: string, fileHash: string): string {
  const dir = path.dirname(excelPath);
  const base = path.basename(excelPath, path.extname(excelPath));
  return path.join(dir, `${base}.${fileHash.slice(0, 8)}.csv`);
}

export function csvCacheExists(csvPath: string): boolean {
  try {
    return fs.existsSync(csvPath) && fs.statSync(csvPath).size > 0;
  } catch {
    return false;
  }
}
