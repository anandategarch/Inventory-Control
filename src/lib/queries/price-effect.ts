// ============================================================
//  Price Effect — Bennet decomposition of Δ|Nominal Deviasi|
//  --------------------------------------------------------
//  Master Context (business doc) §22 AVG PRICE / §55 PRICE vs
//  QUANTITY: "Nominal effect = Quantity effect + Price effect" —
//  a rise in |nominalDeviasi| must NOT be read as an operational
//  (volume) problem until the price effect is separated out.
//
//  Per item, over the current period vs the compare period:
//    Q = Σ|qtyDeviasi|          (deviation volume)
//    N = Σ|nominalDeviasi|      (financial magnitude)
//    P = N / Q                  (implied national avg price — §22:
//                                "harga nasional seluruh store yang
//                                dirata-ratakan", observable here only
//                                through deviation rows)
//
//  Bennet (symmetric, EXACT — no interaction residual):
//    qtyEffect   = (Qc − Qp) × (Pc + Pp) / 2
//    priceEffect = (Pc − Pp) × (Qc + Qp) / 2
//    qtyEffect + priceEffect = Nc − Np  (algebraically exact)
//
//  Driver classification per item (dominance of |effect|):
//    PRICE ≥ 70% → 'PRICE' · ≤ 30% → 'QTY' · else 'MIXED'
//    (both flat → 'FLAT')
//
//  Items present in only ONE period cannot be decomposed — they are
//  reported separately as newItems/goneItems with their nominal
//  contribution so the aggregate reconciles honestly:
//    ΔN_total = (matched netDelta) + newNominal − goneNominal
//
//  ANA-1-B (waterfall anchors): summary also carries prevTotalNominal /
//  currTotalNominal — Σ|nominalDeviasi| over ALL items of each period
//  (matched + new for current; matched + gone for compare). The bridge
//  identity verified dev-side in this file:
//    currTotalNominal − prevTotalNominal
//      === qtyEffect + priceEffect + newNominal − goneNominal
//
//  SQL shape mirrors growth-drivers.ts aggregateItemMetrics: two CTE
//  aggregations (curr + prev, GROUP BY item) + ONE FULL OUTER JOIN —
//  ~154 rows per side instead of 35K raw records.
// ============================================================
import { Prisma } from '@prisma/client';
import { buildSqlFilters, withStatementTimeout, type SqlFilterOpts } from './shared';

export interface PriceEffectItem {
  item: string;
  /** Σ|qtyDeviasi| current / compare period */
  qtyCurr: number;
  qtyPrev: number;
  /** Σ|nominalDeviasi| current / compare period */
  nomCurr: number;
  nomPrev: number;
  /** Implied avg price N/Q — null when Q = 0 */
  priceCurr: number | null;
  pricePrev: number | null;
  /** (Qc − Qp) / Qp — magnitude growth of deviation volume */
  qtyGrowth: number | null;
  /** (Pc − Pp) / Pp — implied price growth */
  priceGrowth: number | null;
  /** (Nc − Np) / Np — financial magnitude growth */
  nomGrowth: number | null;
  /** Bennet quantity effect (Rp) — signed */
  qtyEffect: number;
  /** Bennet price effect (Rp) — signed */
  priceEffect: number;
  /** Nc − Np === qtyEffect + priceEffect (exact) */
  netDelta: number;
  /** |priceEffect| share of total |effect| (0–100) — null when both flat */
  priceSharePct: number | null;
  /** Dominance classification */
  driver: 'PRICE' | 'QTY' | 'MIXED' | 'FLAT';
}

export interface PriceEffectSummary {
  /** false when no compare period was supplied (route still returns 200) */
  hasCompare: boolean;
  /** items decomposable (present in BOTH periods with Q > 0) */
  matchedItems: number;
  /** items appearing only in the current period */
  newItems: number;
  /** items present only in the compare period */
  goneItems: number;
  /** Σ|nominalDeviasi| of new/gone items (Rp) — outside the decomposition */
  newNominal: number;
  goneNominal: number;
  /** Matched-items totals (curr / prev / delta) */
  nomCurr: number;
  nomPrev: number;
  netDelta: number;
  /** Aggregate Bennet effects over matched items (sum is exact) */
  qtyEffect: number;
  priceEffect: number;
  /** Aggregate |priceEffect| share of total |effect| — null when both flat */
  priceSharePct: number | null;
  /** §22 AVG PRICE change: |nomPrev|-weighted mean of per-item price growth */
  avgPriceChangePct: number | null;
  /** Median per-item price growth (robust vs outlier items) */
  medianPriceChangePct: number | null;
  itemsPriceUp: number;
  itemsPriceDown: number;
  /** ANA-1-B waterfall anchor: Σ|nominalDeviasi| over ALL items in the
   *  CURRENT period (matched + new). Bridge identity (exact, dev-checked):
   *  currTotalNominal − prevTotalNominal
   *    === qtyEffect + priceEffect + newNominal − goneNominal */
  currTotalNominal: number;
  /** ANA-1-B waterfall anchor: Σ|nominalDeviasi| over ALL items in the
   *  COMPARE period (matched + gone). */
  prevTotalNominal: number;
}

export interface PriceEffectResult {
  summary: PriceEffectSummary;
  /** Sorted by |netDelta| desc, capped at maxItems */
  items: PriceEffectItem[];
}

const DRIVER_PRICE_SHARE = 0.7; // ≥70% price share → PRICE-driven
const DRIVER_QTY_SHARE = 0.3;   // ≤30% price share → QTY-driven

export async function queryPriceEffect(
  week: string,
  month: string,
  prevWeek: string | null,
  prevMonth: string | null,
  filters: SqlFilterOpts,
  maxItems: number = 20,
): Promise<PriceEffectResult> {
  const f = buildSqlFilters(filters);
  const hasCompare = !!(prevWeek && prevMonth);

  // Per-item sums for ONE period. FILTER (WHERE ... IS NOT NULL) keeps each
  // metric's row scope independent (same semantics as growth-drivers).
  const sums = Prisma.sql`
    i.name as name,
    COALESCE(SUM(ABS(ir."qtyDeviasi")) FILTER (WHERE ir."qtyDeviasi" IS NOT NULL), 0) as q,
    COALESCE(SUM(ABS(ir."nominalDeviasi")) FILTER (WHERE ir."nominalDeviasi" IS NOT NULL), 0) as n
  `;
  const currCte = Prisma.sql`
    SELECT ${sums}
    FROM "InventoryRecord" ir
    JOIN "Item" i ON ir."itemId" = i.id
    WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
      ${f}
    GROUP BY i.name
  `;
  const prevCte = hasCompare
    ? Prisma.sql`
        SELECT ${sums}
        FROM "InventoryRecord" ir
        JOIN "Item" i ON ir."itemId" = i.id
        WHERE ir."monthLabel" = ${prevMonth} AND ir."weekLabel" = ${prevWeek}
          ${f}
        GROUP BY i.name
      `
    : Prisma.sql`SELECT NULL::text as name, 0::float as q, 0::float as n WHERE 1=0`;

  const rows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{
    name: string | null;
    qCurr: number | bigint | null; qPrev: number | bigint | null;
    nCurr: number | bigint | null; nPrev: number | bigint | null;
  }>>`
    WITH curr_agg AS (${currCte}),
         prev_agg AS (${prevCte})
    SELECT
      COALESCE(c.name, p.name) as name,
      COALESCE(c.q, 0) as "qCurr", COALESCE(p.q, 0) as "qPrev",
      COALESCE(c.n, 0) as "nCurr", COALESCE(p.n, 0) as "nPrev"
    FROM curr_agg c
    FULL OUTER JOIN prev_agg p ON c.name = p.name
  `);

  const emptySummary: PriceEffectSummary = {
    hasCompare: false, matchedItems: 0, newItems: 0, goneItems: 0,
    newNominal: 0, goneNominal: 0,
    nomCurr: 0, nomPrev: 0, netDelta: 0, qtyEffect: 0, priceEffect: 0,
    priceSharePct: null, avgPriceChangePct: null, medianPriceChangePct: null,
    itemsPriceUp: 0, itemsPriceDown: 0,
    currTotalNominal: 0, prevTotalNominal: 0,
  };
  if (!hasCompare || rows.length === 0) {
    return { summary: { ...emptySummary, hasCompare }, items: [] };
  }

  const matched: PriceEffectItem[] = [];
  const priceGrowths: Array<{ g: number; w: number }> = []; // for weighted avg
  let newItems = 0, goneItems = 0, newNominal = 0, goneNominal = 0;
  // ANA-1-B: waterfall anchors — per-period totals over ALL rows (matched +
  // new + gone), accumulated independently of the branches below.
  let currTotalNominal = 0, prevTotalNominal = 0;

  for (const r of rows) {
    if (r.name == null) continue;
    const qCurr = Number(r.qCurr) || 0;
    const qPrev = Number(r.qPrev) || 0;
    const nCurr = Number(r.nCurr) || 0;
    const nPrev = Number(r.nPrev) || 0;

    // ANA-1-B: anchors count every row — matched, new and gone alike.
    currTotalNominal += nCurr;
    prevTotalNominal += nPrev;

    // New / gone items — outside the decomposition, reported honestly.
    if (qPrev === 0 && nPrev === 0) {
      if (qCurr > 0 || nCurr > 0) { newItems++; newNominal += nCurr; }
      continue;
    }
    if (qCurr === 0 && nCurr === 0) {
      goneItems++; goneNominal += nPrev;
      continue;
    }

    // Implied prices (null when volume is 0 → cannot decompose price).
    const priceCurr = qCurr > 0 ? nCurr / qCurr : null;
    const pricePrev = qPrev > 0 ? nPrev / qPrev : null;

    // Bennet effects — exact by construction. When one side's price is
    // unobservable (Q=0 in that period), the whole delta collapses into
    // the quantity effect at the observable price.
    const pAvg = priceCurr != null && pricePrev != null
      ? (priceCurr + pricePrev) / 2
      : (priceCurr ?? pricePrev ?? 0);
    const qAvg = (qCurr + qPrev) / 2;
    const qtyEffect = (qCurr - qPrev) * pAvg;
    const priceEffect = priceCurr != null && pricePrev != null
      ? (priceCurr - pricePrev) * qAvg
      : 0;
    const netDelta = nCurr - nPrev;

    const totalEffect = Math.abs(priceEffect) + Math.abs(qtyEffect);
    const priceSharePct = totalEffect > 0
      ? (Math.abs(priceEffect) / totalEffect) * 100
      : null;
    let driver: PriceEffectItem['driver'] = 'FLAT';
    if (priceSharePct != null) {
      if (priceSharePct >= DRIVER_PRICE_SHARE * 100) driver = 'PRICE';
      else if (priceSharePct <= DRIVER_QTY_SHARE * 100) driver = 'QTY';
      else driver = 'MIXED';
    }

    const qtyGrowth = qPrev > 0 ? (qCurr - qPrev) / qPrev : null;
    const nomGrowth = nPrev > 0 ? (nCurr - nPrev) / nPrev : null;
    const priceGrowth = priceCurr != null && pricePrev != null && pricePrev > 0
      ? (priceCurr - pricePrev) / pricePrev
      : null;
    if (priceGrowth != null) priceGrowths.push({ g: priceGrowth, w: nPrev });

    matched.push({
      item: r.name,
      qtyCurr: qCurr, qtyPrev: qPrev, nomCurr: nCurr, nomPrev: nPrev,
      priceCurr, pricePrev,
      qtyGrowth, priceGrowth, nomGrowth,
      qtyEffect, priceEffect, netDelta,
      priceSharePct: priceSharePct != null ? Number(priceSharePct.toFixed(1)) : null,
      driver,
    });
  }

  // Aggregate over matched items
  let nomCurr = 0, nomPrev = 0, qtyEffect = 0, priceEffect = 0;
  let itemsPriceUp = 0, itemsPriceDown = 0;
  for (const m of matched) {
    nomCurr += m.nomCurr;
    nomPrev += m.nomPrev;
    qtyEffect += m.qtyEffect;
    priceEffect += m.priceEffect;
    if (m.priceGrowth != null) {
      if (m.priceGrowth > 0) itemsPriceUp++;
      else if (m.priceGrowth < 0) itemsPriceDown++;
    }
  }
  const totalEffect = Math.abs(priceEffect) + Math.abs(qtyEffect);
  const priceSharePct = totalEffect > 0
    ? Number(((Math.abs(priceEffect) / totalEffect) * 100).toFixed(1))
    : null;

  // §22 AVG PRICE change — weighted mean + median of per-item price growth
  let avgPriceChangePct: number | null = null;
  let medianPriceChangePct: number | null = null;
  if (priceGrowths.length > 0) {
    const wSum = priceGrowths.reduce((a, b) => a + b.w, 0);
    avgPriceChangePct = wSum > 0
      ? Number(((priceGrowths.reduce((a, b) => a + b.g * b.w, 0) / wSum) * 100).toFixed(1))
      : null;
    const sorted = [...priceGrowths].map((p) => p.g).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    medianPriceChangePct = Number((median * 100).toFixed(1));
  }

  const summary: PriceEffectSummary = {
    hasCompare: true,
    matchedItems: matched.length,
    newItems, goneItems, newNominal, goneNominal,
    nomCurr, nomPrev,
    netDelta: nomCurr - nomPrev,
    qtyEffect, priceEffect,
    priceSharePct,
    avgPriceChangePct, medianPriceChangePct,
    itemsPriceUp, itemsPriceDown,
    currTotalNominal, prevTotalNominal,
  };

  // ANA-1-B — waterfall reconciliation (dev-only assert): the bridge legs
  // must sum back to the anchor delta EXACTLY. Per matched item Bennet is
  // algebraically exact (ΔN = qtyEffect + priceEffect), and new/gone items
  // contribute their full nominal, so any gap can only be float summation
  // order. Tolerance: 1e-6 relative (double precision on Rp sums is ~1e-9).
  const bridgeGap = (currTotalNominal - prevTotalNominal)
    - (qtyEffect + priceEffect + newNominal - goneNominal);
  if (process.env.NODE_ENV !== 'production'
    && Math.abs(bridgeGap) > Math.max(0.01, Math.abs(currTotalNominal - prevTotalNominal) * 1e-6)) {
    console.warn(`[price-effect] waterfall reconciliation gap Rp ${bridgeGap.toFixed(4)}`);
  }

  const items = matched
    .sort((a, b) => Math.abs(b.netDelta) - Math.abs(a.netDelta))
    .slice(0, maxItems);

  return { summary, items };
}
