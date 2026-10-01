// ============================================================
//  W2 — Kronis vs Episodik: waste persistence builder (PURE)
//  --------------------------------------------------------
//  Business question: "Outlet mana waste-nya KRONIS — berulang
//  di atas median network bulan demi bulan (sistemik), bukan
//  insiden sekali? Seberapa lengket status tinggi bulan-ke-bulan?"
//
//  Input  : WasteMonthlyRow[] — the SAME monthly rows already
//           returned by queryWasteNetwork (per (outlet, bulan)
//           same-week aggregates incl. wasteToSales, spike, dqError).
//           No SQL, no db — pure second pass (house compute/classify
//           split, same as buildWasteOutlets/buildWasteKpis).
//  Output : per-outlet persistence metrics (additive optional fields
//           merged onto WasteOutletRow by query.ts) + network-level
//           summary (transition matrix, persistence ratio, Fisher
//           exact p, class distribution) + per-month medians.
//
//  METHODOLOGICAL DECISIONS (all pinned by tests):
//   1. "Di atas median" = wasteToSales STRICTLY above the median of
//      that month's ACTIVE outlets in scope — PER-MONTH median, so
//      seasonality (network-wide bulan ramai vs sepi) is controlled;
//      a single static window median would let a calm month count as
//      "above". The median INCLUDES the outlet itself: this is a
//      network benchmark ("outlet vs jaringan"), not a peer-excluded
//      z-score (the self-inclusion cap issue flagged for waste
//      peer-zscore does not apply to a median at n≈300+; at n=1 the
//      sole outlet sits exactly on the median and is never "above").
//   2. ACTIVE month = row exists AND !dqError AND sales > 0.
//      - dqError months count SEPARATELY as invalidMonths — never
//        above/below, never in the share denominator (W2 guard from
//        findings-DEEPWASTE2-B §2: "bulan dqError di-exclude").
//      - sales = 0 months (non-DQ) also have an UNDEFINED ratio
//        (buildWasteMonthlyRows guards sales=0 → wasteToSales 0, a
//        FORCED value, not a real 0). Following the BUGHUNT-R1 FIX 7
//        precedent (the SQL spike baseline NULL-skips sales=0 months
//        instead of diluting the mean), they are excluded from
//        activeMonths and reported separately as zeroSalesMonths so
//        aboveMedianShare is not deflated by ratio-less months.
//   3. Transition pairs = CALENDAR-CONSECUTIVE active months per
//      outlet only ("bulan-ke-bulan"): a pair (t, t+1) is counted
//      when monthKey t+1 is the next calendar month of t AND both
//      months are active for that outlet. A gap (missing month) or
//      an invalid month in between BREAKS the chain — a transition
//      across a 2-month gap is not month-over-month.
//   4. persistenceRatio = P(high t+1 | high t) / P(high t+1 | low t)
//      = [HH/(HH+HL)] / [LH/(LH+LL)]. Null (never ±Infinity) when a
//      denominator is 0 or P(high t+1 | low t) = 0 — JSON-safe.
//   5. Fisher exact = TWO-SIDED, "sum of tables no more likely than
//      the observed one" (the R fisher.test default convention,
//      relative tolerance 1 + 1e-7). Two-sided because BOTH directions
//      are informative: ratio > 1 = persistence (kronis), ratio < 1 =
//      anti-persistence / mean-reversion (episodik).
//   6. Classification (all labels INDIKASI — statistical indication,
//      not proof; house epistemic-label convention from insights.ts):
//        KRONIS   : activeMonths ≥ 6 AND aboveMedianShare ≥ 60%
//        EPISODIK : activeMonths ≥ 6, below the kronis share, but has
//                   ≥ 1 spike (2σ) month among ACTIVE months
//        SEHAT    : activeMonths ≥ 6, otherwise
//        TERBATAS : activeMonths < 6 (insufficient data — never
//                   classified, house "TERBATAS" label convention)
//      Spikes are counted over ACTIVE months only — a 2σ spike inside
//      a DQ-error month is not evidence of anything (the month itself
//      is unreliable). The SQL spike detector can never fire on
//      sales=0 months anyway (NULL ratio), so the active-month filter
//      is belt-and-braces there.
//
//  Live shape (Sept 2026, network scope): 341 outlet × ~9 bulan
//  same-week → ~2.7k rows; this pass is O(rows log rows) on the
//  already-fetched payload — no extra SQL round-trip.
// ============================================================
import type {
  WasteMonthMedian,
  WasteMonthlyRow,
  WasteOutletPersistence,
  WastePersistenceClass,
  WastePersistenceResult,
  WastePersistenceSummary,
} from './types';

/** KRONIS threshold: share of ACTIVE months above the per-month network median (fraction, inclusive ≥). */
export const WASTE_KRONIS_SHARE = 0.6;

/** KRONIS threshold: minimum ACTIVE months — below this the outlet is TERBATAS (insufficient data). */
export const WASTE_KRONIS_MIN_MONTHS = 6;

// ------------------------------------------------------------
// Fisher exact 2×2 — self-contained (pure, exported for vitest)
// ------------------------------------------------------------

/**
 * ln Γ(x) for x > 0 — Lanczos-style 6-coefficient approximation
 * (Numerical Recipes gammaln; relative accuracy ~1e-14, ample for
 * p-values). Self-contained because Node has no Math.lgamma and the
 * waste query layer must not grow a statistics dependency for ONE
 * function.
 */
function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  const y = x;
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / (y + j + 1);
  const t = x + 5.5;
  return Math.log(2.5066282746310005 * ser / x) + (x + 0.5) * Math.log(t) - t;
}

/** ln C(n, k); −Infinity for out-of-range k (log of probability 0). */
function logBinom(n: number, k: number): number {
  if (n < 0 || k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Two-sided Fisher exact test on the 2×2 contingency table
 *
 *        col 1   col 2
 *   row1   a       b
 *   row2   c       d
 *
 * Under the null (fixed row/col margins), the count in [row1,col1]
 * is hypergeometric: p(x) = C(r1,x)·C(r2,s1−x) / C(n,s1) with
 * r1=a+b, r2=c+d, s1=a+c, n=r1+r2. The two-sided p-value sums the
 * probabilities of ALL tables (x over its full feasible range) that
 * are NO MORE LIKELY than the observed one — the R fisher.test
 * default convention, with the same relative tolerance (1 + 1e-7)
 * so log-space rounding cannot drop the observed table itself.
 *
 * Computed in log space via logGamma: C(n,k) overflows float64 long
 * before real payloads (n = transition pairs can reach ~2.7k →
 * C(2752,1376) ≈ 10^825), while ln C stays ≈ 6.7k.
 *
 * Edge cases (pinned by tests):
 *   - all-zero table (n = 0)            → 1 (no data, no evidence);
 *   - zero row/col margin               → 1 (only one table possible);
 *   - negative or non-integer cell      → NaN (garbage in — the
 *     transition counters always feed non-negative integers).
 */
export function fisherExact2x2(a: number, b: number, c: number, d: number): number {
  if (
    !Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) || !Number.isInteger(d)
    || a < 0 || b < 0 || c < 0 || d < 0
  ) {
    return Number.NaN;
  }
  const r1 = a + b;
  const r2 = c + d;
  const s1 = a + c;
  const n = r1 + r2;
  if (n === 0) return 1;

  const logDen = logBinom(n, s1);
  const logP = (x: number): number => logBinom(r1, x) + logBinom(r2, s1 - x) - logDen;
  // Tables "no more likely than observed": log p(x) ≤ log p(a) + ln(1+1e-7).
  const logTol = logP(a) + Math.log(1 + 1e-7);
  const lo = Math.max(0, s1 - r2);
  const hi = Math.min(r1, s1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= logTol) p += Math.exp(lp);
  }
  return Math.min(1, Math.max(0, p));
}

// ------------------------------------------------------------
// Classification (pure, exported for vitest boundary tests)
// ------------------------------------------------------------

/**
 * KRONIS / EPISODIK / SEHAT / TERBATAS gate — evaluated in exactly
 * this order (each tier dominates the ones below it):
 *   TERBATAS gate first (insufficient data is never classified),
 *   then KRONIS (persistence dominates episodic spikes — an outlet
 *   that is chronically above median AND occasionally spikes is
 *   still kronis), then EPISODIK, else SEHAT.
 */
export function classifyWastePersistence(
  activeMonths: number,
  aboveMedianShare: number,
  activeSpikeMonths: number,
): WastePersistenceClass {
  if (activeMonths < WASTE_KRONIS_MIN_MONTHS) return 'TERBATAS';
  if (aboveMedianShare >= WASTE_KRONIS_SHARE) return 'KRONIS';
  if (activeSpikeMonths > 0) return 'EPISODIK';
  return 'SEHAT';
}

// ------------------------------------------------------------
// buildWastePersistence — the pure builder
// ------------------------------------------------------------

/** ACTIVE = comparable outlet-month: not DQ-flagged AND ratio defined (sales > 0). */
function isActiveMonth(r: WasteMonthlyRow): boolean {
  return !r.dqError && r.sales > 0;
}

/**
 * Calendar successor of a 'YYYY-MM' monthKey ('2026-12' → '2027-01').
 * Used to enforce CALENDAR-CONSECUTIVE transition pairs. A malformed
 * key yields a non-matching successor → the pair is skipped (fail
 * quiet, never miscounted).
 */
function nextMonthKey(monthKey: string): string {
  const parts = monthKey.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return '';
  return m === 12
    ? `${y + 1}-01`
    : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Per-outlet persistence + network transition summary from the waste
 * monthly rows. Pure — identical input ⇒ identical output (vitest
 * tests this directly, no db).
 */
export function buildWastePersistence(monthly: WasteMonthlyRow[]): WastePersistenceResult {
  // ---- Pass 1: per-month network median over ACTIVE outlet-months ----
  const rowsByMonth = new Map<string, WasteMonthlyRow[]>();
  for (const r of monthly) {
    const list = rowsByMonth.get(r.monthKey);
    if (list) list.push(r);
    else rowsByMonth.set(r.monthKey, [r]);
  }
  const monthKeys = [...rowsByMonth.keys()].sort((a, b) => a.localeCompare(b));
  const medians: WasteMonthMedian[] = [];
  const medianByMonth = new Map<string, number>();
  for (const mk of monthKeys) {
    const rows = rowsByMonth.get(mk);
    // monthKeys derives from the map's own keys — always present; the
    // guard just keeps the narrowing explicit (no non-null assertion).
    if (!rows) continue;
    // wasteToSales of active rows is a genuine ratio (sales > 0) — the
    // forced 0s of sales=0 rows are excluded (decision 2 above).
    const ratios = rows.filter(isActiveMonth).map((r) => r.wasteToSales).sort((a, b) => a - b);
    if (ratios.length === 0) continue; // no comparable outlet that month
    const mid = ratios.length >> 1;
    const median = ratios.length % 2 === 1
      ? ratios[mid]
      : (ratios[mid - 1] + ratios[mid]) / 2;
    medianByMonth.set(mk, median);
    medians.push({
      monthKey: mk,
      monthLabel: rows[0].monthLabel,
      medianWasteToSales: median,
      activeOutlets: ratios.length,
    });
  }

  // ---- Pass 2: per-outlet metrics + calendar-consecutive transition pairs ----
  const rowsByOutlet = new Map<string, WasteMonthlyRow[]>();
  for (const r of monthly) {
    const list = rowsByOutlet.get(r.outletCode);
    if (list) list.push(r);
    else rowsByOutlet.set(r.outletCode, [r]);
  }
  const outlets: WasteOutletPersistence[] = [];
  let HH = 0;
  let HL = 0;
  let LH = 0;
  let LL = 0;
  for (const outletCode of [...rowsByOutlet.keys()].sort()) {
    const outletRows = rowsByOutlet.get(outletCode);
    // Same as above — keys derive from the map itself.
    if (!outletRows) continue;
    const rows = outletRows.slice().sort((a, b) => a.monthKey.localeCompare(b.monthKey));
    let activeMonths = 0;
    let invalidMonths = 0;
    let zeroSalesMonths = 0;
    let monthsAboveMedian = 0;
    let activeSpikeMonths = 0;
    const active: Array<{ monthKey: string; high: boolean }> = [];
    for (const r of rows) {
      if (r.dqError) {
        // DQ-error month: counted SEPARATELY as invalid — never above/
        // below, never in the share denominator (W2 guard).
        invalidMonths++;
        continue;
      }
      if (r.sales <= 0) {
        // Non-DQ month without sales: ratio undefined (forced 0 is not
        // a real 0) — reported separately, excluded from the denominator.
        zeroSalesMonths++;
        continue;
      }
      activeMonths++;
      const median = medianByMonth.get(r.monthKey);
      // Strictly above (≥ would double-count the median outlet itself
      // in odd-n months); median is always defined for an active month
      // (the outlet's own row seeded it in pass 1) — guard kept for
      // hand-built payloads.
      const high = median !== undefined && r.wasteToSales > median;
      if (high) monthsAboveMedian++;
      if (r.spike) activeSpikeMonths++;
      active.push({ monthKey: r.monthKey, high });
    }
    for (let i = 1; i < active.length; i++) {
      const prev = active[i - 1];
      const cur = active[i];
      // Calendar-consecutive only — a gap or an invalid month between
      // two active months breaks the chain (not month-over-month).
      if (nextMonthKey(prev.monthKey) !== cur.monthKey) continue;
      if (prev.high && cur.high) HH++;
      else if (prev.high && !cur.high) HL++;
      else if (!prev.high && cur.high) LH++;
      else LL++;
    }
    const aboveMedianShare = activeMonths > 0 ? monthsAboveMedian / activeMonths : 0;
    outlets.push({
      outletCode,
      activeMonths,
      invalidMonths,
      zeroSalesMonths,
      monthsAboveMedian,
      aboveMedianShare,
      activeSpikeMonths,
      persistenceClass: classifyWastePersistence(activeMonths, aboveMedianShare, activeSpikeMonths),
    });
  }

  // ---- Network summary ----
  const classDistribution: WastePersistenceSummary['classDistribution'] = {
    kronis: 0, episodik: 0, sehat: 0, terbatas: 0,
  };
  for (const o of outlets) {
    if (o.persistenceClass === 'KRONIS') classDistribution.kronis++;
    else if (o.persistenceClass === 'EPISODIK') classDistribution.episodik++;
    else if (o.persistenceClass === 'SEHAT') classDistribution.sehat++;
    else classDistribution.terbatas++;
  }
  const pairsHighStart = HH + HL;
  const pairsLowStart = LH + LL;
  const pHighNextGivenHigh = pairsHighStart > 0 ? HH / pairsHighStart : null;
  const pHighNextGivenLow = pairsLowStart > 0 ? LH / pairsLowStart : null;
  // Null (never Infinity) when undefined or the denominator probability
  // is 0 — keeps the API response JSON-safe (JSON has no ∞).
  const persistenceRatio = pHighNextGivenHigh !== null && pHighNextGivenLow !== null && pHighNextGivenLow > 0
    ? pHighNextGivenHigh / pHighNextGivenLow
    : null;
  const transitionPairs = pairsHighStart + pairsLowStart;
  const summary: WastePersistenceSummary = {
    transitionHH: HH,
    transitionHL: HL,
    transitionLH: LH,
    transitionLL: LL,
    transitionPairs,
    pHighNextGivenHigh,
    pHighNextGivenLow,
    persistenceRatio,
    // Two-sided Fisher exact on [[HH, HL], [LH, LL]] — the table of
    // consecutive active month pairs (decision 5). Null when there are
    // no pairs at all (nothing to test).
    fisherP: transitionPairs > 0 ? fisherExact2x2(HH, HL, LH, LL) : null,
    monthsWithMedian: medians.length,
    // Smallest active-outlet count among months with a median — surfaces
    // degenerate months (n=1: the sole outlet can never be "above").
    minActiveOutletsPerMonth: medians.length > 0
      ? Math.min(...medians.map((m) => m.activeOutlets))
      : 0,
    classDistribution,
    // Epistemic disclosure (house convention): the classes are a strong
    // measured PATTERN, not a root cause — same meaning as INDIKASI in
    // lib/insights.ts.
    epistemicLabel: 'INDIKASI',
  };
  return { outlets, medians, summary };
}
