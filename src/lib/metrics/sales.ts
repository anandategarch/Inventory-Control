// ============================================================
//  SALES METRICS — Single Implementation
//  --------------------------------------------------------
//  Sales per outlet = MODE (most frequent nominalSales value)
//  Tie-break: smaller value wins (konsisten SQL + JS)
//
//  Master context #30: Sales merupakan outlet-level field (deduplicated)
//  Master context #12: Sales vs Deviation untuk context kewajaran
//  Master context #18: Outlet dengan sales tinggi tidak boleh otomatis dianggap buruk
// ============================================================

interface SalesRecord {
  outletId: number;
  nominalSales: number | null;
}

/**
 * Compute Sales per Outlet via MODE
 *
 * MODE = most frequent value per outlet
 * Tie-break: smaller value wins (matches SQL ORDER BY cnt DESC, nominalSales ASC)
 *
 * @param records - array of { outletId, nominalSales }
 * @returns Map<outletId, salesValue>
 */
export function computeSalesModePerOutlet<T extends SalesRecord>(
  records: T[]
): Map<number, number> {
  // Collect all sales values per outlet
  const byOutlet = new Map<number, Map<number, number>>(); // outletId → (salesValue → count)

  for (const r of records) {
    if (r.nominalSales != null && r.nominalSales > 0) {
      let counts = byOutlet.get(r.outletId);
      if (!counts) {
        counts = new Map();
        byOutlet.set(r.outletId, counts);
      }
      // Round to 2 decimal places (preserve rupiah precision, avoid float comparison issues)
      const rounded = Math.round(r.nominalSales * 100) / 100;
      counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
    }
  }

  // Pick MODE (most frequent) per outlet
  // Tie-break: smaller value wins (matches SQL ASC)
  const result = new Map<number, number>();
  for (const [outletId, counts] of byOutlet) {
    let bestVal = Infinity; // Start with Infinity so first entry always wins
    let bestCount = 0;
    for (const [val, count] of counts) {
      // Higher count wins. On tie, smaller value wins.
      if (count > bestCount || (count === bestCount && val < bestVal)) {
        bestVal = val;
        bestCount = count;
      }
    }
    result.set(outletId, bestVal);
  }

  return result;
}

/**
 * Compute total sales across all outlets (sum of per-outlet MODE)
 */
export function computeTotalSales<T extends SalesRecord>(records: T[]): number {
  const salesMap = computeSalesModePerOutlet(records);
  let total = 0;
  for (const v of salesMap.values()) total += v;
  return total;
}

/**
 * SQL MODE CTE template — for use in raw SQL queries
 * This ensures all SQL queries use the same MODE calculation.
 *
 * Usage in SQL:
 *   WITH sales_counts AS (
 *     SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
 *     FROM "InventoryRecord" ir
 *     WHERE ...
 *     GROUP BY ir."outletId", ir."nominalSales"
 *   ),
 *   ranked_sales AS (
 *     SELECT "outletId", "nominalSales",
 *       ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
 *     FROM sales_counts
 *   ),
 *   sales_mode AS (
 *     SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
 *   )
 *   ... use sales_mode in main query ...
 */
export const SALES_MODE_SQL_CTE = `
  WITH sales_counts AS (
    SELECT ir."outletId", ir."nominalSales", COUNT(*) as cnt
    FROM "InventoryRecord" ir
    WHERE ir."nominalSales" IS NOT NULL AND ir."nominalSales" > 0
    GROUP BY ir."outletId", ir."nominalSales"
  ),
  ranked_sales AS (
    SELECT "outletId", "nominalSales",
      ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY cnt DESC, "nominalSales" ASC) as rn
    FROM sales_counts
  ),
  sales_mode AS (
    SELECT "outletId", "nominalSales" as sales FROM ranked_sales WHERE rn = 1
  )
`;
