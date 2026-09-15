// ============================================================
//  OutletPriorityPanel — display-rows builder (pure function)
//  (split from OutletPriorityPanel.tsx — SPLIT-G; pure code motion)
//
//  The body of the panel's big useMemo, extracted verbatim: maps
//  each lens' payload list onto the lens-agnostic CompactRow
//  shape, computes the shared mini-bar scale (maxValue), the
//  total count, and the lens-specific footer caption.
// ============================================================

import { fmtDecimal, fmtIDR, fmtNum, fmtPct } from '@/lib/format';
import type { RestoRecommendation } from '@/hooks/useRecommendations';
import type { OutletHealthRanking } from '@/hooks/useAnalysis';
import type { BenchmarkOpportunityResponse } from '@/components/dashboard/peer-comparison/benchmark-opportunity-card';
import type { ChangeAnalysisResponse, ChangeOutletStat } from '@/components/dashboard/narrative/ChangeItemTable';
import { healthScoreBg, healthScoreColor } from '@/components/dashboard/advanced-analysis/health-badges';
import { COMPACT_MAX, levelBarCls, levelValueCls, type CompactRow, type Lens } from './lens-model';

export interface BuildDisplayRowsArgs {
  lens: Lens;
  expanded: boolean;
  limit: number;
  recommendations: RestoRecommendation[];
  healthRanking: OutletHealthRanking[];
  opportunities: BenchmarkOpportunityResponse['topOutlets'];
  oppResp: BenchmarkOpportunityResponse | undefined;
  changeOutlets: ChangeOutletStat[];
  chgResp: ChangeAnalysisResponse | undefined;
  totalDev: number | null;
}

export interface DisplayRowsResult {
  shown: CompactRow[];
  maxValue: number;
  totalCount: number;
  footer: string;
}

export function buildDisplayRows({
  lens,
  expanded,
  limit,
  recommendations,
  healthRanking,
  opportunities,
  oppResp,
  changeOutlets,
  chgResp,
  totalDev,
}: BuildDisplayRowsArgs): DisplayRowsResult {
  let list: CompactRow[] = [];
  let count = 0;
  let foot = '';

  if (lens === 'prioritas') {
    count = recommendations.length;
    list = recommendations.slice(0, expanded ? COMPACT_MAX : limit).map((r) => ({
      key: r.outletCode,
      outletCode: r.outletCode,
      outletName: r.outletName,
      area: r.area,
      magnitude: r.priorityScore,
      valueLabel: String(Math.round(r.priorityScore)),
      valueCls: levelValueCls(r.priorityLevel),
      barCls: levelBarCls(r.priorityLevel),
      subLabel: `Loss ${fmtIDR(r.metrics.totalLoss)} · Dev ${fmtIDR(r.metrics.nominalDeviasi)}`,
      history: r.history,
      trendDeteriorating: r.signals.trendDeteriorating,
    }));
    // Footer — coverage share only when the optional network total is
    // present (same honest guard as the old card; capped at 100%).
    const shownAbsSum = list.reduce((sum, r) => {
      const rec = recommendations.find((x) => x.outletCode === r.outletCode);
      return sum + Math.abs(rec?.metrics.nominalDeviasi ?? 0);
    }, 0);
    const share = totalDev != null && totalDev > 0
      ? fmtPct(Math.min(1, shownAbsSum / totalDev), false, 0)
      : null;
    foot = share != null
      ? `Top ${list.length} dari ${count} resto · mewakili ${share} total deviasi`
      : `Top ${list.length} dari ${count} resto`;
  } else if (lens === 'kondisi') {
    count = healthRanking.length;
    list = healthRanking.slice(0, expanded ? COMPACT_MAX : limit).map((o: OutletHealthRanking) => ({
      key: o.outletCode,
      outletCode: o.outletCode,
      outletName: o.outletName,
      area: o.area,
      magnitude: o.healthScore,
      valueLabel: String(Math.round(o.healthScore)),
      valueCls: healthScoreColor(o.healthScore),
      barCls: healthScoreBg(o.healthScore),
      subLabel: `${o.abnormal} abnormal · ${o.warning} warning · ${o.normal} normal`,
    }));
    foot = `${count} resto dengan deviasi non-nol · ranking lengkap di tab Area`;
  } else if (lens === 'peluang') {
    count = opportunities.length;
    list = opportunities.slice(0, expanded ? COMPACT_MAX : limit).map((o) => ({
      key: o.outletCode,
      outletCode: o.outletCode,
      outletName: o.outletName,
      area: o.area,
      magnitude: o.opportunityRp,
      valueLabel: fmtIDR(o.opportunityRp),
      valueCls: 'text-amber-600 dark:text-amber-400',
      barCls: 'bg-amber-500',
      subLabel: `Loss ${fmtIDR(o.lossNominal)} · median area ${fmtIDR(o.areaMedianLoss)}`,
    }));
    foot = oppResp?.totalOpportunityRp != null
      ? `Total peluang ${fmtIDR(oppResp.totalOpportunityRp)} · ${oppResp.areaCount ?? 0} area (median resto satu area)`
      : '';
  } else {
    // Perubahan (CHANGE-1) — ratio-ranked rows; BARU_BERGERAK rows get a
    // full mini-bar (∞ ratio), finite ratios drive the scale.
    count = changeOutlets.length;
    const finiteMax = changeOutlets.reduce((m, o) => Math.max(m, o.ratioNominal ?? 0), 0);
    list = changeOutlets.slice(0, expanded ? COMPACT_MAX : limit).map((o) => ({
      key: o.outletCode,
      outletCode: o.outletCode,
      outletName: o.outletName,
      area: o.area ?? '—',
      magnitude: o.status === 'BARU_BERGERAK' ? (finiteMax > 0 ? finiteMax : 1) : (o.ratioNominal ?? 0),
      valueLabel: o.status === 'BARU_BERGERAK' ? '∞' : o.ratioNominal != null ? `${fmtDecimal(o.ratioNominal, 1)}×` : '—',
      valueCls: o.status === 'ANOMALI' ? 'text-red-600 dark:text-red-400' : o.status === 'BARU_BERGERAK' ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400',
      barCls: o.status === 'ANOMALI' ? 'bg-red-500' : o.status === 'BARU_BERGERAK' ? 'bg-amber-500' : 'bg-zinc-400',
      subLabel: `Biasanya ±${fmtIDR(o.avgSwingNominal)} → sekarang ${o.deltaNominal != null && o.deltaNominal > 0 ? '+' : ''}${fmtIDR(o.deltaNominal)} · Qty ±${fmtNum(o.avgSwingQty)} → ${o.deltaQty != null && o.deltaQty > 0 ? '+' : ''}${fmtNum(o.deltaQty)}`,
      status: o.status,
      isFlip: o.isFlip,
    }));
    const c = chgResp?.counts;
    foot = `Top ${list.length} dari ${count} resto bergerak${c && c.anomali > 0 ? ` · ${c.anomali} anomali` : ''}${c && c.baruBergerak > 0 ? ` · ${c.baruBergerak} mulai bergerak` : ''}${c && c.dataKurang > 0 ? ` · ${c.dataKurang} riwayat kurang` : ''}`;
  }

  const max = Math.max(...list.map((r) => r.magnitude), 0);
  return { shown: list, maxValue: max, totalCount: count, footer: foot };
}
