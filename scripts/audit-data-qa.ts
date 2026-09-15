#!/usr/bin/env bun
// ============================================================
//  audit-data-qa.ts — Data quality audit against Supabase
//  Runs ~17 checklist SQL queries + reports findings as JSON.
//
//  SPLIT-F module map (pure code motion — behavior unchanged):
//    audit-data-qa-lib/context.ts           — Prisma client + out/log/section/raw helpers
//    audit-data-qa-lib/direction-signs.ts   — sections 1–4   (direction & sign checks)
//    audit-data-qa-lib/field-consistency.ts — sections 5–8   (abs fields, residual, pct, tolerance)
//    audit-data-qa-lib/master-data.ts       — sections 9–12  (month/week, outlets/items, PIC, area)
//    audit-data-qa-lib/records-integrity.ts — sections 13–17 (sales, NULL qtys, dupes, FK, structure)
//    audit-data-qa-lib/samples-and-signs.ts — sections 18–21 (sign cross-check + samples + priority)
//    audit-data-qa-lib/distributions.ts     — sections 22–27 (by-month distributions + listings)
//    this file                              — thin entry: ctx setup + orchestration + report save
// ============================================================
import { createDataQaContext } from './audit-data-qa-lib/context';
import {
  section01_directionCounts,
  section02_directionSignMismatch,
  section02a_directionSignMismatchByMonth,
  section03_qtyVsNominalSignMismatch,
  section04_neutralRecords,
} from './audit-data-qa-lib/direction-signs';
import {
  section05_absFieldsConsistency,
  section06_residualQtyCorrectness,
  section07_pctQtyDeviasiToBomSign,
  section08_tolerance,
} from './audit-data-qa-lib/field-consistency';
import {
  section09_monthWeekConsistency,
  section10_outletItemCounts,
  section11_picAssignments,
  section12_areaValues,
} from './audit-data-qa-lib/master-data';
import {
  section13_salesData,
  section14_nullZeroQuantities,
  section15_duplicateRecords,
  section16_fkIntegrity,
  section17_sourceFileWeek,
} from './audit-data-qa-lib/records-integrity';
import {
  section18_nominalDeviasiVsLossSurplus,
  section19_sampleLossRows,
  section20_sampleSurplusRows,
  section21_outletPriorityScore,
} from './audit-data-qa-lib/samples-and-signs';
import {
  section22_directionCountsByMonth,
  section23_weekLabelsByMonth,
  section24_residualNegBreakdown,
  section25_baksoAreaOutlet,
  section26_itemNames,
  section27_outletList,
} from './audit-data-qa-lib/distributions';

const ctx = createDataQaContext();

async function main() {
  await section01_directionCounts(ctx);
  await section02_directionSignMismatch(ctx);
  await section02a_directionSignMismatchByMonth(ctx);
  await section03_qtyVsNominalSignMismatch(ctx);
  await section04_neutralRecords(ctx);
  await section05_absFieldsConsistency(ctx);
  await section06_residualQtyCorrectness(ctx);
  await section07_pctQtyDeviasiToBomSign(ctx);
  await section08_tolerance(ctx);
  await section09_monthWeekConsistency(ctx);
  await section10_outletItemCounts(ctx);
  await section11_picAssignments(ctx);
  await section12_areaValues(ctx);
  await section13_salesData(ctx);
  await section14_nullZeroQuantities(ctx);
  await section15_duplicateRecords(ctx);
  await section16_fkIntegrity(ctx);
  await section17_sourceFileWeek(ctx);
  await section18_nominalDeviasiVsLossSurplus(ctx);
  await section19_sampleLossRows(ctx);
  await section20_sampleSurplusRows(ctx);
  await section21_outletPriorityScore(ctx);
  await section22_directionCountsByMonth(ctx);
  await section23_weekLabelsByMonth(ctx);
  await section24_residualNegBreakdown(ctx);
  await section25_baksoAreaOutlet(ctx);
  await section26_itemNames(ctx);
  await section27_outletList(ctx);

  // Save report
  const reportPath = '/tmp/audit-data-qa-report.txt';
  await Bun.write(reportPath, ctx.out.join('\n'));
  console.log(`\nReport saved to ${reportPath}`);
}

main()
  .catch((e) => { console.error('Audit failed:', e); process.exit(1); })
  .finally(() => ctx.db.$disconnect());
