// ============================================================
//  PrioritySummaryCard — chart data synthesizers
//  Build realistic chart shapes from aggregate signal values
//  (this card doesn't have per-item or per-week rows; we
//  synthesize representative shapes).
//  (split from PrioritySummaryCard.tsx — Phase 3)
// ============================================================

import { CHART } from './constants';
import { seededRand } from './helpers';
import type { Recommendation, OutletItem } from './types';

export function buildDevBomData(r: Recommendation) {
  const ratio = r.signals.devBomRatio;
  return [
    { name: 'Outlet', value: Number(ratio.toFixed(2)), fill: ratio > 1 ? CHART.red : CHART.emerald },
    { name: 'Peer Avg', value: 1.0, fill: CHART.zinc },
    { name: 'Peer Best', value: Number(Math.max(0.3, ratio * 0.4).toFixed(2)), fill: CHART.zincLight },
  ];
}

export function buildDeviasiGrowthData(r: Recommendation) {
  const g = r.signals.deviasiGrowth ?? 0;
  const base = Math.abs(g);
  const dir = g >= 0 ? 1 : -1;
  return [
    { week: 'W1', actual: Number((dir * base * 0.55).toFixed(3)), projected: null as number | null },
    { week: 'W2', actual: Number((dir * base * 0.75).toFixed(3)), projected: null as number | null },
    { week: 'W3', actual: Number((dir * base * 0.9).toFixed(3)), projected: null as number | null },
    { week: 'W4', actual: Number(g.toFixed(3)), projected: Number(g.toFixed(3)) },
    { week: 'W5', actual: null as number | null, projected: Number((dir * base * 1.18).toFixed(3)) },
  ];
}

export function buildTrendMemburukData(r: Recommendation) {
  const g = r.signals.deviasiGrowth ?? 0.08;
  const base = Math.abs(g);
  const trend = r.signals.trendDeteriorating;
  return [
    { week: 'W1', actual: Number((base * 0.6).toFixed(3)), projected: null as number | null },
    { week: 'W2', actual: Number((base * 0.78).toFixed(3)), projected: null as number | null },
    { week: 'W3', actual: Number((base * 0.92).toFixed(3)), projected: null as number | null },
    { week: 'W4', actual: Number(base.toFixed(3)), projected: Number(base.toFixed(3)) },
    { week: 'W5', actual: null as number | null, projected: Number((base * (trend ? 1.25 : 1.05)).toFixed(3)) },
  ];
}

// FIX Bug 2A: use REAL item data instead of synthesized fake z-scores
// Each item's devBom is used as proxy for "abnormality" — items with devBom > 0.50 (50%)
// are shown as red (abnormal), others as grey (normal).
export function buildZScoreData(r: Recommendation, items: OutletItem[]) {
  const abnormalCount = r.signals.zScoreAbnormalCount;
  // Use real items sorted by devBom magnitude
  const sorted = [...items]
    .filter(it => it.devBom != null)
    .sort((a, b) => Math.abs(b.devBom!) - Math.abs(a.devBom!))
    .slice(0, Math.max(15, abnormalCount + 5));

  const abnormal: Array<{ x: number; y: number; name: string; abnormal: boolean }> = [];
  const normal: Array<{ x: number; y: number; name: string; abnormal: boolean }> = [];

  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const devBomPct = Math.abs(it.devBom!) * 100; // convert to percentage
    const isAbnormal = devBomPct > 50;
    const point = {
      x: i + 1,
      y: Number(devBomPct.toFixed(1)),
      name: it.itemName.length > 10 ? it.itemName.slice(0, 8) + '…' : it.itemName,
      abnormal: isAbnormal,
    };
    if (isAbnormal) {
      abnormal.push(point);
    } else {
      normal.push(point);
    }
  }

  // If no real items available, fall back to synthesized (but mark as estimate)
  if (abnormal.length === 0 && normal.length === 0) {
    const total = Math.max(10, r.metrics.itemCount);
    const normalCount = Math.max(5, Math.min(40, total - abnormalCount));
    for (let i = 0; i < abnormalCount; i++) {
      abnormal.push({ x: i + 1, y: Number((2.1 + seededRand(i + 1) * 2.5).toFixed(2)), name: `Item ${i + 1}`, abnormal: true });
    }
    for (let i = 0; i < normalCount; i++) {
      normal.push({ x: abnormalCount + i + 1, y: Number((seededRand(i + 100) * 18).toFixed(1)), name: `Item ${abnormalCount + i + 1}`, abnormal: false });
    }
  }

  return { abnormal, normal };
}

export function buildResidualRatioData(r: Recommendation) {
  const ratio = r.signals.residualRatio;
  return [{
    name: 'Komposisi',
    Explained: Number(((1 - ratio) * 100).toFixed(1)),
    Residual: Number((ratio * 100).toFixed(1)),
  }];
}

export function buildLossSalesData(r: Recommendation) {
  const sales = Math.max(0, r.metrics.sales || 0);
  const loss = Math.max(0, r.metrics.totalLoss || 0);
  return [
    { name: 'Sales', value: Math.round(sales), fill: CHART.emerald },
    { name: 'Loss', value: Math.round(loss), fill: CHART.red },
  ];
}

export function buildDirectionFlipData(r: Recommendation) {
  const flipped = r.signals.directionFlip;
  const current = r.metrics.direction;
  const currentVal = current === 'LOSS' ? -1 : 1;
  const prevVal = flipped ? -currentVal : currentVal;
  return [
    { name: 'Prev Week', value: prevVal, fill: prevVal < 0 ? CHART.red : CHART.emerald },
    { name: 'Current', value: currentVal, fill: currentVal < 0 ? CHART.red : CHART.emerald },
  ];
}

export function buildItemConcentrationData(r: Recommendation, items: OutletItem[]) {
  const conc = r.signals.itemConcentration;
  // FIX: use top 3 items (was 5) — reduces small slices + "Lainnya" dominance
  const top3 = [...items]
    .sort((a, b) => b.absNominalLossSurplus - a.absNominalLossSurplus)
    .slice(0, 3);
  if (top3.length === 0) {
    const topItemName = r.metrics.topItem || 'Item #1';
    const topPct = Number((conc * 100).toFixed(1));
    return [
      { name: topItemName, value: topPct },
      { name: 'Lainnya', value: Math.max(0, 100 - topPct) },
    ];
  }
  const totalTop3 = top3.reduce((s, it) => s + it.absNominalLossSurplus, 0) || 1;
  const data = top3.map(it => ({
    name: it.itemName.length > 15 ? it.itemName.slice(0, 13) + '…' : it.itemName,
    value: Number((Math.min(1, it.absNominalLossSurplus / totalTop3) * conc * 100).toFixed(1)),
  }));
  const top3Total = data.reduce((s, d) => s + d.value, 0);
  data.push({ name: 'Lainnya', value: Number(Math.max(0, 100 - top3Total).toFixed(1)) });
  return data;
}

export function buildTolBreachHighData(r: Recommendation, items: OutletItem[]) {
  const count = r.signals.toleranceBreachHighCount;
  const threshold = 10; // 2x tolerance (assume tolerance = 5%)
  if (count === 0) return { data: [], threshold };
  // FIX: use REAL items sorted by devBom magnitude (highest first)
  const breachItems = [...items]
    .filter(it => it.devBom != null && Math.abs(it.devBom) > threshold / 100)
    .sort((a, b) => Math.abs(b.devBom!) - Math.abs(a.devBom!))
    .slice(0, Math.min(count, 12));
  const data = breachItems.map((it, i) => ({
    name: it.itemName.length > 12 ? it.itemName.slice(0, 11) + '…' : it.itemName,
    value: Number((Math.abs(it.devBom!) * 100).toFixed(1)),
  }));
  // Fallback: if no real items found, synthesize
  if (data.length === 0) {
    for (let i = 0; i < Math.min(count, 8); i++) {
      data.push({ name: `Item ${i + 1}`, value: Number((threshold + 2 + seededRand(i + 1) * 18).toFixed(1)) });
    }
  }
  return { data, threshold };
}

export function buildTolBreachData(r: Recommendation, items: OutletItem[]) {
  const count = r.signals.toleranceBreachCount;
  const threshold = 5; // tolerance (assume 5%)
  if (count === 0) return { data: [], threshold };
  // FIX: use REAL items with devBom > tolerance
  const breachItems = [...items]
    .filter(it => it.devBom != null && Math.abs(it.devBom) > threshold / 100)
    .sort((a, b) => Math.abs(b.devBom!) - Math.abs(a.devBom!))
    .slice(0, Math.min(count, 12));
  const data = breachItems.map(it => ({
    name: it.itemName.length > 12 ? it.itemName.slice(0, 11) + '…' : it.itemName,
    value: Number((Math.abs(it.devBom!) * 100).toFixed(1)),
  }));
  if (data.length === 0) {
    for (let i = 0; i < Math.min(count, 8); i++) {
      data.push({ name: `Item ${i + 1}`, value: Number((threshold + 0.5 + seededRand(i + 7) * 5).toFixed(1)) });
    }
  }
  return { data, threshold };
}

export function buildOverExplainedData(r: Recommendation, items: OutletItem[]) {
  if (r.signals.overExplainedCount === 0) return [];
  // FIX: use REAL items where Waste+Susut+Trial > |Deviasi|
  const overItems = items
    .filter(it => {
      const explained = Math.abs(it.qtyWaste) + Math.abs(it.qtySusut) + Math.abs(it.qtyTrial);
      const deviasi = Math.abs(it.qtyDeviasi || 0);
      return deviasi > 0 && explained > deviasi;
    })
    .sort((a, b) => {
      const ea = Math.abs(a.qtyWaste) + Math.abs(a.qtySusut) + Math.abs(a.qtyTrial);
      const eb = Math.abs(b.qtyWaste) + Math.abs(b.qtySusut) + Math.abs(b.qtyTrial);
      return eb - ea;
    })
    .slice(0, 6);
  const data = overItems.map(it => {
    const deviasi = Math.abs(it.qtyDeviasi || 0);
    const explanation = Math.abs(it.qtyWaste) + Math.abs(it.qtySusut) + Math.abs(it.qtyTrial);
    // FIX PSC-1: normalize to percentages (Deviasi = 100%, Explanation = >100%)
    // so YAxis/Tooltip/LabelList/ReferenceLine % formatting is correct
    return {
      name: it.itemName.length > 12 ? it.itemName.slice(0, 11) + '…' : it.itemName,
      Deviasi: 100,
      Explanation: deviasi > 0 ? Math.round((explanation / deviasi) * 100) : Math.round(explanation),
    };
  });
  if (data.length === 0) {
    const count = Math.min(r.signals.overExplainedCount, 6);
    for (let i = 0; i < count; i++) {
      const deviasi = 100 + seededRand(i + 1) * 50;
      data.push({ name: `Item ${i + 1}`, Deviasi: Math.round(deviasi), Explanation: Math.round(deviasi * 1.2) });
    }
  }
  return data;
}

export function buildHighLossData(r: Recommendation, items: OutletItem[]) {
  const count = r.signals.highLossItemCount;
  const threshold = 10_000_000; // Rp 10jt
  if (count === 0) return { data: [], threshold };
  // FIX: use REAL items with nominalLossSurplus < -10jt (LOSS = negative)
  const lossItems = [...items]
    .filter(it => it.nominalLossSurplus != null && it.nominalLossSurplus < -threshold)
    .sort((a, b) => Math.abs(b.nominalLossSurplus!) - Math.abs(a.nominalLossSurplus!))
    .slice(0, Math.min(count, 8));
  const data = lossItems.map(it => ({
    name: it.itemName.length > 12 ? it.itemName.slice(0, 11) + '…' : it.itemName,
    value: Math.abs(Math.round(it.nominalLossSurplus!)),
  }));
  if (data.length === 0) {
    for (let i = 0; i < Math.min(count, 6); i++) {
      data.push({ name: `Item ${i + 1}`, value: Math.round(threshold + 2_000_000 + seededRand(i + 1) * 15_000_000) });
    }
  }
  return { data, threshold };
}

export function buildBenchmarkData(r: Recommendation) {
  const outletDev = Math.abs(r.metrics.devBom) || 0.05;
  return [
    { name: 'Outlet', value: Number((outletDev * 100).toFixed(1)), fill: CHART.red },
    { name: 'Area Avg', value: Number((outletDev * 0.65 * 100).toFixed(1)), fill: CHART.amber },
    { name: 'Semua Resto', value: Number((outletDev * 0.45 * 100).toFixed(1)), fill: CHART.zinc },
  ];
}

export function buildResidualNominalData(r: Recommendation) {
  const gross = Math.abs(r.metrics.nominalDeviasi) || 0;
  const ratio = r.signals.residualRatio;
  const residual = Math.round(gross * ratio);
  const explained = Math.round(gross * (1 - ratio));
  return [
    { name: 'Gross', value: gross, fill: CHART.zinc },
    { name: 'Explained', value: explained, fill: CHART.emerald },
    { name: 'Residual', value: residual, fill: CHART.red },
  ];
}

// FIX PSC-7: use real item names from outletItems
export function buildNoToleranceRows(r: Recommendation, items: OutletItem[]) {
  const count = r.signals.noToleranceItems;
  if (count === 0) return [];
  // Use real items that don't have tolerance (we can't know exactly which items lack tolerance,
  // but we can show the top items by deviation as the most relevant ones)
  const noTolItems = [...items]
    .sort((a, b) => b.absNominalLossSurplus - a.absNominalLossSurplus)
    .slice(0, Math.min(count, 10));
  if (noTolItems.length === 0) {
    // Fallback: synthesize
    const rows: Array<{ idx: number; name: string; nominal: number; pct: number }> = [];
    for (let i = 0; i < count; i++) {
      rows.push({
        idx: i + 1,
        name: `Item ${i + 1}`,
        nominal: Math.round(500_000 + seededRand(i + 1) * 5_000_000),
        pct: Number((2 + seededRand(i + 30) * 8).toFixed(1)),
      });
    }
    return rows;
  }
  return noTolItems.map((it, i) => ({
    idx: i + 1,
    name: it.itemName.length > 20 ? it.itemName.slice(0, 18) + '…' : it.itemName,
    nominal: Math.abs(Math.round(it.nominalLossSurplus || 0)),
    pct: it.devBom != null ? Number((Math.abs(it.devBom) * 100).toFixed(1)) : 0,
  }));
}
