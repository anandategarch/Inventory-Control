// ============================================================
//  Excel → CSV Converter
//  ----------------------------------------------------------
//  On Vercel/serverless: use in-process conversion (no spawn)
//  On local/Railway: use child_process for isolated memory
// ============================================================
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';

export interface ConvertResult {
  csvPath: string;
  rowCount: number;
  sheetName: string;
}

function cellToValue(cell: ExcelJS.Cell): unknown {
  let v: unknown = cell.value;
  if (v && typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) {
      v = v.richText.map((t) => t.text).join('');
    } else if ('text' in v && typeof v.text === 'string') {
      v = v.text;
    } else if ('result' in v && v.result !== undefined) {
      v = v.result;
    } else if ('formula' in v) {
      v = cell.result ?? null;
    } else {
      v = JSON.stringify(v);
    }
  }
  return v;
}

// In-process conversion (for Vercel serverless)
async function convertInProcess(excelPath: string, csvPath: string): Promise<ConvertResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);

  const ws = wb.worksheets.find((s) => s.state === 'visible') || wb.worksheets[0];
  if (!ws) {
    throw new Error('No worksheets found in Excel file');
  }

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    headers.push(String(cellToValue(headerRow.getCell(c)) ?? '').trim());
  }

  // Bug 4 fix: use writeFileSync for header (small data, <1KB)
  // appendFileSync below is also sync but chunked at 2000 rows
  // Full async refactor would require changing all fs.* calls to fs/promises
  fs.writeFileSync(csvPath, stringify([headers]));

  const CHUNK_SIZE = 2000;
  let chunk: string[][] = [];
  let totalRows = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;

    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = cellToValue(row.getCell(c));
      values.push(v === null || v === undefined ? '' : String(v));
    }
    chunk.push(values);
    totalRows++;

    if (chunk.length >= CHUNK_SIZE) {
      fs.appendFileSync(csvPath, stringify(chunk));
      chunk = [];
    }
  });

  if (chunk.length > 0) {
    fs.appendFileSync(csvPath, stringify(chunk));
  }

  return { csvPath, rowCount: totalRows, sheetName: ws.name };
}

// Child process conversion (for local/Railway with more memory)
async function convertViaChildProcess(excelPath: string, csvPath: string): Promise<ConvertResult> {
  const scriptPath = path.resolve(process.cwd(), 'scripts/convert-excel-to-csv.ts');

  return new Promise((resolve, reject) => {
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
        const match = stdout.match(/Done: (\d+) rows/);
        const rowCount = match ? parseInt(match[1]) : 0;
        resolve({ csvPath, rowCount, sheetName: 'Sheet1' });
      } else {
        reject(new Error(`Conversion failed (exit ${code}): ${stderr || stdout}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn conversion process: ${err.message}`));
    });

    // Bug 5.4 fix: store timer so it can be cleared on success/error
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Conversion timed out after 5 minutes'));
    }, 300000);

    // Clear timer when child exits (success or error) to prevent leak
    child.on('exit', () => clearTimeout(timer));
  });
}

// Main entry — auto-detect environment
export async function convertExcelToCsv(
  excelPath: string,
  csvPath: string
): Promise<ConvertResult> {
  // Vercel serverless doesn't support child_process
  if (process.env.VERCEL) {
    return convertInProcess(excelPath, csvPath);
  }
  return convertViaChildProcess(excelPath, csvPath);
}

export function getCsvPath(excelPath: string): string {
  const dir = path.dirname(excelPath);
  const base = path.basename(excelPath, path.extname(excelPath));
  return path.join(dir, `${base}.csv`);
}

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
