// ============================================================
//  Change Analysis — "Rata-rata Perubahan" (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  User-approved feature: rank outlets whose CURRENT period-over-
//  period deviation move strays from their OWN average move, then
//  attribute the move to items ("item apa yang buat dia
//  menyimpang?").
//
//  SEMANTICS (mirrors the A2 z-score baseline conventions):
//   - SAME-WEEK chain only. Weeks are cumulative MTD snapshots
//     (W1=1-7 … W4=1-25), so the only valid Δ is the SAME
//     weekLabel ACROSS months (W4 Jul → W4 Agu) — never W1 → W2
//     in-month (that is fake growth; historical-baseline.ts
//     header). The query pins ir."weekLabel" = week.
//   - Window = every DB month with sf."monthKey" <= currentMonthKey
//     (INCLUDES the running month — it is the value under
//     evaluation — and excludes future months in one comparison,
//     the BUG2-PARETO-1 correct form).
//   - The CURRENT pair (previous snapshot → current snapshot) is
//     the evaluated value; the BASELINE = the pairs BEFORE it
//     (mirrors metrics/historical.ts "exclude current" — the
//     evaluated change must not dilute its own baseline).
//   - MOVEMENT ("gerak") = swing = |V_now − V_prev| on the SIGNED
//     sums (captures full LOSS↔SURPLUS swings), averaged as |Δ|.
//   - DISPLAY delta = magnitude change |V_now| − |V_prev|
//     (audit #11 / computeNominalDeviationGrowth — positive =
//     deviation GREW (memburuk), negative = shrank (membaik);
//     sign flips carry isFlip so a LOSS→SURPLUS swing is never
//     read as "improvement" without its ↺ marker).
//   - nominalDeviasi + qtyDeviasi are genuine per-row data → sums
//     are additive at every grouping level (TASK H-7 lesson), so
//     the outlet series in the items query is derived by summing
//     the item series (no second query).
//   - Item participation: an item joins the breakdown iff it has
//     rows in the current month OR in the outlet's previous DB
//     month (vanished items close their story; long-dormant items
//     do not resurrect old news).
//
//  Thresholds are RUNTIME (Settings, CHANGE_* keys — settings.ts);
//  a Settings mutation invalidates the route cache entry via
//  invalidateAnalysisCache ('change-analysis*' prefixes), so no
//  threshold fingerprint is needed in the cache key.
// ============================================================
import { db } from '@/lib/db';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from '../shared';
import { calcGrowthAbs } from '@/lib/metrics/growth';

// ------------------------------------------------------------
//  Pure computation (exported for tests) — one outlet's series
//  of same-week monthly snapshots → change statistics.
// ------------------------------------------------------------
/** One (month, same-week) snapshot of an outlet's deviation sums. */
export interface ChangeSeriesPoint {
  monthKey: string;
  /** SUM(nominalDeviasi) — SIGNED net (negative = LOSS). */
  nominal: number;
  /** SUM(qtyDeviasi) — SIGNED net. */
  qty: number;
}

/** Change statistics for one outlet (or one outlet×item). */
export interface ChangeStats {
  /** Baseline pair count (consecutive same-week snapshots BEFORE the current pair). */
  pairs: number;
  /** False when the outlet has no current-month snapshot (cannot be evaluated). */
  hasCurrent: boolean;
  /** mean |Δ nominal| over the baseline pairs (0 when no pairs). */
  avgSwingNominal: number;
  /** mean |Δ qty| over the baseline pairs (0 when no pairs). */
  avgSwingQty: number;
  /** mean |%Δ nominal| over the baseline pairs (null when no computable %). */
  avgPctNominal: number | null;
  /** |V_now| − |V_prev| (Rp) — + = deviation grew (memburuk), − = shrank. Null = no current pair. */
  deltaNominal: number | null;
  /** |Q_now| − |Q_prev| (qty) — same magnitude-change convention. */
  deltaQty: number | null;
  /** calcGrowthAbs(V_now, V_prev) — null when |V_prev| = 0 (small-base guard). */
  deltaPctNominal: number | null;
  /** |V_now − V_prev| (Rp) — the CURRENT movement size. Null = no current pair. */
  swingNominal: number | null;
  /** |Q_now − Q_prev| — the CURRENT movement size (qty). */
  swingQty: number | null;
  /** swingNominal / avgSwingNominal — null when the baseline is flat (see BARU_BERGERAK) or no pair. */
  ratioNominal: number | null;
  /** swingQty / avgSwingQty. */
  ratioQty: number | null;
  /** LOSS↔SURPLUS flip between the current pair (both sides non-zero). */
  isFlip: boolean;
  /** No snapshot before the current one at all (appeared this period). */
  isNew: boolean;
}

/** Runtime-tunable thresholds (Settings keys CHANGE_*). */
export interface ChangeThresholds {
  /** swing/avgSwing at/above this = ANOMALI (default 2.0). */
  ratioThreshold: number;
  /** Minimum baseline pairs before any ratio is judged (default 4). */
  minPairs: number;
  /** Minimum current swing (Rp) for ANOMALI / BARU_BERGERAK — noise gate (default 100k). */
  minNominal: number;
}

/** Lifecycle status derived from stats + thresholds. */
export type ChangeStatus = 'ANOMALI' | 'BARU_BERGERAK' | 'NORMAL' | 'DATA_KURANG';

/**
 * Compute change statistics for ONE series of same-week monthly snapshots.
 *
 * `points` may be in any order (sorted by monthKey internally). The point
 * whose monthKey equals `currentMonthKey` is the running snapshot — with the
 * window query (`monthKey <= current`) it is the LAST point when present.
 * A missing current snapshot yields hasCurrent=false (everything null).
 */
export function computeChangeStats(points: ChangeSeriesPoint[], currentMonthKey: string): ChangeStats {
  const sorted = [...points].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const n = sorted.length;
  let currentIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (sorted[i].monthKey === currentMonthKey) {
      currentIdx = i;
      break;
    }
  }
  if (currentIdx === -1) {
    return {
      pairs: 0, hasCurrent: false,
      avgSwingNominal: 0, avgSwingQty: 0, avgPctNominal: null,
      deltaNominal: null, deltaQty: null, deltaPctNominal: null,
      swingNominal: null, swingQty: null,
      ratioNominal: null, ratioQty: null,
      isFlip: false, isNew: false,
    };
  }

  // Baseline pairs = consecutive pairs ENDING BEFORE the current pair
  // (pair i = points[i-1] → points[i]; baseline = i in 1..currentIdx-1).
  const pairs = Math.max(0, currentIdx - 1);
  let sumSwingN = 0;
  let sumSwingQ = 0;
  const pctVals: number[] = [];
  for (let i = 1; i <= currentIdx - 1; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    sumSwingN += Math.abs(b.nominal - a.nominal);
    sumSwingQ += Math.abs(b.qty - a.qty);
    const g = calcGrowthAbs(b.nominal, a.nominal);
    if (g != null) pctVals.push(Math.abs(g));
  }
  const avgSwingNominal = pairs > 0 ? sumSwingN / pairs : 0;
  const avgSwingQty = pairs > 0 ? sumSwingQ / pairs : 0;
  const avgPctNominal = pctVals.length > 0 ? pctVals.reduce((x, y) => x + y, 0) / pctVals.length : null;

  const cur = sorted[currentIdx];
  const prev = currentIdx > 0 ? sorted[currentIdx - 1] : null;
  const pNom = prev ? prev.nominal : 0;
  const pQty = prev ? prev.qty : 0;
  const swingNominal = Math.abs(cur.nominal - pNom);
  const swingQty = Math.abs(cur.qty - pQty);
  return {
    pairs,
    hasCurrent: true,
    avgSwingNominal,
    avgSwingQty,
    avgPctNominal,
    deltaNominal: Math.abs(cur.nominal) - Math.abs(pNom),
    deltaQty: Math.abs(cur.qty) - Math.abs(pQty),
    deltaPctNominal: calcGrowthAbs(cur.nominal, pNom),
    swingNominal,
    swingQty,
    ratioNominal: avgSwingNominal > 0 ? swingNominal / avgSwingNominal : null,
    ratioQty: avgSwingQty > 0 ? swingQty / avgSwingQty : null,
    isFlip: prev != null && pNom !== 0 && cur.nominal !== 0 && Math.sign(cur.nominal) !== Math.sign(pNom),
    isNew: prev == null,
  };
}

/** Derive the lifecycle status from stats + thresholds. */
export function classifyChange(s: ChangeStats, t: ChangeThresholds): ChangeStatus {
  if (!s.hasCurrent || s.pairs < t.minPairs) return 'DATA_KURANG';
  const swing = s.swingNominal ?? 0;
  if (s.avgSwingNominal === 0 && swing >= t.minNominal) return 'BARU_BERGERAK';
  if (s.ratioNominal != null && s.ratioNominal >= t.ratioThreshold && swing >= t.minNominal) return 'ANOMALI';
  return 'NORMAL';
}

// ------------------------------------------------------------
//  Outlet-level ranking (ONE scan, all outlets, all same-week months).
// ------------------------------------------------------------
/** One outlet row of the change ranking (ChangeStats flattened + identity + status). */
export interface OutletChangeRow extends ChangeStats {
  outletCode: string;
  outletName: string;
  area: string | null;
  status: ChangeStatus;
}

/** Response of queryOutletChangeAnalysis (also the /api/change-analysis data payload). */
export interface ChangeAnalysisResult {
  month: string;
  week: string;
  currentMonthKey: string;
  thresholds: ChangeThresholds;
  counts: { ranked: number; anomali: number; baruBergerak: number; dataKurang: number };
  outlets: OutletChangeRow[];
}

interface OutletScanRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  monthKey: string;
  nd: number | bigint | null;
  qd: number | bigint | null;
}

/**
 * Rank outlets by how far the CURRENT deviation move strays from their own
 * average move. ONE query returns the per-(outlet, month) same-week sums for
 * every month up to and including the running one — the Δ chain, averages and
 * ratios are reduced in JS (same precedent as evaluateHistoricalRulesSql's
 * caller-side shaping; no N+1 for 333 outlets).
 */
export async function queryOutletChangeAnalysis(opts: {
  month: string;
  week: string;
  currentMonthKey: string;
  filters: SqlFilterOpts;
  thresholds: ChangeThresholds;
}): Promise<ChangeAnalysisResult> {
  const f = buildSqlFilters(opts.filters);
  const rows = await withStatementTimeout((tx) => tx.$queryRaw<OutletScanRow[]>`
    SELECT
      o.code as "outletCode",
      o.name as "outletName",
      MAX(ir.area) as "area",
      sf."monthKey" as "monthKey",
      COALESCE(SUM(ir."nominalDeviasi") FILTER (WHERE ir."nominalDeviasi" IS NOT NULL), 0) as nd,
      COALESCE(SUM(ir."qtyDeviasi") FILTER (WHERE ir."qtyDeviasi" IS NOT NULL), 0) as qd
    FROM "InventoryRecord" ir
    JOIN "Outlet" o ON ir."outletId" = o.id
    JOIN "SourceFile" sf ON ir."sourceFileId" = sf.id
    WHERE ir."weekLabel" = ${opts.week}
      AND sf."monthKey" <= ${opts.currentMonthKey}
      ${f}
    GROUP BY o.id, sf."monthKey"
    ORDER BY o.code, sf."monthKey"
  `);

  const series = new Map<string, { code: string; name: string; area: string | null; points: ChangeSeriesPoint[] }>();
  for (const r of rows) {
    let entry = series.get(r.outletCode);
    if (!entry) {
      entry = { code: r.outletCode, name: r.outletName, area: r.area ?? null, points: [] };
      series.set(r.outletCode, entry);
    }
    entry.points.push({
      monthKey: r.monthKey,
      nominal: Number(r.nd) || 0,
      qty: Number(r.qd) || 0,
    });
  }

  const outlets: OutletChangeRow[] = [];
  for (const { code, name, area, points } of series.values()) {
    const stats = computeChangeStats(points, opts.currentMonthKey);
    outlets.push({ outletCode: code, outletName: name, area, ...stats, status: classifyChange(stats, opts.thresholds) });
  }

  // Ranking: BARU_BERGERAK first (a flat-history outlet starting to move is
  // the loudest "out of character" signal), then ratio desc, then swing desc.
  // DATA_KURANG rows trail at the end (the UI hides them; counts report them).
  const groupRank = (s: ChangeStatus) => (s === 'BARU_BERGERAK' ? 0 : s === 'ANOMALI' ? 1 : s === 'NORMAL' ? 2 : 3);
  const ratioRank = (r: OutletChangeRow) => (r.ratioNominal ?? (r.status === 'BARU_BERGERAK' ? Number.POSITIVE_INFINITY : 0));
  outlets.sort((a, b) => {
    const ga = groupRank(a.status);
    const gb = groupRank(b.status);
    if (ga !== gb) return ga - gb;
    if (ga === 3) return a.outletCode.localeCompare(b.outletCode);
    const ra = ratioRank(a);
    const rb = ratioRank(b);
    if (ra !== rb) return rb - ra;
    return (b.swingNominal ?? 0) - (a.swingNominal ?? 0);
  });

  const counts = {
    ranked: outlets.filter((o) => o.status !== 'DATA_KURANG').length,
    anomali: outlets.filter((o) => o.status === 'ANOMALI').length,
    baruBergerak: outlets.filter((o) => o.status === 'BARU_BERGERAK').length,
    dataKurang: outlets.filter((o) => o.status === 'DATA_KURANG').length,
  };

  return {
    month: opts.month,
    week: opts.week,
    currentMonthKey: opts.currentMonthKey,
    thresholds: opts.thresholds,
    counts,
    outlets,
  };
}

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
