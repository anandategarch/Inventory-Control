#!/usr/bin/env bun
// ============================================================
//  Standalone Excel → CSV converter (runs as child process)
//  ----------------------------------------------------------
//  Why separate process? exceljs loads entire workbook into memory.
//  Running in a child process isolates memory from main server.
//  If this OOMs, only this process dies — main server stays alive.
//
//  Usage:
//    bun scripts/convert-excel-to-csv.ts <input.xlsx> <output.csv>
// ============================================================
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';

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

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('Usage: bun convert-excel-to-csv.ts <input.xlsx> <output.csv>');
    process.exit(1);
  }

  console.log(`Converting: ${inputPath} → ${outputPath}`);
  const start = Date.now();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inputPath);

  const ws = wb.worksheets.find((s) => s.state === 'visible') || wb.worksheets[0];
  if (!ws) {
    console.error('No worksheets found');
    process.exit(1);
  }

  // Extract headers
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    headers.push(String(cellToValue(headerRow.getCell(c)) ?? '').trim());
  }

  // Write headers to CSV file
  fs.writeFileSync(outputPath, stringify([headers]));

  // Stream rows to CSV in chunks
  const CHUNK_SIZE = 2000;
  let chunk: string[][] = [];
  let totalRows = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return; // skip header

    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = cellToValue(row.getCell(c));
      values.push(v === null || v === undefined ? '' : String(v));
    }
    chunk.push(values);
    totalRows++;

    if (chunk.length >= CHUNK_SIZE) {
      fs.appendFileSync(outputPath, stringify(chunk));
      chunk = [];
    }
  });

  // Write remaining
  if (chunk.length > 0) {
    fs.appendFileSync(outputPath, stringify(chunk));
  }

  const elapsed = Date.now() - start;
  console.log(`Done: ${totalRows} rows in ${elapsed}ms`);
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e?.message || String(e));
  process.exit(1);
});
