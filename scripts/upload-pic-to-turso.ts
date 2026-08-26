#!/usr/bin/env bun
// ============================================================
//  upload-pic-to-turso.ts — Upload PIC.csv to OutletPIC table
//  Creates table + inserts data (idempotent: INSERT OR REPLACE)
// ============================================================
import { createClient } from '@libsql/client';
import fs from 'fs';
import { parse } from 'csv-parse';

const DB_URL = process.env.DATABASE_URL;
const DB_TOKEN = process.env.DATABASE_AUTH_TOKEN;
const CSV_PATH = process.argv[2] || './upload/PIC.csv';

if (!DB_URL) {
  console.error('❌ DATABASE_URL not set! Copy .env.example to .env and configure.');
  process.exit(1);
}

const client = createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });

console.log('═══════════════════════════════════════════════');
console.log('  Upload PIC.csv to Turso (OutletPIC table)');
console.log('═══════════════════════════════════════════════');
console.log(`  Database: ${DB_URL}`);
console.log(`  CSV:      ${CSV_PATH}`);
console.log('');

async function createTable() {
  console.log('Creating OutletPIC table...');
  await client.execute(`
    CREATE TABLE IF NOT EXISTS OutletPIC (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outletCode TEXT NOT NULL UNIQUE,
      pic TEXT NOT NULL,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_outlet_pic_pic ON OutletPIC(pic)`);
  console.log('✅ Table ready');
}

async function uploadData() {
  // Read CSV (handle BOM, semicolon delimiter)
  const content = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const rows = content.split('\n').filter((l) => l.trim().length > 0);

  // Skip header row (RESTO;PIC)
  const dataRows = rows.slice(1);
  console.log(`Found ${dataRows.length} data rows`);

  let inserted = 0;
  let skipped = 0;
  const batch: Array<{ sql: string; args: any[] }> = [];

  for (const line of dataRows) {
    // Split by semicolon (handle potential quotes)
    const parts = line.split(';').map((p) => p.trim().replace(/^"|"$/g, ''));
    if (parts.length < 2) { skipped++; continue; }
    const outletCode = parts[0];
    const pic = parts[1];
    if (!outletCode || !pic) { skipped++; continue; }

    batch.push({
      sql: `INSERT OR REPLACE INTO OutletPIC (outletCode, pic, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      args: [outletCode, pic],
    });
    inserted++;
  }

  // Execute in batches of 50
  const BATCH_SIZE = 50;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const chunk = batch.slice(i, i + BATCH_SIZE);
    await client.batch(chunk, 'write');
    process.stdout.write(`\r  📦 ${Math.min(i + BATCH_SIZE, batch.length)}/${batch.length} rows uploaded`);
  }
  console.log('');
  console.log(`✅ Inserted: ${inserted}, Skipped: ${skipped}`);
}

async function verify() {
  const totalRes = await client.execute('SELECT COUNT(*) as c FROM OutletPIC');
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  ✅ UPLOAD COMPLETE!`);
  console.log(`  Total OutletPIC rows: ${totalRes.rows[0].c}`);
  console.log('═══════════════════════════════════════════════');

  // Show unique PICs
  const picsRes = await client.execute('SELECT pic, COUNT(*) as cnt FROM OutletPIC GROUP BY pic ORDER BY cnt DESC');
  console.log('\nPIC distribution:');
  for (const r of picsRes.rows as any[]) {
    console.log(`  ${r.pic}: ${r.cnt} outlets`);
  }

  // Verify JOIN with Outlet table
  const joinRes = await client.execute(`
    SELECT o.code, o.name, o.area, opic.pic
    FROM Outlet o
    LEFT JOIN OutletPIC opic ON o.code = opic.outletCode
    WHERE opic.pic IS NOT NULL
    LIMIT 5
  `);
  console.log('\nSample JOIN result (Outlet + OutletPIC):');
  for (const r of joinRes.rows as any[]) {
    console.log(`  ${r.code} (${r.name}, ${r.area}) → PIC: ${r.pic}`);
  }

  // Count outlets without PIC (no match)
  const noPicRes = await client.execute(`
    SELECT COUNT(*) as c FROM Outlet o
    LEFT JOIN OutletPIC opic ON o.code = opic.outletCode
    WHERE opic.pic IS NULL
  `);
  console.log(`\nOutlets without PIC (no match in OutletPIC table): ${noPicRes.rows[0].c}`);
}

async function main() {
  await createTable();
  await uploadData();
  await verify();
  process.exit(0);
}

main().catch((e) => {
  console.error('❌', e?.message || e);
  process.exit(1);
});
