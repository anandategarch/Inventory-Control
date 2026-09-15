// ============================================================
//  Change Analysis — item-level attribution (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  queryOutletChangeItems — attribute ONE outlet's current
//  deviation move to its items (Ide 1+2+3 of DESIGN-1).
//  Semantics doc: see ./change-analysis.ts header.
//
//  Split from ./change-analysis.ts (SPLIT-E — pure code motion;
//  SQL, comments and behavior preserved verbatim). Public
//  symbols stay re-exported from ./change-analysis.ts.
// ============================================================
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import {
  computeChangeStats,
  classifyChange,
  type ChangeSeriesPoint,
  type ChangeStats,
  type ChangeStatus,
  type ChangeThresholds,
} from './change-analysis-stats';
import type { OutletChangeRow } from './change-analysis-outlet-ranking';

// ------------------------------------------------------------
//  Item-level attribution (ONE scan for one outlet).
// ------------------------------------------------------------
/** One item row of the change attribution table. */
export interface ItemChangeRow {
  itemName: string;
  satuan: string | null;
  pairs: number;
  avgSwingNominal: number;
  avgSwingQty: number;
  deltaNominal: number | null;
  deltaQty: number | null;
  deltaPctNominal: number | null;
  swingNominal: number | null;
  ratioNominal: number | null;
  ratioQty: number | null;
  isFlip: boolean;
  isNew: boolean;
  /** classifyChange === ANOMALI | BARU_BERGERAK (badge-worthy movement vs its own habit). */
  isAnomali: boolean;
  /** Sign of the item's Δ magnitude opposes the outlet's (the cancellers — Ide 3). */
  opposesOutlet: boolean;
  /** swingNominal / Σ item swings × 100 (share of the outlet's gross movement). */
  contributionPct: number | null;
}

/** Response of queryOutletChangeItems (also the /api/change-analysis/items payload). */
export interface ChangeAnalysisItemsResult {
  month: string;
  week: string;
  outlet: OutletChangeRow | null;
  items: ItemChangeRow[];
}

interface ItemScanRow {
  outletCode: string;
  outletName: string;
  itemName: string;
  satuan: string | null;
  monthKey: string;
  nd: number | bigint | null;
  qd: number | bigint | null;
}

/**
 * Attribute ONE outlet's current deviation move to its items (Ide 1+2+3 of
 * DESIGN-1): per-item Δ vs its own average Δ (badge), swing share
 * (contribution), and whether the item's move opposes the outlet's net move
 * (the hidden cancellers). The outlet's own stats ride along in the same
 * response — derived additively from the item rows (TASK H-7: both deviation
 * sums are genuine per-row data), so ONE query serves everything.
 */
export async function queryOutletChangeItems(opts: {
  month: string;
  week: string;
  currentMonthKey: string;
  outletCode: string;
  filters: SqlFilterOpts;
  thresholds: ChangeThresholds;
}): Promise<ChangeAnalysisItemsResult> {
  const f = buildSqlFilters({ ...opts.filters, outletCode: opts.outletCode });
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<ItemScanRow[]>`
    SELECT
      MIN(o.code) as "outletCode",
      MIN(o.name) as "outletName",
      i.name as "itemName",
      MAX(ir."satuan") as "satuan",
      sf."monthKey" as "monthKey",
      COALESCE(SUM(ir."nominalDeviasi") FILTER (WHERE ir."nominalDeviasi" IS NOT NULL), 0) as nd,
      COALESCE(SUM(ir."qtyDeviasi") FILTER (WHERE ir."qtyDeviasi" IS NOT NULL), 0) as qd
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    JOIN "Item" i ON ir."itemId" = i.id
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${opts.week}
      AND sf."monthKey" <= ${opts.currentMonthKey}
      ${f}
    GROUP BY i.name, sf."monthKey"
    ORDER BY i.name, sf."monthKey"
  `);

  if (rows.length === 0) {
    return { month: opts.month, week: opts.week, outlet: null, items: [] };
  }

  const outletCode = rows[0]?.outletCode ?? opts.outletCode;
  const outletName = rows[0]?.outletName ?? opts.outletCode;

  // Per-item series + the outlet-total series (additive sums per month).
  const byItem = new Map<string, { satuan: string | null; points: ChangeSeriesPoint[] }>();
  const outletByMonth = new Map<string, ChangeSeriesPoint>();
  for (const r of rows) {
    const p: ChangeSeriesPoint = { monthKey: r.monthKey, nominal: Number(r.nd) || 0, qty: Number(r.qd) || 0 };
    let entry = byItem.get(r.itemName);
    if (!entry) {
      entry = { satuan: r.satuan ?? null, points: [] };
      byItem.set(r.itemName, entry);
    }
    entry.points.push(p);
    const tot = outletByMonth.get(r.monthKey) ?? { monthKey: r.monthKey, nominal: 0, qty: 0 };
    tot.nominal += p.nominal;
    tot.qty += p.qty;
    outletByMonth.set(r.monthKey, tot);
  }
  const outletPoints = [...outletByMonth.values()];
  const outletStats = computeChangeStats(outletPoints, opts.currentMonthKey);
  const outletRow: OutletChangeRow = {
    outletCode,
    outletName,
    area: null,
    ...outletStats,
    status: classifyChange(outletStats, opts.thresholds),
  };

  // The outlet's previous DB month = the monthKey right before the running
  // one in its series — the participation boundary for item stories.
  const sortedKeys = outletPoints.map((p) => p.monthKey).sort((a, b) => a.localeCompare(b));
  const currentPos = sortedKeys.lastIndexOf(opts.currentMonthKey);
  const prevMonthKey = currentPos > 0 ? sortedKeys[currentPos - 1] : null;

  const raw: Array<{ name: string; satuan: string | null; stats: ChangeStats; status: ChangeStatus }> = [];
  for (const [name, { satuan, points }] of byItem) {
    const hasCurrent = points.some((p) => p.monthKey === opts.currentMonthKey);
    const hasPrev = prevMonthKey != null && points.some((p) => p.monthKey === prevMonthKey);
    if (!hasCurrent && !hasPrev) continue; // long-dormant — not this period's story
    // Vanished this period (present in prev month, absent now): close its
    // story against a zero current snapshot (its deviation disappeared).
    const series = hasCurrent ? points : [...points, { monthKey: opts.currentMonthKey, nominal: 0, qty: 0 }];
    const stats = computeChangeStats(series, opts.currentMonthKey);
    raw.push({ name, satuan, stats, status: classifyChange(stats, opts.thresholds) });
  }

  const totalSwing = raw.reduce((s, r) => s + (r.stats.swingNominal ?? 0), 0);
  const outletDeltaSign = outletRow.deltaNominal != null && outletRow.deltaNominal !== 0 ? Math.sign(outletRow.deltaNominal) : 0;

  const items: ItemChangeRow[] = raw.map(({ name, satuan, stats, status }) => {
    const itemDeltaSign = stats.deltaNominal != null && stats.deltaNominal !== 0 ? Math.sign(stats.deltaNominal) : 0;
    return {
      itemName: name,
      satuan,
      pairs: stats.pairs,
      avgSwingNominal: stats.avgSwingNominal,
      avgSwingQty: stats.avgSwingQty,
      deltaNominal: stats.deltaNominal,
      deltaQty: stats.deltaQty,
      deltaPctNominal: stats.deltaPctNominal,
      swingNominal: stats.swingNominal,
      ratioNominal: stats.ratioNominal,
      ratioQty: stats.ratioQty,
      isFlip: stats.isFlip,
      isNew: stats.isNew,
      isAnomali: status === 'ANOMALI' || status === 'BARU_BERGERAK',
      opposesOutlet: itemDeltaSign !== 0 && outletDeltaSign !== 0 && itemDeltaSign !== outletDeltaSign,
      contributionPct: totalSwing > 0 && stats.swingNominal != null ? (stats.swingNominal / totalSwing) * 100 : null,
    };
  });
  items.sort((a, b) => (b.swingNominal ?? 0) - (a.swingNominal ?? 0));

  return { month: opts.month, week: opts.week, outlet: outletRow, items };
}
