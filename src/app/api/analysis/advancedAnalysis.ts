// ============================================================
//  ANALYSIS API — Advanced analyses (all SQL-backed)
//   - Variance analysis (period-over-period changes per item-outlet)
//   - Outlet health ranking (composite 0-100 score)
//   - Item consistency analysis (deviations across multiple outlets)
//   - Area-level analysis (compare deviation performance across areas)
//  All functions are tolerant — failures are logged and a safe default
//  is returned, mirroring the original try/catch behaviour.
// ============================================================
import type { Client, InValue } from '@libsql/client';
// PERF-FIX Bug #5: thresholds are now passed in from route.ts (read ONCE)
// instead of each function re-reading from DB.
import type { RuntimeThresholds } from '@/lib/settings';
import type {
  VarianceAnalysis,
  VarianceItem,
  OutletHealthRank,
  ItemConsistency,
  ItemConsistencyLevel,
  AreaAnalysisItem,
  HistoricalAnalysisItem,
} from './types';
import {
  vaCurrentSql,
  vaPrevSql,
  healthRankSql,
  consistencySql,
  areaSql,
  areaSalesSql,
} from './queries';

export interface VarianceArgs {
  client: Client;
  monthLabel: string | null;
  currentWeek: string | null;
  compareMonth: string | null;
  compareWeek: string | null;
  area: string | null;
  outletCode: string | null;
  pic: string | null;
}

/**
 * Variance analysis — top items with biggest period-over-period change
 * in nominal deviation. Requires compareWeek to be set (auto or manual).
 *  - topWorsened: change > 0 (deviation grew — more loss or less surplus)
 *  - topImproved: change < 0 (deviation shrank — less loss or more surplus)
 * Only meaningful changes (|change| > 1M IDR) are kept.
 */
export async function computeVarianceAnalysis(args: VarianceArgs): Promise<VarianceAnalysis> {
  const { client, monthLabel, currentWeek, compareMonth, compareWeek } = args;
  const result: VarianceAnalysis = {
    topWorsened: [],
    topImproved: [],
    newItems: [],
    disappearedItems: [],
    directionReversals: [],
    stableItems: [],
  };

  if (!compareWeek || !(compareMonth || monthLabel) || !monthLabel || !currentWeek) {
    return result;
  }

  try {
    const cmpMonthVA = compareMonth || monthLabel;
    const opts = { area: args.area, outletCode: args.outletCode, pic: args.pic };

    const vaCurrentArgs: InValue[] = [monthLabel, currentWeek];
    if (args.area) vaCurrentArgs.push(args.area);
    if (args.outletCode) vaCurrentArgs.push(args.outletCode);
    if (args.pic) vaCurrentArgs.push(args.pic);

    const vaPrevArgs: InValue[] = [cmpMonthVA, compareWeek];
    if (args.area) vaPrevArgs.push(args.area);
    if (args.outletCode) vaPrevArgs.push(args.outletCode);
    if (args.pic) vaPrevArgs.push(args.pic);

    const [vaCurrRes, vaPrevRes] = await Promise.all([
      client.execute({ sql: vaCurrentSql(opts), args: vaCurrentArgs }),
      client.execute({ sql: vaPrevSql(opts), args: vaPrevArgs }),
    ]);

    // Build lookup: key = "outletCode|itemName" -> { nominal, direction, outletName }
    // FIX P0-1: Direction from QTY DEVIASI (not nominal) per §9
    // FIX L3: Include outletName for disappeared items
    const prevMap = new Map<string, { nominal: number; direction: string; outletName: string }>();
    for (const r of vaPrevRes.rows as Array<Record<string, unknown>>) {
      const nom = Number(r.nominal) || 0;
      const qty = Number(r.qtyDeviasi) || 0;
      const dir = qty > 0 ? 'LOSS' : qty < 0 ? 'SURPLUS' : 'NEUTRAL';
      prevMap.set(`${r.outletCode}|${r.itemName}`, { nominal: nom, direction: dir, outletName: String(r.outletName || '') });
    }

    // FIX P1-6: Track current keys to detect disappeared items
    const currKeys = new Set<string>();
    const newItems: VarianceItem[] = [];
    const directionReversals: VarianceItem[] = [];
    const changes: VarianceItem[] = [];
    // P2-6: Track STABLE items (|change| < 500K IDR) — not surfaced in worsened/improved
    const stableItems: VarianceItem[] = [];

    for (const r of vaCurrRes.rows as Array<Record<string, unknown>>) {
      const key = `${r.outletCode}|${r.itemName}`;
      currKeys.add(key);
      const currNom = Number(r.nominal) || 0;
      const currQty = Number(r.qtyDeviasi) || 0;
      // FIX P0-1: Direction from QTY sign (not nominal)
      const currDir = currQty > 0 ? 'LOSS' : currQty < 0 ? 'SURPLUS' : 'NEUTRAL';
      const outletName = String(r.outletName || '');
      const itemName = String(r.itemName || '');
      const outletCode = String(r.outletCode || '');

      const prev = prevMap.get(key);

      if (!prev) {
        // FIX P1-6: NEW item — exists in current but not in previous
        if (Math.abs(currNom) >= 1_000_000) {
          newItems.push({
            itemName,
            outletCode,
            outletName,
            currentNominal: currNom,
            previousNominal: 0,
            change: currNom,
            changePct: null,
            classification: 'NEW',
            currDirection: currDir,
          });
        }
        continue;
      }

      const prevNom = prev.nominal;
      const prevDir = prev.direction;
      const change = currNom - prevNom;

      // FIX P1-5: Direction reversal detection
      // If sign changed (LOSS↔SURPLUS) and change is significant
      if (prevDir !== currDir && prevDir !== 'NEUTRAL' && currDir !== 'NEUTRAL' && Math.abs(change) >= 1_000_000) {
        directionReversals.push({
          itemName,
          outletCode,
          outletName,
          currentNominal: currNom,
          previousNominal: prevNom,
          change,
          changePct: prevNom !== 0 ? change / Math.abs(prevNom) : null,
          classification: 'DIRECTION_REVERSAL',
          prevDirection: prevDir,
          currDirection: currDir,
        });
        continue; // don't also classify as worsened/improved
      }

      // P2-6: STABLE classification — |change| < 500K IDR
      // Skip the meaningful-change filter (1M) and instead capture these
      // small-change items separately as STABLE so they aren't surfaced
      // as worsened/improved (which would flood those lists with noise).
      if (Math.abs(change) < 500_000) {
        stableItems.push({
          itemName,
          outletCode,
          outletName,
          currentNominal: currNom,
          previousNominal: prevNom,
          change,
          changePct: prevNom !== 0 ? change / Math.abs(prevNom) : null,
          classification: 'STABLE',
          prevDirection: prevDir,
          currDirection: currDir,
        });
        continue;
      }

      // Only include meaningful changes (|change| > 1M IDR) for worsened/improved
      if (Math.abs(change) < 1_000_000) continue;
      const changePct = prevNom !== 0 ? change / Math.abs(prevNom) : null;

      changes.push({
        itemName,
        outletCode,
        outletName,
        currentNominal: currNom,
        previousNominal: prevNom,
        change,
        changePct,
        classification: change > 0 ? 'WORSENED' : 'IMPROVED',
        prevDirection: prevDir,
        currDirection: currDir,
      });
    }

    // FIX P1-6: Detect DISAPPEARED items — in previous but not in current
    const disappearedItems: VarianceItem[] = [];
    for (const [key, prev] of prevMap) {
      if (!currKeys.has(key)) {
        if (Math.abs(prev.nominal) >= 1_000_000) {
          const [outletCode, itemName] = key.split('|');
          disappearedItems.push({
            itemName,
            outletCode,
            outletName: prev.outletName, // FIX L3: now available from prevMap
            currentNominal: 0,
            previousNominal: prev.nominal,
            change: -prev.nominal,
            changePct: -1,
            classification: 'DISAPPEARED',
            prevDirection: prev.direction,
          });
        }
      }
    }

    // Worsened = change > 0 (deviation increased — more loss or less surplus)
    result.topWorsened = changes
      .filter((c) => c.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 10);
    // Improved = change < 0 (deviation decreased — less loss or more surplus)
    result.topImproved = changes
      .filter((c) => c.change < 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, 10);
    // FIX P1-6: new/disappeared/reversal
    result.newItems = newItems.sort((a, b) => Math.abs(b.currentNominal) - Math.abs(a.currentNominal)).slice(0, 10);
    result.disappearedItems = disappearedItems.sort((a, b) => Math.abs(b.previousNominal) - Math.abs(a.previousNominal)).slice(0, 10);
    result.directionReversals = directionReversals.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10);
    // P2-6: surface top 10 STABLE items by |change| (for visibility — these were previously dropped silently)
    result.stableItems = stableItems.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10);
  } catch (e) {
    console.error('[analysis] Variance analysis failed:', e);
  }

  return result;
}

/**
 * Outlet health ranking — composite 0-100 health score per outlet:
 *   - Deviation/BOM ratio        (weight 30%, 0%=100, 50%+=0)
 *   - Residual loss %            (weight 25%, 0%=100, 100%=0)
 *   - Loss/Sales ratio           (weight 25%, 0%=100, 20%+=0)
 *   - Abnormal item count        (weight 20%, 0=100, 50+=0)
 * Sorted worst-first (most actionable), top 15 returned with rank assigned.
 * FIX P1-1: Health score weights now read from Settings (WEIGHT_DEV_BOM,
 *   WEIGHT_RESIDUAL, WEIGHT_TOLERANCE, WEIGHT_HISTORY). The remaining
 *   weight (100 − sum of those four) is split equally between Loss/Sales
 *   and Abnormal via /200. Was previously hardcoded 0.30/0.25/0.25/0.20.
 * PERF-FIX Bug #5: thresholds passed as param — no longer reads from DB internally.
 */
export async function computeOutletHealthRanking(
  client: Client,
  where: string,
  args: InValue[],
  thresholds: RuntimeThresholds
): Promise<OutletHealthRank[]> {
  try {
    // FIX P1-1: Read health-score weights from settings
    const wDevBom = thresholds.WEIGHT_DEV_BOM / 100;        // 30 → 0.30
    const wResidual = thresholds.WEIGHT_RESIDUAL / 100;     // 20 → 0.20
    // FIX P1-1: WEIGHT_TOLERANCE / WEIGHT_HISTORY are subtracted from the
    // remaining weight pool that gets split between lossSales + abnormal.
    // P1-4: WEIGHT_GROWTH is also subtracted from the pool (was unused).
    // (Settings are wired into the runtime via the wLossSales computation
    // below — they are not multiplied into the score directly per the spec.)
    // Remaining weight split equally between lossSales and abnormal:
    // (100 − 5 weights) / 100 / 2 = (100 − 5 weights) / 200
    const wLossSales =
      (100 - thresholds.WEIGHT_DEV_BOM - thresholds.WEIGHT_RESIDUAL - thresholds.WEIGHT_TOLERANCE - thresholds.WEIGHT_HISTORY - thresholds.WEIGHT_GROWTH) / 200;
    const wAbnormal = wLossSales; // equal split

    const res = await client.execute({ sql: healthRankSql(where), args });

    const ranked = (res.rows as Array<Record<string, unknown>>).map((r) => {
      const qtyBom = Number(r.qtyBom) || 0;
      const qtyDeviasi = Number(r.qtyDeviasi) || 0;
      const residualQty = Number(r.residualQty) || 0;
      const totalLoss = Number(r.totalLoss) || 0;
      const sales = Number(r.sales) || 0;
      const absNominalDeviasi = Number(r.absNominalDeviasi) || 0;
      const abnormalCount = Number(r.abnormalCount) || 0;
      const totalItemCount = Number(r.totalItemCount) || 1; // avoid div-by-zero

      const devBomRatio = qtyBom > 0 ? qtyDeviasi / qtyBom : 0;
      const residualPct = qtyDeviasi > 0 ? residualQty / qtyDeviasi : 0;
      const lossToSales = sales > 0 ? totalLoss / sales : 0;

      // FIX P1-4: Normalize abnormalCount by total items (abnormal rate %)
      // Before: abnormalScore = 100 - abnormalCount × 2 (absolute count)
      //   → large outlets with 500 items unfairly penalized vs small outlets
      // After: abnormalScore = 100 - abnormalRate × 200 (percentage)
      //   → 50% abnormal rate = score 0, 0% = score 100
      const abnormalRate = totalItemCount > 0 ? abnormalCount / totalItemCount : 0;

      // Score components (each 0-100, higher = better)
      const devBomScore = Math.max(0, Math.min(100, 100 - devBomRatio * 200));
      const residualScore = Math.max(0, Math.min(100, 100 - residualPct * 100));
      const lossSalesScore = Math.max(0, Math.min(100, 100 - lossToSales * 500));
      const abnormalScore = Math.max(0, Math.min(100, 100 - abnormalRate * 200));

      // FIX P1-1: Weights now come from Settings (was hardcoded 0.30/0.25/0.25/0.20)
      const healthScore = Math.round(
        devBomScore * wDevBom +
          residualScore * wResidual +
          lossSalesScore * wLossSales +
          abnormalScore * wAbnormal
      );

      return {
        outletCode: String(r.outletCode),
        outletName: String(r.outletName),
        area: String(r.area),
        healthScore,
        devBomRatio,
        residualPct,
        lossToSales,
        abnormalCount,
        totalNominalDeviasi: absNominalDeviasi,
        rank: 0, // assigned after sorting
      };
    });

    // Sort by health score ascending (worst first — most actionable)
    ranked.sort((a, b) => a.healthScore - b.healthScore);
    ranked.forEach((r, i) => {
      r.rank = i + 1;
    });
    return ranked.slice(0, 15); // top 15 worst outlets
  } catch (e) {
    console.error('[analysis] Outlet health ranking failed:', e);
    return [];
  }
}

/**
 * Item consistency analysis — items that deviate across MULTIPLE outlets
 * (systemic) vs one-off anomalies. Helps identify product-wide problems.
 *  - SYSTEMIC:   ≥10 outlets
 *  - WIDESPREAD: ≥5 outlets
 *  - ISOLATED:   2-4 outlets
 */
export async function computeItemConsistencyAnalysis(
  client: Client,
  where: string,
  args: InValue[]
): Promise<ItemConsistency[]> {
  try {
    const res = await client.execute({ sql: consistencySql(where), args });
    return (res.rows as Array<Record<string, unknown>>).map((r) => {
      const outletCount = Number(r.outletCount) || 0;
      const consistency: ItemConsistencyLevel =
        outletCount >= 10 ? 'SYSTEMIC' : outletCount >= 5 ? 'WIDESPREAD' : 'ISOLATED';
      return {
        itemName: String(r.itemName),
        satuan: r.satuan ? String(r.satuan) : '',
        outletCount,
        totalAbsNominal: Number(r.totalAbsNominal) || 0,
        avgDevBom: Number(r.avgDevBom) || 0,
        lossOutlets: Number(r.lossOutlets) || 0,
        surplusOutlets: Number(r.surplusOutlets) || 0,
        consistency,
      };
    });
  } catch (e) {
    console.error('[analysis] Item consistency analysis failed:', e);
    return [];
  }
}

/**
 * Area-level analysis — compare deviation performance across areas.
 * Sales per area = SUM of MAX-per-outlet (avoids duplication across item rows).
 * Sorted by total absolute nominal deviation descending (worst area first).
 */
export async function computeAreaAnalysis(
  client: Client,
  where: string,
  args: InValue[]
): Promise<AreaAnalysisItem[]> {
  try {
    const areaRes = await client.execute({ sql: areaSql(where), args });
    // Sales per area (MAX per outlet, then sum per area)
    const areaSalesRes = await client.execute({ sql: areaSalesSql(where), args });
    const areaSalesMap = new Map<string, number>();
    for (const s of areaSalesRes.rows as Array<Record<string, unknown>>) {
      const areaKey = String(s.area);
      areaSalesMap.set(areaKey, (areaSalesMap.get(areaKey) || 0) + (Number(s.sales) || 0));
    }

    return (areaRes.rows as Array<Record<string, unknown>>)
      .map((r) => {
        const qtyBom = Number(r.qtyBom) || 0;
        const qtyDeviasi = Number(r.qtyDeviasi) || 0;
        const absNominal = Number(r.absNominal) || 0;
        const totalLoss = Number(r.totalLoss) || 0;
        const sales = areaSalesMap.get(String(r.area)) || 0;
        return {
          area: String(r.area),
          outletCount: Number(r.outletCount) || 0,
          totalSales: sales,
          totalAbsNominal: absNominal,
          avgDevBom: qtyBom > 0 ? qtyDeviasi / qtyBom : 0,
          lossToSales: sales > 0 ? totalLoss / sales : 0,
        };
      })
      // FIX P0-3: Sort by lossToSales DESC (most wasteful first), not by
      // absolute nominal. Previously, high-sales areas were unfairly ranked
      // "worst" because their absolute nominal deviation was larger, even
      // though their loss/sales ratio was better. Areas with sales=0 get
      // lossToSales=0 (ranked last) to avoid division-by-zero false positives.
      .sort((a, b) => b.lossToSales - a.lossToSales);
  } catch (e) {
    console.error('[analysis] Area analysis failed:', e);
    return [];
  }
}

// ============================================================
//  P0-2: Historical Z-Score analysis
//  For each outlet, query its absolute nominal deviation for the last
//  N weeks (HISTORICAL_MIN_WEEKS) excluding the current period, then
//  compute the mean + stdDev and the current period's z-score:
//    z = (current − mean) / stdDev
//  Outlets with z > HISTORICAL_ZSCORE_WARN are flagged abnormal; those
//  with z > HISTORICAL_ZSCORE_HIGH are flagged critical. Outlets with
//  fewer than HISTORICAL_MIN_WEEKS of history are skipped (cannot
//  compute a meaningful z-score).
// ============================================================
export async function computeHistoricalAnalysis(
  client: Client,
  where: string,
  args: InValue[],
  monthLabel: string | null,
  currentWeek: string | null,
  thresholds: RuntimeThresholds
): Promise<HistoricalAnalysisItem[]> {
  if (!monthLabel || !currentWeek) return [];
  try {
    const minWeeks = Math.max(2, Math.floor(thresholds.HISTORICAL_MIN_WEEKS));
    const warnZ = thresholds.HISTORICAL_ZSCORE_WARN;
    const highZ = thresholds.HISTORICAL_ZSCORE_HIGH;

    // Strategy: query per (outlet, period) aggregates, then in-memory compute
    // the z-score for each outlet using the prior `minWeeks` periods.
    // The `where` clause from buildWhereClause includes month/week filters —
    // we want history across ALL periods. Strip the month/week conditions
    // from the where string by removing "r.monthLabel = ?" and "r.weekLabel = ?"
    // clauses. The corresponding args are the first 1-2 entries in `args`
    // (buildWhereClause emits conditions in this order: month, week, area,
    // outlet, pic), so we slice off the first N where N = (monthLabel?1:0) + (currentWeek?1:0).
    const cleanedWhere = where
      .replace(/^WHERE\s+/i, '')
      .replace(/r\.monthLabel\s*=\s*\?\s*AND\s*/gi, '')
      .replace(/\s*AND\s*r\.monthLabel\s*=\s*\?/gi, '')
      .replace(/r\.monthLabel\s*=\s*\?/gi, '')
      .replace(/r\.weekLabel\s*=\s*\?\s*AND\s*/gi, '')
      .replace(/\s*AND\s*r\.weekLabel\s*=\s*\?/gi, '')
      .replace(/r\.weekLabel\s*=\s*\?/gi, '')
      .trim();
    const skipCount = (monthLabel ? 1 : 0) + (currentWeek ? 1 : 0);
    const historyArgs = args.slice(skipCount);
    const historyWhereClause = cleanedWhere ? 'WHERE ' + cleanedWhere : '';

    const finalSql = `
      SELECT
        o.code AS outletCode,
        o.name AS outletName,
        o.area AS area,
        r.monthLabel AS monthLabel,
        r.weekLabel AS weekLabel,
        SUM(ABS(COALESCE(r.nominalDeviasi, 0))) AS absNominal
      FROM InventoryRecord r
      JOIN Outlet o ON r.outletId = o.id
      ${historyWhereClause}
      GROUP BY o.code, o.name, o.area, r.monthLabel, r.weekLabel
      ORDER BY o.code,
        CAST(SUBSTR(r.monthLabel, LENGTH(r.monthLabel) - 3) AS INTEGER) * 100 +
        CASE
          WHEN r.monthLabel LIKE 'Januari%' THEN 1
          WHEN r.monthLabel LIKE 'Februari%' THEN 2
          WHEN r.monthLabel LIKE 'Maret%' THEN 3
          WHEN r.monthLabel LIKE 'April%' THEN 4
          WHEN r.monthLabel LIKE 'Mei%' THEN 5
          WHEN r.monthLabel LIKE 'Juni%' THEN 6
          WHEN r.monthLabel LIKE 'Juli%' THEN 7
          WHEN r.monthLabel LIKE 'Agustus%' THEN 8
          WHEN r.monthLabel LIKE 'September%' THEN 9
          WHEN r.monthLabel LIKE 'Oktober%' THEN 10
          WHEN r.monthLabel LIKE 'November%' THEN 11
          WHEN r.monthLabel LIKE 'Desember%' THEN 12
          ELSE 99
        END,
        CASE
          WHEN r.weekLabel LIKE '%1' AND r.weekLabel NOT LIKE '%10%' AND r.weekLabel NOT LIKE '%11%' AND r.weekLabel NOT LIKE '%12%' THEN 1
          WHEN r.weekLabel LIKE '%2' AND r.weekLabel NOT LIKE '%12%' AND r.weekLabel NOT LIKE '%20%' AND r.weekLabel NOT LIKE '%21%' THEN 2
          WHEN r.weekLabel LIKE '%3' AND r.weekLabel NOT LIKE '%13%' AND r.weekLabel NOT LIKE '%23%' AND r.weekLabel NOT LIKE '%30%' THEN 3
          WHEN r.weekLabel LIKE '%4' AND r.weekLabel NOT LIKE '%14%' AND r.weekLabel NOT LIKE '%24%' AND r.weekLabel NOT LIKE '%34%' THEN 4
          WHEN r.weekLabel LIKE '%5' AND r.weekLabel NOT LIKE '%15%' AND r.weekLabel NOT LIKE '%25%' THEN 5
          ELSE 99
        END
    `;
    const res = await client.execute({ sql: finalSql, args: historyArgs });

    // Group by outlet — each outlet gets a chronological series of (period → absNominal)
    const outletSeries = new Map<string, { outletName: string; area: string; series: Array<{ period: string; value: number }> }>();
    for (const r of res.rows as Array<Record<string, unknown>>) {
      const code = String(r.outletCode);
      const period = `${r.weekLabel} ${r.monthLabel}`;
      const value = Number(r.absNominal) || 0;
      const entry = outletSeries.get(code) || {
        outletName: String(r.outletName),
        area: String(r.area),
        series: [],
      };
      entry.series.push({ period, value });
      outletSeries.set(code, entry);
    }

    const results: HistoricalAnalysisItem[] = [];
    for (const [code, entry] of outletSeries) {
      const idx = entry.series.findIndex((s) => s.period === `${currentWeek} ${monthLabel}`);
      if (idx < 0) continue; // current period not in series
      // Use last `minWeeks` periods BEFORE the current period
      const history = entry.series.slice(Math.max(0, idx - minWeeks), idx);
      if (history.length < minWeeks) continue;
      const current = entry.series[idx].value;
      const values = history.map((h) => h.value);
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      const zScore = stdDev > 0 ? (current - mean) / stdDev : null;
      const isAbnormal = zScore != null && zScore > warnZ;
      const isCritical = zScore != null && zScore > highZ;
      if (!isAbnormal) continue; // only surface abnormal outlets to keep payload small
      results.push({
        outletCode: code,
        outletName: entry.outletName,
        area: entry.area,
        current,
        avg: mean,
        stdDev,
        zScore,
        weeksUsed: history.length,
        isAbnormal,
        isCritical,
      });
    }

    // Sort by zScore DESC — most abnormal first
    return results.sort((a, b) => (b.zScore ?? 0) - (a.zScore ?? 0));
  } catch (e) {
    console.error('[analysis] Historical analysis failed:', e);
    return [];
  }
}
