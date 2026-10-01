// ============================================================
//  GODSPLIT-W3-B: shared contract untuk evaluator rule SQL —
//  split dari rule-evaluation.ts (566 LOC) bersama record-rules.ts
//  + zscore-rules.ts (barrel: ./index.ts, path import publik
//  '@/lib/queries/rule-evaluation' tidak berubah).
//
//  Isi:
//  - SqlRuleFlag — satu-satunya tipe kontrak publik modul (konsumen:
//    run-queries.ts + 4 file post-process-*.ts type-only + test file).
//  - expandRuleFlags — loop flag-expansion yang sebelumnya terduplikasi
//    ×3 di evaluateRulesSql / evaluateHistoricalRulesSql /
//    evaluateWasteRulesSql — kini SATU fungsi bersama (behavior identik:
//    guard Number(...) === 1 + urutan push baris→rule + field order
//    sama dengan loop aslinya).
//
//  NOTE (dedup hist/stats CTE — sengaja TIDAK digabung ke sini):
//  Bentuk CTE hist+stats pada evaluateHistoricalRulesSql vs
//  evaluateWasteRulesSql adalah twins metric-swapped: CTE `hist`
//  berbeda halus (kolom "weeklyDevBom"/source weekly_dev vs
//  "weeklyWasteBom"/weekly_waste). CTE `stats` memang identik
//  byte-per-byte, tapi mengekstraknya sebagai fragmen Prisma.sql yang
//  di-interpolasi justru MERUSAK kontrak test: mock db di
//  tests/queries/rule-evaluation.test.ts menangkap array STRING
//  tagged-template $queryRaw (bukan objek Prisma.Sql terkomposisi),
//  sehingga assertion toContain('SQRT(GREATEST(0, ("sumSq" - n * "mean"
//  * "mean") / (n - 1)))') menuntut teks itu tetap ADA di template
//  literal tiap fungsi. Kedua salinan tetap inline verbatim di
//  zscore-rules.ts. (Lihat audit GODSPLIT-A §3 — "if they differ
//  subtly, keep both with a note".)
// ============================================================

export interface SqlRuleFlag {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
  ruleCode: string;
  severity: string;
  category: string;
  priority: number;
}

// ------------------------------------------------------------
//  expandRuleFlags — deduplicated x3 by GODSPLIT-W3-B.
//  Loop asli tiap evaluator: untuk tiap row hasil query, untuk tiap
//  entry rule map, jika Number(row[col]) === 1 -> push satu
//  SqlRuleFlag. Famili record membawa category per-entry (RULE_MAP);
//  famili zScore memakai category tetap per famili ('HISTORICAL' /
//  'WASTE'). Guard identik: Number(undefined) = NaN != 1 -> baris
//  tanpa kolom f_* tsb (mock lama) tidak pernah fires.
// ------------------------------------------------------------

/** Bentuk baris minimum hasil query flag ketiga evaluator. */
export interface FlaggedRow {
  outletId: number;
  itemId: number;
  akunPenyesuaian: string | null;
}

/** Metadata rule famili record — tiap entry membawa category sendiri. */
export interface RecordRuleMeta {
  col: string;
  code: string;
  severity: string;
  category: string;
  priority: number;
}

/** Metadata rule famili zScore — category tetap per famili (argumen terpisah). */
export interface FixedCategoryRuleMeta {
  col: string;
  code: string;
  severity: string;
  priority: number;
}

/**
 * expandRuleFlags — dua konvensi pemanggilan:
 * - famili record: `expandRuleFlags(rows, RULE_MAP)` — category per-entry.
 * - famili zScore: `expandRuleFlags(rows, HIST_RULE_MAP, 'HISTORICAL')` /
 *   `expandRuleFlags(rows, WASTE_RULE_MAP, 'WASTE')` — category konstan.
 */
export function expandRuleFlags(
  rows: readonly FlaggedRow[],
  ruleMap: readonly (RecordRuleMeta | FixedCategoryRuleMeta)[],
  fixedCategory?: string,
): SqlRuleFlag[] {
  const flags: SqlRuleFlag[] = [];
  for (const row of rows) {
    for (const rule of ruleMap) {
      if (Number(row[rule.col as keyof typeof row]) === 1) {
        flags.push({
          outletId: row.outletId,
          itemId: row.itemId,
          akunPenyesuaian: row.akunPenyesuaian,
          ruleCode: rule.code,
          severity: rule.severity,
          // fixedCategory (famili zScore) ?? category per-entry (famili record);
          // cast compile-time-only — konvensi di atas menjamin salah satu terisi.
          category: fixedCategory ?? (rule as RecordRuleMeta).category,
          priority: rule.priority,
        });
      }
    }
  }
  return flags;
}
