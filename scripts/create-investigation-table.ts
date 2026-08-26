#!/usr/bin/env bun
// ============================================================
//  create-investigation-table.ts — Create Investigation table in Turso
//  Stores persistent investigation workflow state per worklist item.
//  worklistKey = "outletCode|itemName|monthLabel|weekLabel" (composite key)
//  status: OPEN | INVESTIGATING | RESOLVED
// ============================================================
import { createClient } from '@libsql/client';

const DB_URL = process.env.DATABASE_URL;
const DB_TOKEN = process.env.DATABASE_AUTH_TOKEN;

if (!DB_URL) {
  console.error('❌ DATABASE_URL not set!');
  process.exit(1);
}

const client = createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });

const DDL = `
CREATE TABLE IF NOT EXISTS Investigation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worklistKey TEXT NOT NULL,
  outletCode TEXT NOT NULL,
  itemName TEXT NOT NULL,
  monthLabel TEXT NOT NULL,
  weekLabel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'P3',
  notes TEXT,
  assignedTo TEXT,
  resolvedAt DATETIME,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_investigation_worklistKey ON Investigation(worklistKey);
CREATE INDEX IF NOT EXISTS idx_investigation_status ON Investigation(status);
CREATE INDEX IF NOT EXISTS idx_investigation_outlet ON Investigation(outletCode);
`;

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Create Investigation table in Turso');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Database: ${DB_URL}`);

  try {
    // Split DDL into individual statements (libsql doesn't support multi-statement exec)
    const statements = DDL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await client.execute(stmt);
      console.log(`  ✓ Executed: ${stmt.split('\n')[0].slice(0, 60)}...`);
    }
    console.log('');
    console.log('✅ Investigation table created successfully.');
  } catch (e) {
    console.error('❌ Failed to create Investigation table:', e);
    process.exit(1);
  }
}

main();
