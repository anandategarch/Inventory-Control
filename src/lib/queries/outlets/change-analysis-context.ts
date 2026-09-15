// ============================================================
//  Change Analysis — route-side context resolution (CHANGE-1)
//  --------------------------------------------------------
//  resolveChangeAnalysisContext — week fallback (the month's
//  LATEST week, numeric ordering) + the running month's
//  monthKey. Shared by both /api/change-analysis routes.
//
//  Split from ./change-analysis.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Stays
//  re-exported from ./change-analysis.ts.
// ============================================================
import { db } from '@/lib/db';

// ------------------------------------------------------------
//  Shared route-side context resolution (both /api/change-analysis
//  routes): week fallback = the month's LATEST week (cumulative-week
//  MAX — same semantics as benchmark-opportunity), and the running
//  month's monthKey (recommendations-route precedent).
// ------------------------------------------------------------
export async function resolveChangeAnalysisContext(
  month: string,
  week: string | null,
): Promise<{ week: string | null; currentMonthKey: string | null }> {
  const [weekRow, currentSourceFile] = await Promise.all([
    week
      ? Promise.resolve<{ w: string | null }[]>([{ w: week }])
      : db.$queryRaw<Array<{ w: string | null }>>`
          -- FIX (BUG-3-c R-8): NUMERIC week ordering, not lexicographic.
          -- MAX("weekLabel") returns "WEEK 9" once WEEK 10+ exists ('1' <
          -- '9' in text order), silently reporting last-month-minus-one as
          -- the fallback week. GROUP BY first (a handful of distinct labels
          -- per month), then order by the leading integer parsed out of the
          -- label — NULLS LAST keeps any malformed label without digits from
          -- outranking real weeks, and the label tiebreak makes the pick
          -- deterministic.
          SELECT ir."weekLabel" as w
          FROM "InventoryRecord" ir
          WHERE ir."monthLabel" = ${month}
          GROUP BY ir."weekLabel"
          ORDER BY SUBSTRING(ir."weekLabel" FROM '[0-9]+')::int DESC NULLS LAST, ir."weekLabel" DESC
          LIMIT 1
        `,
    db.sourceFile.findFirst({
      where: { monthLabel: month },
      select: { monthKey: true },
    }),
  ]);
  return {
    week: weekRow[0]?.w ?? null,
    currentMonthKey: currentSourceFile?.monthKey ?? null,
  };
}
