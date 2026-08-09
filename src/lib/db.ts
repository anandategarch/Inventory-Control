// ============================================================
//  DB — Prisma client with Turso (libsql) adapter
//  Works with:
//    - Turso cloud (libsql://...) — for Vercel/Railway production
//    - Local SQLite (file:...) — for local dev
// ============================================================
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';

function createPrismaClient(): PrismaClient {
  const dbUrl = process.env.DATABASE_URL || 'file:./db/custom.db';

  // If Turso (libsql://), use adapter
  if (dbUrl.startsWith('libsql://') || dbUrl.startsWith('http://') || dbUrl.startsWith('https://')) {
    const libsql = createClient({
      url: dbUrl,
      authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    });
    const adapter = new PrismaLibSql(libsql);
    return new PrismaClient({ adapter, log: ['error', 'warn'] });
  }

  // Local SQLite (file:...) — standard Prisma
  return new PrismaClient({ log: ['error', 'warn'] });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

// ============================================================
//  Auto-create tables on first connection
// ============================================================
let _migrated = false;

export async function ensureMigrated() {
  if (_migrated) return;
  _migrated = true;

  try {
    await db.sourceFile.count();
  } catch (e: any) {
    console.log('[db] Tables not found, creating schema...');
    try {
      // Create tables (compatible with both SQLite and Turso)
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SourceFile" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "fileName" TEXT NOT NULL UNIQUE,
        "filePath" TEXT NOT NULL,
        "monthLabel" TEXT NOT NULL,
        "monthKey" TEXT NOT NULL,
        "fileHash" TEXT NOT NULL UNIQUE,
        "rowCount" INTEGER NOT NULL DEFAULT 0,
        "dqStatus" TEXT NOT NULL DEFAULT 'OK',
        "dqErrorCount" INTEGER NOT NULL DEFAULT 0,
        "dqWarningCount" INTEGER NOT NULL DEFAULT 0,
        "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Week" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "sourceFileId" INTEGER NOT NULL,
        "weekLabel" TEXT NOT NULL,
        "weekKey" TEXT NOT NULL,
        "monthKey" TEXT NOT NULL,
        "periodStart" INTEGER NOT NULL,
        "periodEnd" INTEGER NOT NULL,
        UNIQUE("sourceFileId", "weekLabel")
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Outlet" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        "outletCode" TEXT NOT NULL,
        area TEXT NOT NULL
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Item" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        satuan TEXT,
        category TEXT
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "InventoryRecord" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "sourceFileId" INTEGER NOT NULL,
        "weekId" INTEGER NOT NULL,
        "outletId" INTEGER NOT NULL,
        "itemId" INTEGER NOT NULL,
        "akunPenyesuaian" TEXT,
        status TEXT,
        satuan TEXT,
        "qtyBom" REAL,
        "qtyCom" REAL,
        "qtyDeviasi" REAL,
        "qtyWaste" REAL,
        "qtySusut" REAL,
        "qtyTrial" REAL,
        "qtyLossSurplus" REAL,
        "nominalDeviasi" REAL,
        "nominalWaste" REAL,
        "nominalSusut" REAL,
        "nominalTrial" REAL,
        "nominalLossSurplus" REAL,
        "nominalSales" REAL,
        "avgPrice" REAL,
        "tolerancePct" REAL,
        "toleranceRaw" TEXT,
        "pctWasteSusut" REAL,
        "pctQtyDeviasiToBom" REAL,
        "pctQtyWasteToBom" REAL,
        "pctQtySusutToBom" REAL,
        "pctQtyTrialToBom" REAL,
        "pctQtyLossToBom" REAL,
        direction TEXT,
        "residualQty" REAL,
        "residualNominal" REAL,
        "residualRatio" REAL,
        "absQtyDeviasi" REAL,
        "absNominalDeviasi" REAL,
        "absQtyLossSurplus" REAL,
        "absNominalLossSurplus" REAL,
        area TEXT NOT NULL,
        bulan TEXT NOT NULL,
        "bulan2" TEXT,
        "weekLabel" TEXT NOT NULL,
        "monthLabel" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE("weekId", "outletId", "itemId", "akunPenyesuaian")
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Setting" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        "dataType" TEXT NOT NULL,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedBy" TEXT
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AuditLog" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        duration INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DQIssue" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "sourceFileId" INTEGER NOT NULL,
        "weekId" INTEGER,
        "outletId" INTEGER,
        "itemId" INTEGER,
        severity TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        "rawValue" TEXT,
        "rowNumber" INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AggregationCache" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "cacheKey" TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);

      // Indexes
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_outlet_week" ON "InventoryRecord"("outletId", "weekId");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_item_week" ON "InventoryRecord"("itemId", "weekId");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_area_week" ON "InventoryRecord"("area", "weekId");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_month_week" ON "InventoryRecord"("monthLabel", "weekLabel");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_direction" ON "InventoryRecord"("direction");`);

      console.log('[db] Schema created successfully');
    } catch (createErr) {
      console.error('[db] Failed to create schema:', createErr);
    }
  }
}
