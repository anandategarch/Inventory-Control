// ============================================================
//  DB — Prisma client singleton with auto-migration
// ============================================================
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

// ============================================================
//  Auto-create tables on first connection
//  This replaces the need for 'prisma db push' at startup
//  Uses raw SQL to create tables if they don't exist
// ============================================================
let _migrated = false;

export async function ensureMigrated() {
  if (_migrated) return;
  _migrated = true;
  
  try {
    // Test if tables exist by running a simple query
    await db.sourceFile.count();
  } catch (e: any) {
    // Tables don't exist — create them with raw SQL
    console.log('[db] Tables not found, creating schema...');
    try {
      // Create tables in dependency order
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SourceFile" (
          id SERIAL PRIMARY KEY,
          "fileName" TEXT NOT NULL UNIQUE,
          "filePath" TEXT NOT NULL,
          "monthLabel" TEXT NOT NULL,
          "monthKey" TEXT NOT NULL,
          "fileHash" TEXT NOT NULL UNIQUE,
          "rowCount" INTEGER NOT NULL DEFAULT 0,
          "dqStatus" TEXT NOT NULL DEFAULT 'OK',
          "dqErrorCount" INTEGER NOT NULL DEFAULT 0,
          "dqWarningCount" INTEGER NOT NULL DEFAULT 0,
          "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Week" (
          id SERIAL PRIMARY KEY,
          "sourceFileId" INTEGER NOT NULL,
          "weekLabel" TEXT NOT NULL,
          "weekKey" TEXT NOT NULL,
          "monthKey" TEXT NOT NULL,
          "periodStart" INTEGER NOT NULL,
          "periodEnd" INTEGER NOT NULL,
          UNIQUE("sourceFileId", "weekLabel")
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Outlet" (
          id SERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          "outletCode" TEXT NOT NULL,
          area TEXT NOT NULL
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Item" (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          satuan TEXT,
          category TEXT
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "InventoryRecord" (
          id SERIAL PRIMARY KEY,
          "sourceFileId" INTEGER NOT NULL,
          "weekId" INTEGER NOT NULL,
          "outletId" INTEGER NOT NULL,
          "itemId" INTEGER NOT NULL,
          "akunPenyesuaian" TEXT,
          status TEXT,
          satuan TEXT,
          "qtyBom" DOUBLE PRECISION,
          "qtyCom" DOUBLE PRECISION,
          "qtyDeviasi" DOUBLE PRECISION,
          "qtyWaste" DOUBLE PRECISION,
          "qtySusut" DOUBLE PRECISION,
          "qtyTrial" DOUBLE PRECISION,
          "qtyLossSurplus" DOUBLE PRECISION,
          "nominalDeviasi" DOUBLE PRECISION,
          "nominalWaste" DOUBLE PRECISION,
          "nominalSusut" DOUBLE PRECISION,
          "nominalTrial" DOUBLE PRECISION,
          "nominalLossSurplus" DOUBLE PRECISION,
          "nominalSales" DOUBLE PRECISION,
          "avgPrice" DOUBLE PRECISION,
          "tolerancePct" DOUBLE PRECISION,
          "toleranceRaw" TEXT,
          "pctWasteSusut" DOUBLE PRECISION,
          "pctQtyDeviasiToBom" DOUBLE PRECISION,
          "pctQtyWasteToBom" DOUBLE PRECISION,
          "pctQtySusutToBom" DOUBLE PRECISION,
          "pctQtyTrialToBom" DOUBLE PRECISION,
          "pctQtyLossToBom" DOUBLE PRECISION,
          direction TEXT,
          "residualQty" DOUBLE PRECISION,
          "residualNominal" DOUBLE PRECISION,
          "residualRatio" DOUBLE PRECISION,
          "absQtyDeviasi" DOUBLE PRECISION,
          "absNominalDeviasi" DOUBLE PRECISION,
          "absQtyLossSurplus" DOUBLE PRECISION,
          "absNominalLossSurplus" DOUBLE PRECISION,
          area TEXT NOT NULL,
          bulan TEXT NOT NULL,
          "bulan2" TEXT,
          "weekLabel" TEXT NOT NULL,
          "monthLabel" TEXT NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE("weekId", "outletId", "itemId", "akunPenyesuaian")
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Setting" (
          id SERIAL PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          category TEXT NOT NULL,
          label TEXT NOT NULL,
          description TEXT,
          "dataType" TEXT NOT NULL,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedBy" TEXT
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "AuditLog" (
          id SERIAL PRIMARY KEY,
          action TEXT NOT NULL,
          detail TEXT NOT NULL,
          duration INTEGER,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "DQIssue" (
          id SERIAL PRIMARY KEY,
          "sourceFileId" INTEGER NOT NULL,
          "weekId" INTEGER,
          "outletId" INTEGER,
          "itemId" INTEGER,
          severity TEXT NOT NULL,
          code TEXT NOT NULL,
          message TEXT NOT NULL,
          "rawValue" TEXT,
          "rowNumber" INTEGER,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "AggregationCache" (
          id SERIAL PRIMARY KEY,
          "cacheKey" TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      // Create indexes for performance
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
