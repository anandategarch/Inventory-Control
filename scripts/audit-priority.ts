#!/usr/bin/env bun
// Run real outlets.ts queryRestoRecommendations to verify priority scoring
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient({ log: ['error'] });
import { queryRestoRecommendations } from '../src/lib/queries/outlets';

async function main() {
  const recs = await queryRestoRecommendations(
    'MEI 2026', 'WEEK 4', null, null,
    { area: null, outletCode: null, itemName: null, picOutletCodes: null },
    20,
  );
  console.log(`\n=== Real priority scores (MEI 2026 WEEK 4) ===`);
  for (const r of recs) {
    console.log(`  ${r.outletCode} (${r.outletName}) → score=${r.priorityScore} level=${r.priorityLevel} | dir=${r.metrics.direction} | lossRp=${r.metrics.totalLoss} | surplusRp=${r.metrics.totalSurplus} | sales=${r.metrics.sales} | sigs: devBom=${r.signals.devBomRatio?.toFixed(2)}×, residual=${(r.signals.residualRatio*100).toFixed(0)}%, lossToSales=${(r.signals.lossToSales*100).toFixed(1)}%, tolBreachHigh=${r.signals.toleranceBreachHighCount}, highLoss=${r.signals.highLossItemCount}, overExp=${r.signals.overExplainedCount}`);
  }

  // Check scoring range across all outlets
  const scores = recs.map(r => r.priorityScore);
  console.log(`\nPriority score range: min=${Math.min(...scores)}, max=${Math.max(...scores)}`);
  console.log(`TINGGI (>=55): ${recs.filter(r => r.priorityLevel === 'TINGGI').length}`);
  console.log(`SEDANG (>=30): ${recs.filter(r => r.priorityLevel === 'SEDANG').length}`);
  console.log(`RENDAH (<30): ${recs.filter(r => r.priorityLevel === 'RENDAH').length}`);
}

main().finally(() => db.$disconnect());
