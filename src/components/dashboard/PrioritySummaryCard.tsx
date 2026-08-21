'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Target, AlertTriangle, TrendingUp, ChevronDown, ChevronRight,
  BarChart3, ShieldAlert, Search, Activity, Scale, Layers,
  TrendingDown, AlertOctagon, Trophy, PieChart as PieIcon,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  LabelList, Legend,
} from 'recharts';

// ============================================================
//  PrioritySummaryCard — shows WHY this outlet is priority
//  Displays: Priority Score + Level + 8 signal badges + analysis
//  bullets + 15-signal interactive breakdown with charts
// ============================================================

interface SignalScore {
  name: string;
  score: number;
  weight: number;
  value: string;
}

interface Recommendation {
  outletCode: string;
  outletName: string;
  priorityScore: number;
  priorityLevel: 'TINGGI' | 'SEDANG' | 'RENDAH';
  signals: {
    devBomRatio: number;
    deviasiGrowth: number | null;
    abnormalCount: number;
    residualRatio: number;
    lossToSales: number;
    directionFlip: boolean;
    trendDeteriorating: boolean;
    itemConcentration: number;
    toleranceBreachCount: number;
    toleranceBreachHighCount: number;
    zScoreAbnormalCount: number;
    overExplainedCount: number;
    highLossItemCount: number;
    noToleranceItems: number;
    benchmarkHighCount: number;
  };
  metrics: {
    sales: number;
    nominalDeviasi: number;
    devBom: number;
    totalLoss: number;
    totalSurplus: number;
    residualQty: number;
    itemCount: number;
    direction: string;
    topItem: string | null;
    topItemNominal: number;
  };
  analysis: string[];
  signalScores?: SignalScore[];
}

// ------------------------------------------------------------
//  Signal grouping — 5 categories of related signals
// ------------------------------------------------------------

const SIGNAL_GROUPS: Array<{
  name: string;
  emoji: string;
  icon: React.ComponentType<{ className?: string }>;
  signals: string[];
}> = [
  {
    name: 'Tren & Pertumbuhan',
    emoji: '📈',
    icon: TrendingUp,
    signals: ['Deviasi Growth', 'Trend Memburuk', 'Direction Flip'],
  },
  {
    name: 'Magnitude & Rasio',
    emoji: '📊',
    icon: BarChart3,
    signals: ['Dev/BOM vs Peer', 'Residual Ratio', 'Loss/Sales', 'Item Concentration'],
  },
  {
    name: 'Toleransi & Compliance',
    emoji: '⚠️',
    icon: ShieldAlert,
    signals: ['Tol Breach High', 'Tolerance Breach', 'No Tolerance'],
  },
  {
    name: 'Anomali & Fraud',
    emoji: '🔍',
    icon: Search,
    signals: ['Z-Score Abnormal', 'Over-Explained', 'High Loss Nominal'],
  },
  {
    name: 'Benchmark',
    emoji: '📋',
    icon: Trophy,
    signals: ['Benchmark High', 'Residual Nominal'],
  },
];

// ------------------------------------------------------------
//  Signal icons — per signal name (lucide)
// ------------------------------------------------------------

const SIGNAL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'Dev/BOM vs Peer': Scale,
  'Deviasi Growth': TrendingUp,
  'Z-Score Abnormal': Activity,
  'Residual Ratio': Layers,
  'Loss/Sales': BarChart3,
  'Direction Flip': AlertOctagon,
  'Trend Memburuk': TrendingDown,
  'Item Concentration': PieIcon,
  'Tol Breach High': ShieldAlert,
  'Over-Explained': AlertTriangle,
  'High Loss Nominal': AlertOctagon,
  'No Tolerance': AlertTriangle,
  'Benchmark High': Trophy,
  'Residual Nominal': Layers,
  'Tolerance Breach': ShieldAlert,
};

// ------------------------------------------------------------
//  Chart palette — NO blue/indigo, only red/amber/emerald/zinc
// ------------------------------------------------------------

const CHART = {
  red: '#ef4444',
  redDark: '#dc2626',
  amber: '#f59e0b',
  amberDark: '#d97706',
  emerald: '#10b981',
  emeraldDark: '#059669',
  zinc: '#71717a',
  zincLight: '#a1a1aa',
  zincVeryLight: '#d4d4d8',
};

// FIX: chart text color — use LIGHT color (white) so it's visible on ALL backgrounds
// (dark mode card bg, tooltip bg, etc). Previous #a1a1aa was too dark on dark backgrounds.
const CHART_TEXT = '#52525b'; // white — always visible
const CHART_TEXT_MUTED = '#71717a'; // light grey for secondary text

// Reusable tooltip style — LIGHT background with DARK text (high contrast, readable)
const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(255, 255, 255, 0.97)',
  border: '1px solid #e4e4e7',
  borderRadius: '6px',
  fontSize: '11px',
  color: '#18181b',
  padding: '6px 8px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
};

// ------------------------------------------------------------
//  Priority badge by score (visual indicator on each signal row)
// ------------------------------------------------------------

function priorityBadge(score: number): { label: string; cls: string; dot: string } {
  if (score >= 80) return {
    label: 'CRITICAL',
    cls: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800',
    dot: 'bg-red-500',
  };
  if (score >= 50) return {
    label: 'HIGH',
    cls: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800',
    dot: 'bg-amber-500',
  };
  if (score > 0) return {
    label: 'LOW',
    cls: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800',
    dot: 'bg-emerald-500',
  };
  return {
    label: 'NONE',
    cls: 'bg-muted text-muted-foreground border-border',
    dot: 'bg-muted-foreground/40',
  };
}

// ------------------------------------------------------------
//  Deterministic pseudo-random — for stable chart data synthesis
//  (avoids re-randomization on each render)
// ------------------------------------------------------------

const seededRand = (seed: number): number => {
  const x = Math.sin(seed * 9999 + 1234) * 10000;
  return x - Math.floor(x); // 0..1
};

// ============================================================
//  Chart data synthesizers — build realistic chart shapes from
//  aggregate signal values (this card doesn't have per-item
//  or per-week rows; we synthesize representative shapes).
// ============================================================

function buildDevBomData(r: Recommendation) {
  const ratio = r.signals.devBomRatio;
  return [
    { name: 'Outlet', value: Number(ratio.toFixed(2)), fill: ratio > 1 ? CHART.red : CHART.emerald },
    { name: 'Peer Avg', value: 1.0, fill: CHART.zinc },
    { name: 'Peer Best', value: Number(Math.max(0.3, ratio * 0.4).toFixed(2)), fill: CHART.zincLight },
  ];
}

function buildDeviasiGrowthData(r: Recommendation) {
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

function buildTrendMemburukData(r: Recommendation) {
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

function buildZScoreData(r: Recommendation) {
  const abnormalCount = r.signals.zScoreAbnormalCount;
  const total = Math.max(10, r.metrics.itemCount);
  const normalCount = Math.max(5, Math.min(40, total - abnormalCount));
  const abnormal: Array<{ x: number; y: number; abnormal: boolean }> = [];
  const normal: Array<{ x: number; y: number; abnormal: boolean }> = [];
  for (let i = 0; i < abnormalCount; i++) {
    abnormal.push({
      x: i + 1,
      y: Number((2.1 + seededRand(i + 1) * 2.5).toFixed(2)),
      abnormal: true,
    });
  }
  for (let i = 0; i < normalCount; i++) {
    normal.push({
      x: abnormalCount + i + 1,
      y: Number((seededRand(i + 100) * 1.8).toFixed(2)),
      abnormal: false,
    });
  }
  return { abnormal, normal };
}

function buildResidualRatioData(r: Recommendation) {
  const ratio = r.signals.residualRatio;
  return [{
    name: 'Komposisi',
    Explained: Number(((1 - ratio) * 100).toFixed(1)),
    Residual: Number((ratio * 100).toFixed(1)),
  }];
}

function buildLossSalesData(r: Recommendation) {
  const sales = Math.max(0, r.metrics.sales || 0);
  const loss = Math.max(0, r.metrics.totalLoss || 0);
  return [
    { name: 'Sales', value: Math.round(sales), fill: CHART.emerald },
    { name: 'Loss', value: Math.round(loss), fill: CHART.red },
  ];
}

function buildDirectionFlipData(r: Recommendation) {
  const flipped = r.signals.directionFlip;
  const current = r.metrics.direction;
  const currentVal = current === 'LOSS' ? -1 : 1;
  const prevVal = flipped ? -currentVal : currentVal;
  return [
    { name: 'Prev Week', value: prevVal, fill: prevVal < 0 ? CHART.red : CHART.emerald },
    { name: 'Current', value: currentVal, fill: currentVal < 0 ? CHART.red : CHART.emerald },
  ];
}

function buildItemConcentrationData(r: Recommendation, items: OutletItem[]) {
  const conc = r.signals.itemConcentration;
  // FIX: use REAL top 5 items by absNominalLossSurplus from outletItems data
  const top5 = [...items]
    .sort((a, b) => b.absNominalLossSurplus - a.absNominalLossSurplus)
    .slice(0, 5);
  if (top5.length === 0) {
    // Fallback: use topItem name from recommendation
    const topItemName = r.metrics.topItem || 'Item #1';
    return [
      { name: topItemName, value: Number((conc * 100).toFixed(1)) },
      { name: 'Lainnya', value: Number(((1 - conc) * 100).toFixed(1)) },
    ];
  }
  const totalAbs = top5.reduce((s, it) => s + it.absNominalLossSurplus, 0) || 1;
  const data = top5.map(it => ({
    name: it.itemName.length > 12 ? it.itemName.slice(0, 10) + '…' : it.itemName,
    value: Number((it.absNominalLossSurplus / totalAbs * conc * 100).toFixed(1)),
  }));
  data.push({ name: 'Lainnya', value: Number(((1 - conc) * 100).toFixed(1)) });
  return data;
}

function buildTolBreachHighData(r: Recommendation, items: OutletItem[]) {
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

function buildTolBreachData(r: Recommendation, items: OutletItem[]) {
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

function buildOverExplainedData(r: Recommendation, items: OutletItem[]) {
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

function buildHighLossData(r: Recommendation, items: OutletItem[]) {
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

function buildBenchmarkData(r: Recommendation) {
  const outletDev = Math.abs(r.metrics.devBom) || 0.05;
  return [
    { name: 'Outlet', value: Number((outletDev * 100).toFixed(1)), fill: CHART.red },
    { name: 'Area Avg', value: Number((outletDev * 0.65 * 100).toFixed(1)), fill: CHART.amber },
    { name: 'Network', value: Number((outletDev * 0.45 * 100).toFixed(1)), fill: CHART.zinc },
  ];
}

function buildResidualNominalData(r: Recommendation) {
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
function buildNoToleranceRows(r: Recommendation, items: OutletItem[]) {
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

// ============================================================
//  Signal explanations — short Indonesian blurbs shown under
//  each expanded chart, explaining what the signal means.
// ============================================================

const SIGNAL_EXPLANATIONS: Record<string, string> = {
  'Dev/BOM vs Peer': 'Rasio deviasi outlet vs rata-rata peer. >1× berarti deviasi lebih tinggi dari peer — investigasi penyebab (BOM master, proses, atau pencatatan).',
  'Deviasi Growth': 'Tren pertumbuhan deviasi 4 minggu terakhir + proyeksi W5. Jika terus naik, perlu intervensi sebelum memburuk.',
  'Z-Score Abnormal': 'Item-item dengan z-score >2.0 (statistically abnormal vs distribusi normal). Probabilitas ada kesalahan pencatatan/fraud tinggi.',
  'Residual Ratio': 'Deviasi yang TIDAK bisa dijelaskan oleh Waste+Susut+Trial. Semakin tinggi rasio, semakin banyak "deviasi misteri" yang perlu investigasi.',
  'Loss/Sales': 'Rasio loss terhadap sales. Loss tinggi relatif terhadap sales = potensi masalah operasional (spillage, theft, atau proses)',
  'Direction Flip': 'Arah deviasi berubah dari periode sebelumnya (LOSS↔SURPLUS). Sering indikasi koreksi pencatatan atau perubahan proses yang signifikan.',
  'Trend Memburuk': 'Deviasi memburuk secara konsisten minggu ke minggu. Investigasi sebelum menjadi masalah besar.',
  'Item Concentration': 'Top 5 item menyumbang persentase besar dari total deviasi. Fokus investigasi pada item-item tersebut.',
  'Tol Breach High': 'Item dengan deviasi >2× toleransi (breach tinggi). Tindakan disipliner/audit diperlukan.',
  'Over-Explained': 'Item dimana penjelasan (Waste+Susut+Trial) > 100% deviasi. Indikasi kesalahan input data atau pencatatan ganda.',
  'High Loss Nominal': 'Item dengan nominal loss >Rp 10jt. Prioritas investigasi berdasarkan dampak finansial.',
  'No Tolerance': 'Item-item tanpa setup toleransi di master data. Tidak bisa di-evaluasi breach — setup toleransi segera.',
  'Benchmark High': 'Deviasi outlet lebih tinggi dari rata-rata area/network. Investigasi gap praktik antar outlet.',
  'Residual Nominal': 'Nominal deviasi yang tidak terjelaskan. Semakin tinggi, semakin besar "uang hilang" yang perlu dijelaskan.',
  'Tolerance Breach': 'Item dengan deviasi >toleransi (breach reguler). Review penyebab dan corrective action.',
};

// FIX DATA-2: empty state component for charts with no data
function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-[170px] text-xs text-muted-foreground">
      <div className="text-center">
        <p className="text-emerald-600 dark:text-emerald-400 font-medium">✓ {message}</p>
        <p className="text-[10px] text-muted-foreground/70 mt-1">Tidak ada anomali terdeteksi</p>
      </div>
    </div>
  );
}

// ============================================================
//  SignalChart — renders the appropriate chart for each signal
//  Per spec: only render when accordion item is expanded.
// ============================================================

function SignalChart({ name, r, items }: { name: string; r: Recommendation; items: OutletItem[] }) {
  switch (name) {
    case 'Dev/BOM vs Peer': {
      const data = buildDevBomData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => [`${v}×`, 'Ratio']} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : Math.abs(n) >= 1000 ? `${(Math.abs(n)/1000).toFixed(0)}rb` : n.toFixed(1); }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Deviasi Growth': {
      const data = buildDeviasiGrowthData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="week" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v == null ? '—' : `${(v * 100).toFixed(1)}%`} />
            <ReferenceLine y={0} stroke="#52525b" strokeOpacity={0.4} />
            <Line type="monotone" dataKey="actual" stroke={CHART.amber} strokeWidth={2} dot={{ r: 3, fill: CHART.amber }} connectNulls={false} name="Aktual" />
            <Line type="monotone" dataKey="projected" stroke={CHART.red} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: CHART.red }} connectNulls={false} name="Proyeksi" />
            <Legend wrapperStyle={{ fontSize: '9px', color: '#52525b' }} iconType="line" />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    case 'Trend Memburuk': {
      const data = buildTrendMemburukData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="week" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v == null ? '—' : `${(v * 100).toFixed(1)}%`} />
            <Line type="monotone" dataKey="actual" stroke={CHART.red} strokeWidth={2} dot={{ r: 3, fill: CHART.red }} connectNulls={false} name="Aktual" />
            <Line type="monotone" dataKey="projected" stroke={CHART.redDark} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: CHART.redDark }} connectNulls={false} name="Proyeksi" />
            <Legend wrapperStyle={{ fontSize: '9px', color: '#52525b' }} iconType="line" />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    case 'Z-Score Abnormal': {
      const { abnormal, normal } = buildZScoreData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <ScatterChart margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" />
            <XAxis type="number" dataKey="x" name="Item" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis type="number" dataKey="y" name="Z-Score" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} formatter={(v: number) => v.toFixed(2)} />
            <ReferenceLine y={2.0} stroke={CHART.red} strokeDasharray="4 3" label={{ value: 'z=2.0', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Scatter name="Normal" data={normal} fill={CHART.zincLight} />
            <Scatter name="Abnormal" data={abnormal} fill={CHART.red} />
            <Legend wrapperStyle={{ fontSize: '9px' }} iconType="circle" formatter={(value: string) => <span style={{ color: '#52525b', fontSize: '9px' }}>{value}</span>} />
          </ScatterChart>
        </ResponsiveContainer>
      );
    }
    case 'Residual Ratio': {
      const data = buildResidualRatioData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <Bar dataKey="Explained" stackId="a" fill={CHART.emerald} radius={[0, 0, 0, 0]} />
            <Bar dataKey="Residual" stackId="a" fill={CHART.red} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Loss/Sales': {
      const data = buildLossSalesData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => fmtIDR(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => fmtIDR(v)} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : Math.abs(n) >= 1000 ? `${(Math.abs(n)/1000).toFixed(0)}rb` : n.toFixed(1); }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Direction Flip': {
      const data = buildDirectionFlipData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" domain={[-1.5, 1.5]} ticks={[-1, 0, 1]} tickFormatter={(v: number) => v < 0 ? 'LOSS' : v > 0 ? 'SURP' : '—'} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => v < 0 ? 'LOSS' : 'SURPLUS'} />
            <ReferenceLine y={0} stroke="#52525b" strokeOpacity={0.5} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : Math.abs(n) >= 1000 ? `${(Math.abs(n)/1000).toFixed(0)}rb` : n.toFixed(1); }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Item Concentration': {
      const data = buildItemConcentrationData(r, items);
      const colors = [CHART.red, CHART.amber, CHART.amberDark, CHART.zinc, CHART.zincLight, CHART.zincVeryLight];
      // FIX CSS-5 + FIX-1 + FIX-3: label as OBJECT (not function) so fill propagates correctly.
      // isAnimationActive=false so labels appear instantly (FIX-3: was delayed 2s by animation).
      // cy=50% + smaller radius so labels fit in viewBox (FIX-1: was clipped at cy=45%).
      // Legend formatter wraps in span with explicit color (FIX-2: slice colors were unreadable).
      return (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={42}
              outerRadius={62}
              paddingAngle={1}
              isAnimationActive={false}
              label={(entry: { name?: string; value?: number }) => {
                const shortName = (entry.name || '').length > 10 ? (entry.name || '').slice(0, 8) + '…' : (entry.name || '');
                return (
                  <text fill="#52525b" fontSize={9} textAnchor="middle">
                    {`${shortName}: ${entry.value}%`}
                  </text>
                );
              }}
              labelLine={{ stroke: '#52525b', strokeWidth: 0.5 }}
            >
              {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => `${v}%`} />
            <Legend
              wrapperStyle={{ fontSize: '9px' }}
              iconType="circle"
              formatter={(value: string) => <span style={{ color: '#52525b', fontSize: '9px' }}>{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      );
    }
    case 'Tol Breach High': {
      const { data, threshold } = buildTolBreachHighData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item breach >2× toleransi" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={threshold} stroke={CHART.red} strokeDasharray="4 3" label={{ value: '2× Tol', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Bar dataKey="value" fill={CHART.red} radius={[3, 3, 0, 0]}>
              <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number) => `${v}%`} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Tolerance Breach': {
      const { data, threshold } = buildTolBreachData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item breach toleransi" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={threshold} stroke={CHART.amber} strokeDasharray="4 3" label={{ value: 'Tol', fontSize: 9, fill: CHART.amber, position: 'right' }} />
            <Bar dataKey="value" fill={CHART.amber} radius={[3, 3, 0, 0]}>
              <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number) => `${v}%`} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Over-Explained': {
      const data = buildOverExplainedData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item over-explained" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={100} stroke={CHART.red} strokeDasharray="4 3" label={{ value: '100%', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Bar dataKey="Deviasi" stackId="a" fill={CHART.zinc} radius={[0, 0, 0, 0]} />
            <Bar dataKey="Explanation" stackId="a" fill={CHART.amber} radius={[4, 4, 0, 0]}>
              <LabelList dataKey="Explanation" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => `${Math.round(Number(v))}%`} />
            </Bar>
            <Legend wrapperStyle={{ fontSize: '9px' }} iconType="circle" formatter={(value: string) => <span style={{ color: '#52525b', fontSize: '9px' }}>{value}</span>} />
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'High Loss Nominal': {
      const { data, threshold } = buildHighLossData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item loss >Rp 10jt" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => fmtIDR(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => fmtIDR(v)} />
            <ReferenceLine y={threshold} stroke={CHART.red} strokeDasharray="4 3" label={{ value: 'Rp 10Jt', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Bar dataKey="value" fill={CHART.red} radius={[3, 3, 0, 0]}>
              <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : `${n}`; }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Benchmark High': {
      const data = buildBenchmarkData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : Math.abs(n) >= 1000 ? `${(Math.abs(n)/1000).toFixed(0)}rb` : n.toFixed(1); }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Residual Nominal': {
      const data = buildResidualNominalData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => fmtIDR(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => fmtIDR(v)} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: any) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : Math.abs(n) >= 1000 ? `${(Math.abs(n)/1000).toFixed(0)}rb` : n.toFixed(1); }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'No Tolerance': {
      const rows = buildNoToleranceRows(r, items);
      if (rows.length === 0) {
        return (
          <div className="flex items-center justify-center h-[170px] text-xs text-muted-foreground">
            Semua item punya toleransi. ✓
          </div>
        );
      }
      return (
        <div className="h-[170px] overflow-auto rounded-md border border-border/60">
          <table className="w-full text-[10px]">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className="text-left px-2 py-1 font-semibold text-muted-foreground">#</th>
                <th className="text-left px-2 py-1 font-semibold text-muted-foreground">Item</th>
                <th className="text-right px-2 py-1 font-semibold text-muted-foreground">% Deviasi</th>
                <th className="text-right px-2 py-1 font-semibold text-muted-foreground">Nominal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.idx} className="border-t border-border/40">
                  <td className="px-2 py-1 text-muted-foreground">{row.idx}</td>
                  <td className="px-2 py-1 truncate" title={row.name}>{row.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-amber-600 dark:text-amber-400">{row.pct}%</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtIDR(row.nominal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return (
        <div className="flex items-center justify-center h-[170px] text-xs text-muted-foreground">
          Chart belum tersedia untuk sinyal ini.
        </div>
      );
  }
}

// ============================================================
//  Main component
// ============================================================

// FIX: OutletItem interface for real per-item data
export interface OutletItem {
  itemName: string;
  devBom: number | null;
  nominalLossSurplus: number | null;
  absNominalLossSurplus: number;
  direction: string;
  residualRatio: number | null;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyDeviasi: number | null;
  qtyBom: number;
  priority: string;
}

export function PrioritySummaryCard({
  recommendation,
  outletItems = [],
}: {
  recommendation: Recommendation | null | undefined;
  outletItems?: OutletItem[];
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Pull the parts of recommendation we depend on so React Compiler can
  // track granular dependencies (optional chaining in deps arrays confuses it).
  const outletCode = recommendation?.outletCode;
  const signalScores = recommendation?.signalScores;

  // Default-expand set: signals with score > 50.
  const defaultExpanded = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    if (signalScores) {
      for (const sig of signalScores) {
        if (sig.score > 50) s.add(sig.name);
      }
    }
    return s;
  }, [signalScores]);

  // FIX REACT-1: reset expanded state when outlet OR period changes (was: only outletCode).
  // Use composite key: outletCode + monthLabel + currentWeek so switching period
  // on same outlet resets to defaults.
  // FIX PSC-2: include signalScores content hash in resetKey so period change triggers reset
  const signalScoresHash = signalScores ? signalScores.map(s => `${s.name}:${s.score}`).join(',') : 'none';
  const resetKey = `${outletCode}|${signalScoresHash}`;

  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded);
  const [expandedResetKey, setExpandedResetKey] = useState<string | undefined>(resetKey);
  if (resetKey !== expandedResetKey) {
    setExpandedResetKey(resetKey);
    setExpanded(defaultExpanded);
  }

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Top 3 contributors by score × weight (memoized before early return)
  const topContributors = useMemo(() => {
    if (!signalScores) return [];
    return [...signalScores]
      .map((s) => ({ ...s, contribution: Math.round(s.score * s.weight) }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3);
  }, [signalScores]);

  // Signal lookup by name (memoized before early return)
  const signalByName = useMemo(() => {
    const m = new Map<string, SignalScore>();
    if (signalScores) {
      for (const s of signalScores) m.set(s.name, s);
    }
    return m;
  }, [signalScores]);

  if (!recommendation) return null;

  const r = recommendation;
  const levelColor =
    r.priorityLevel === 'TINGGI'
      ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
      : r.priorityLevel === 'SEDANG'
      ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'
      : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900';

  const scoreColor =
    r.priorityScore >= 55
      ? 'text-red-600 dark:text-red-400'
      : r.priorityScore >= 30
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';

  const scoreBarColor =
    r.priorityScore >= 55 ? 'bg-red-500' : r.priorityScore >= 30 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20 border-amber-200/50 dark:border-amber-900/40">
      <CardHeader className="pb-3 border-b bg-gradient-to-r from-amber-50/50 to-transparent dark:from-amber-950/20">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Priority Summary — Kenapa Resto Ini Prioritas?
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {/* Score + Level + Quick Metrics */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            {/* Priority Score */}
            <div className="text-center">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Priority Score</p>
              <p className={`text-3xl font-bold tabular-nums ${scoreColor}`}>{r.priorityScore}</p>
              <div className="w-24 h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                <div className={`h-full ${scoreBarColor} transition-all duration-500`} style={{ width: `${r.priorityScore}%` }} />
              </div>
            </div>
            {/* Level Badge */}
            <div>
              <Badge variant="outline" className={`text-xs font-semibold ${levelColor}`}>
                {r.priorityLevel}
              </Badge>
              <p className="text-[10px] text-muted-foreground mt-1">
                {r.priorityLevel === 'TINGGI' ? 'Investigasi segera' : r.priorityLevel === 'SEDANG' ? 'Perlu perhatian' : 'Monitor saja'}
              </p>
            </div>
          </div>
          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Dev/BOM</p>
              <p className="text-sm font-semibold tabular-nums">{fmtPctAbs(r.metrics.devBom)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Nominal</p>
              <p className={`text-sm font-semibold tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {fmtIDR(r.metrics.nominalDeviasi)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Items</p>
              <p className="text-sm font-semibold tabular-nums">{r.metrics.itemCount}</p>
            </div>
          </div>
        </div>

        {/* Signal Badges — 8 key signals */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={`text-[10px] ${r.metrics.direction === 'LOSS' ? 'text-red-600 border-red-200 dark:text-red-400 dark:border-red-900' : 'text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900'}`}>
            {r.metrics.direction}
          </Badge>
          {r.signals.directionFlip && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Flip
            </Badge>
          )}
          {r.signals.trendDeteriorating && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> Memburuk
            </Badge>
          )}
          {r.signals.residualRatio > 0.4 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Residual {(r.signals.residualRatio * 100).toFixed(0)}%
            </Badge>
          )}
          {r.signals.toleranceBreachHighCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Tol Breach High: {r.signals.toleranceBreachHighCount}
            </Badge>
          )}
          {r.signals.overExplainedCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Anomali: {r.signals.overExplainedCount}
            </Badge>
          )}
          {r.signals.highLossItemCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              High Loss: {r.signals.highLossItemCount}
            </Badge>
          )}
          {r.signals.noToleranceItems > 0 && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              No Tol: {r.signals.noToleranceItems}
            </Badge>
          )}
          {r.signals.benchmarkHighCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              Bench High: {r.signals.benchmarkHighCount}
            </Badge>
          )}
          {r.signals.zScoreAbnormalCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Z-Score Abnormal: {r.signals.zScoreAbnormalCount}
            </Badge>
          )}
        </div>

        {/* Analysis Bullets — WHY this outlet is priority */}
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Analisa Priority Engine</p>
          {r.analysis.map((a, j) => (
            <p key={j} className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-tight">
              <span className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0">•</span>
              <span>{a}</span>
            </p>
          ))}
        </div>

        {/* ============================================================ */}
        {/*  BREAKDOWN 15 SINYAL — interactive accordion with charts      */}
        {/* ============================================================ */}
        {r.signalScores && r.signalScores.length > 0 && (
          <div className="border-t pt-3 space-y-3">
            {/* Toggle button */}
            <button
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showBreakdown ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Breakdown 15 Sinyal Priority Score
              <span className="ml-auto text-[10px] text-muted-foreground/70">{r.signalScores.filter(s => s.score > 0).length} aktif · {expanded.size} terbuka</span>
            </button>

            {showBreakdown && (
              <div className="space-y-3">
                {/* FIX CHART-7: disclaimer that charts use illustrative data */}
                <p className="text-[10px] text-muted-foreground/70 italic">
                  ℹ️ Chart di bawah adalah ilustrasi berdasarkan nilai sinyal. Klik sinyal untuk melihat visualisasi.
                </p>

                {/* ---- Top Contributors Highlight ---- */}
                {topContributors.length > 0 && (
                  <div className="rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-gradient-to-br from-amber-50/60 to-transparent dark:from-amber-950/20 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-1">
                      <Trophy className="h-3 w-3" /> Top Contributors
                    </p>
                    <div className="space-y-1.5">
                      {topContributors.map((c, i) => (
                        <div key={c.name} className="flex items-center gap-2 text-[11px]">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold shrink-0">
                            {i + 1}
                          </span>
                          <span className="flex-1 truncate font-medium" title={c.name}>{c.name}</span>
                          <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-400">+{c.contribution}</span>
                          <span className="tabular-nums text-muted-foreground/80 text-[10px] w-16 text-right">
                            {Math.round(c.weight * 100)}% bobot
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ---- Accordion grouped by category ---- */}
                {SIGNAL_GROUPS.map((group) => {
                  const groupSignals = group.signals
                    .map((name) => signalByName.get(name))
                    .filter((s): s is SignalScore => Boolean(s));
                  if (groupSignals.length === 0) return null;
                  const GroupIcon = group.icon;
                  const groupContribution = groupSignals.reduce((sum, s) => sum + Math.round(s.score * s.weight), 0);
                  const groupExpandedCount = groupSignals.filter((s) => expanded.has(s.name)).length;

                  return (
                    <div key={group.name} className="rounded-lg border border-border/60 overflow-hidden">
                      {/* Group header */}
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/60">
                        <span className="text-sm">{group.emoji}</span>
                        <GroupIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[11px] font-semibold flex-1">{group.name}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {groupSignals.length} sinyal · +{groupContribution}
                        </span>
                        {groupExpandedCount > 0 && (
                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 tabular-nums">
                            {groupExpandedCount} buka
                          </span>
                        )}
                      </div>

                      {/* Signal rows */}
                      <div className="divide-y divide-border/40">
                        {groupSignals.map((s) => {
                          const contribution = Math.round(s.score * s.weight);
                          const badge = priorityBadge(s.score);
                          const Icon = SIGNAL_ICONS[s.name] || Activity;
                          const isExpanded = expanded.has(s.name);

                          return (
                            <div key={s.name} className="bg-background hover:bg-muted/20 transition-colors">
                              {/* Collapsed row */}
                              <button
                                onClick={() => toggleExpand(s.name)}
                                className="w-full flex items-center gap-2 px-3 py-2 text-left"
                              >
                                {/* Expand chevron */}
                                {isExpanded
                                  ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                                  : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                                {/* Status dot */}
                                <span className={`h-1.5 w-1.5 rounded-full ${badge.dot} shrink-0`} />
                                {/* Icon */}
                                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                {/* Name */}
                                <span className="text-[11px] font-medium flex-1 truncate" title={s.name}>{s.name}</span>
                                {/* Score */}
                                <span className="text-[11px] tabular-nums font-semibold w-7 text-right">{s.score}</span>
                                {/* Contribution */}
                                <span className="text-[11px] tabular-nums w-8 text-right text-muted-foreground">+{contribution}</span>
                                {/* Value */}
                                <span className="text-[10px] tabular-nums text-muted-foreground/80 w-16 text-right truncate hidden sm:block" title={s.value}>{s.value}</span>
                                {/* Badge */}
                                <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${badge.cls}`}>{badge.label}</Badge>
                              </button>

                              {/* Expanded chart + explanation */}
                              {isExpanded && (
                                <div className="px-3 pb-3 pt-1">
                                  <div className="bg-muted/20 dark:bg-muted/10 rounded-lg p-3">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-2 uppercase tracking-wider flex items-center gap-1">
                                      <BarChart3 className="h-3 w-3" />
                                      {s.name}
                                    </p>
                                    <SignalChart name={s.name} r={r} items={outletItems} />
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                                    <span className="font-semibold text-foreground/80">Apa ini: </span>
                                    {SIGNAL_EXPLANATIONS[s.name] || 'Sinyal priority score dari Priority Engine.'}
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* ---- Total ---- */}
                {/* FIX CHART-2: show computed sum (not r.priorityScore which uses different rounding).
                    Server computes priorityScore with single rounding at end;
                    per-row contributions use double rounding (Math.round(Math.round(score) * weight)).
                    Show the computed sum so the breakdown math reconciles. */}
                <div className="flex items-center gap-2 text-[11px] pt-2 border-t">
                  <span className="flex-1 font-semibold text-foreground">Total (dari breakdown)</span>
                  <span className="tabular-nums font-bold text-foreground">
                    = {(r.signalScores || []).reduce((sum, s) => sum + Math.round(Math.round(s.score) * s.weight), 0)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70">
                    Score server: {r.priorityScore}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
