// ============================================================
//  /api/setup — Manual database setup endpoint
//  Call this URL once after deploy to create tables in Turso
//  Usage: https://your-app.vercel.app/api/setup
// ============================================================
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const results: string[] = [];

  try {
    // Test connection
    results.push('Testing Turso connection...');
    const testCount = await db.sourceFile.count();
    results.push(`✅ Connection OK. SourceFile count: ${testCount}`);
  } catch (e: any) {
    results.push(`❌ Connection/Query failed: ${e?.message || String(e)}`);
    results.push('Attempting to create tables...');

    try {
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
      results.push('✅ SourceFile table created');

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
      results.push('✅ Week table created');

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Outlet" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        "outletCode" TEXT NOT NULL,
        area TEXT NOT NULL
      );`);
      results.push('✅ Outlet table created');

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Item" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        satuan TEXT,
        category TEXT
      );`);
      results.push('✅ Item table created');

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
      results.push('✅ InventoryRecord table created');

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
      results.push('✅ Setting table created');

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AuditLog" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        duration INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);
      results.push('✅ AuditLog table created');

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
      results.push('✅ DQIssue table created');

      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AggregationCache" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        "cacheKey" TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);
      results.push('✅ AggregationCache table created');

      // Indexes
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_outlet_week" ON "InventoryRecord"("outletId", "weekId");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_item_week" ON "InventoryRecord"("itemId", "weekId");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_area_week" ON "InventoryRecord"("area", "weekId");`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "idx_inv_month_week" ON "InventoryRecord"("monthLabel", "weekLabel");`);
      results.push('✅ Indexes created');

      // Verify
      const count = await db.sourceFile.count();
      results.push(`✅ Setup complete! SourceFile count: ${count}`);
    } catch (createErr: any) {
      results.push(`❌ Failed to create tables: ${createErr?.message || String(createErr)}`);
    }
  }

  return NextResponse.json({
    success: true,
    message: 'Setup completed',
    steps: results,
  });
}
