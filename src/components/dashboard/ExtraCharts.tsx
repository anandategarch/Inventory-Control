'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  PieChart as PieChartIcon, Radar as RadarIcon, GitCompare,
  BarChart3 as BarChartHorizontal, CakeSlice, Layers, Activity,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine,
  Area, ComposedChart, Line,
} from 'recharts';

// ============================================================
//  Shared tooltip payload type
//  NOTE: `any` is required — TSX parser breaks on typeof chartData[number]
// ============================================================
type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

// ============================================================
//  1. HealthDistributionDonut
//  Distribusi record Normal / Peringatan / Masalah (donut)
// ============================================================
export function HealthDistributionDonut({ data }: { data: AnalysisData }) {
  const { normal, warning, abnormal } = data.healthStatus;
  const total = normal + warning + abnormal;
  const chartData = [
    { name: 'Normal', value: normal, color: '#10b981' },
    { name: 'Peringatan', value: warning, color: '#f59e0b' },
    { name: 'Masalah', value: abnormal, color: '#dc2626' },
  ].filter((d) => d.value > 0);

  const healthScore = total > 0 ? Math.round((normal / total) * 100) : 100;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <PieChartIcon className="h-4 w-4 text-muted-foreground" />
          Distribusi Kondisi Record
          <FormulaInfo
            formula="Skor Kondisi = Normal / Total × 100"
            description={'UNTUK APA: Visualisasi proporsi record Normal/Peringatan/Masalah.\nCARA BACA: Irisan merah (Masalah) besar = banyak record bermasalah. Hijau dominan = kondisi sehat.\nCONTOH: 60% Normal, 25% Peringatan, 15% Masalah → skor 60.\nACTION: Masalah > 20% → intervensi sistemik.'}
            example="4638 Normal / 10000 Total = 46.4%"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Kondisi inventory periode ini</p>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <div className="relative h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs">
                          <p className="font-medium">{payload[0].payload.name}</p>
                          <p className="text-muted-foreground">
                            {payload[0].payload.value.toLocaleString()} record ({((payload[0].payload.value / total) * 100).toFixed(1)}%)
                          </p>
                        </div>
                      )
                      : null
                  }
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <p className="text-2xl font-bold">{healthScore}</p>
              <p className="text-[11px] text-muted-foreground">Skor Kondisi</p>
            </div>
          </div>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          {chartData.map((d) => (
            <div key={d.name} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
              <span className="text-muted-foreground">{d.name}</span>
              <span className="font-medium ml-auto">{d.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  2. DeviationCategoryDonut
//  Komposisi DEVIASI (Waste / Susut / Trial / Residual) sebagai donut
// ============================================================
export function DeviationCategoryDonut({ data }: { data: AnalysisData }) {
  const b = data.deviationBreakdown;
  const total = b.total || 1;
  const chartData = [
    { name: 'WASTE', value: b.waste, color: '#f59e0b' },
    { name: 'SUSUT', value: b.susut, color: '#8b5cf6' },
    { name: 'TRIAL', value: b.trial, color: '#06b6d4' },
    { name: 'RESIDUAL', value: b.residual, color: b.residual / total > 0.5 ? '#dc2626' : '#64748b' },
  ].filter((d) => d.value > 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <CakeSlice className="h-4 w-4 text-muted-foreground" />
          Komposisi DEVIASI (Donut)
          <FormulaInfo
            formula="QTY Deviasi = |Waste| + |Susut| + |Trial| + |Residual|"
            description={'UNTUK APA: Versi donut dari Rincian DEVIASI — memperlihatkan proporsi tiap kategori.\nCARA BACA: Irisan RESIDUAL dominan (> 50%) = mayoritas deviasi tidak terjelaskan WASTE/SUSUT/TRIAL.\nCONTOH: RESIDUAL 70% → banyak deviasi tak terklasifikasi.\nACTION: RESIDUAL dominan → audit pencatatan komponen.'}
            example="Waste 8K + Susut 6K + Trial 4K + Residual 42K = 60K total"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Komposisi QTY Deviasi (magnitude)</p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={75}
                  paddingAngle={2}
                  label={({ name, percent }: { name?: string; percent?: number }) =>
                    percent != null && percent > 0.05 ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                  }
                  labelLine={false}
                >
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs">
                          <p className="font-medium">{payload[0].payload.name}</p>
                          <p className="text-muted-foreground">
                            {payload[0].payload.value.toLocaleString()} ({((payload[0].payload.value / total) * 100).toFixed(1)}%)
                          </p>
                        </div>
                      )
                      : null
                  }
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          {chartData.map((d) => (
            <div key={d.name} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
              <span className="text-muted-foreground">{d.name}</span>
              <span className="font-medium ml-auto">{d.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  3. AreaContributionBar
//  Kontribusi |NOMINAL DEVIASI| per area (horizontal bar)
// ============================================================
export function AreaContributionBar({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  const areas = data.areaAnalysis || [];
  const totalAbsNominal = areas.reduce((s, a) => s + a.totalAbsNominal, 0) || 1;

  const chartData = areas.map((a) => ({
    area: a.area,
    absNominalJuta: a.totalAbsNominal / 1_000_000,
    pctContribution: (a.totalAbsNominal / totalAbsNominal) * 100,
    lossToSales: a.lossToSales,
    color: a.lossToSales != null && a.lossToSales > 0.10 ? '#dc2626'
      : a.lossToSales != null && a.lossToSales > 0.05 ? '#f59e0b'
      : '#10b981',
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <BarChartHorizontal className="h-4 w-4 text-muted-foreground" />
          Kontribusi Area terhadap DEVIASI
          <FormulaInfo
            formula="|NOMINAL DEVIASI| per Area / Σ semua Area"
            description={'UNTUK APA: Memperlihatkan area mana yang menyumbang terbesar terhadap total deviasi jaringan.\nCARA BACA: Bar lebih panjang = kontribusi deviasi lebih besar. Warna merah = LOSS/PENJUALAN > 10%.\nCONTOH: JAWA BARAT 25% dari total deviasi network.\nACTION: Fokus intervensi pada 3 area kontribusi terbesar.'}
            example="JAKBAR 80M / 200M total = 40% kontribusi"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">{areas.length} area · klik untuk filter</p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => `${v.toFixed(0)}M`} fontSize={11} />
                <YAxis type="category" dataKey="area" width={110} fontSize={10} />
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{payload[0].payload.area}</p>
                          <p className="text-muted-foreground">|NOMINAL DEVIASI|: {fmtIDR(payload[0].payload.absNominalJuta * 1_000_000)}</p>
                          <p className="text-muted-foreground">Kontribusi: {payload[0].payload.pctContribution.toFixed(1)}%</p>
                          <p className="text-muted-foreground">LOSS/PENJUALAN: {fmtPct(payload[0].payload.lossToSales, false)}</p>
                        </div>
                      )
                      : null
                  }
                />
                <Bar dataKey="absNominalJuta" radius={[0, 4, 4, 0]} cursor="pointer" onClick={(d: any) => d?.area && setArea(d.area)}>
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  4. TopItemsHorizontalBar
//  Top 10 item by |NOMINAL DEVIASI| (horizontal bar, clickable)
// ============================================================
export function TopItemsHorizontalBar({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);
  const items = (data.topItemsByNominal || []).slice(0, 10);
  const chartData = items.map((it: any) => ({
    label: `${it.itemName?.slice(0, 24)}${it.itemName?.length > 24 ? '…' : ''}`,
    itemName: it.itemName,
    outletCode: it.outletCode,
    absNominalJuta: (it.absNominal || 0) / 1_000_000,
    direction: it.direction,
    color: it.direction === 'LOSS' ? '#dc2626' : it.direction === 'SURPLUS' ? '#10b981' : '#94a3b8',
  }));

  const onClick = (d: any) => {
    if (!d?.itemName) return;
    setDrilldown({ outletCode: d.outletCode, itemName: d.itemName });
    setDeepDiveItem({ itemName: d.itemName, outletCode: d.outletCode });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <BarChartHorizontal className="h-4 w-4 text-muted-foreground" />
          Top 10 Item by |NOMINAL DEVIASI|
          <FormulaInfo
            formula="Rank by |NOMINAL DEVIASI| (Rp Juta) descending"
            description={'UNTUK APA: Visualisasi bar horizontal 10 item dengan deviasi nominal terbesar.\nCARA BACA: Bar merah = LOSS (aktual > standar). Bar hijau = SURPLUS. Panjang bar = magnitude.\nCONTOH: AYAM (LOSS Rp 8Jt) > MINYAK (LOSS Rp 5Jt).\nACTION: Fokus investigasi pada top 3 — dampak biaya terbesar.'}
            example="Item A: |NOMINAL DEVIASI| = Rp 182M (LOSS)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Klik bar untuk drill-down</p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => `${v.toFixed(0)}M`} fontSize={11} />
                <YAxis type="category" dataKey="label" width={140} fontSize={10} />
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{payload[0].payload.itemName}</p>
                          <p className="text-muted-foreground">Outlet: {payload[0].payload.outletCode}</p>
                          <p className="text-muted-foreground">|NOMINAL DEVIASI|: {fmtIDR(payload[0].payload.absNominalJuta * 1_000_000)}</p>
                          <p className="text-muted-foreground">Direction: {payload[0].payload.direction}</p>
                        </div>
                      )
                      : null
                  }
                />
                <Bar dataKey="absNominalJuta" radius={[0, 4, 4, 0]} cursor="pointer" onClick={onClick}>
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  5. VarianceDivergingBar
//  Top items: Memburuk (delta+) vs Membaik (delta-) — diverging bar
// ============================================================
export function VarianceDivergingBar({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);
  const variance = data.varianceAnalysis || { topWorsened: [], topImproved: [] };
  const worsened = (variance.topWorsened || []).slice(0, 5);
  const improved = (variance.topImproved || []).slice(0, 5);

  const chartData = [
    ...improved.map((it: any) => ({
      label: `${it.itemName?.slice(0, 24)}${it.itemName?.length > 24 ? '…' : ''}`,
      itemName: it.itemName,
      outletCode: it.outletCode,
      deltaJuta: -((it.delta || 0) / 1_000_000),
      deltaRaw: it.delta,
      direction: it.direction,
      kind: 'improved',
      color: '#10b981',
    })),
    ...worsened.map((it: any) => ({
      label: `${it.itemName?.slice(0, 24)}${it.itemName?.length > 24 ? '…' : ''}`,
      itemName: it.itemName,
      outletCode: it.outletCode,
      deltaJuta: (it.delta || 0) / 1_000_000,
      deltaRaw: it.delta,
      direction: it.direction,
      kind: 'worsened',
      color: '#dc2626',
    })),
  ];

  const onClick = (d: any) => {
    if (!d?.itemName) return;
    setDrilldown({ outletCode: d.outletCode, itemName: d.itemName });
    setDeepDiveItem({ itemName: d.itemName, outletCode: d.outletCode });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-1.5">
              <GitCompare className="h-4 w-4 text-muted-foreground" />
              Diverging: Memburuk vs Membaik
              <FormulaInfo
                formula="Δ = |NOMINAL DEVIASI| current − |NOMINAL DEVIASI| previous"
                description={'UNTUK APA: Visualisasi diverging — item membaik di kiri (hijau), item memburuk di kanan (merah).\nCARA BACA: Bar hijau memanjang ke kiri = deviasi turun (membaik). Bar merah memanjang ke kanan = deviasi naik (memburuk).\nCONTOH: ITEM A +Rp 20Jt (memburuk) vs ITEM B -Rp 15Jt (membaik).\nACTION: Investigasi item memburuk (kanan) — penyebab kenaikan deviasi.'}
                example="Current 80M − Previous 50M = +30M (Memburuk)"
                side="bottom"
              />
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Top 5 per sisi</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs text-emerald-700 border-emerald-300">
              Membaik: {improved.length}
            </Badge>
            <Badge variant="outline" className="text-xs text-red-700 border-red-300">
              Memburuk: {worsened.length}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Tidak ada perubahan signifikan
          </p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => `${v.toFixed(0)}M`} fontSize={11} />
                <YAxis type="category" dataKey="label" width={140} fontSize={10} />
                <ReferenceLine x={0} stroke="#94a3b8" />
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{payload[0].payload.itemName}</p>
                          <p className="text-muted-foreground">Outlet: {payload[0].payload.outletCode}</p>
                          <p className="text-muted-foreground">Δ |NOMINAL DEVIASI|: {fmtIDR(payload[0].payload.deltaRaw)}</p>
                          <p className="text-muted-foreground">
                            Status: {payload[0].payload.kind === 'worsened' ? 'Memburuk' : 'Membaik'}
                          </p>
                        </div>
                      )
                      : null
                  }
                />
                <Bar dataKey="deltaJuta" radius={[0, 4, 4, 0]} cursor="pointer" onClick={onClick}>
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  6. OutletRadarChart
//  Radar: Top 3 outlet terburuk (5 metrics, normalized 0-100)
// ============================================================
export function OutletRadarChart({ data }: { data: AnalysisData }) {
  const setScorecardOutlet = useDashboard((s) => s.setScorecardOutlet);
  const ranking = (data.outletHealthRanking || []).slice(0, 3);
  const COLORS = ['#dc2626', '#f59e0b', '#8b5cf6'];

  if (ranking.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <RadarIcon className="h-4 w-4 text-muted-foreground" />
            Radar: Top 3 Outlet Terburuk
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        </CardContent>
      </Card>
    );
  }

  // Find max for each metric (for normalization to 0-100, 100 = worst)
  const maxDevBom = Math.max(...ranking.map((o) => Math.abs(o.devBom || 0)), 0.01);
  const maxResidual = Math.max(...ranking.map((o) => Math.abs(o.residualPct || 0)), 0.01);
  const maxLossToSales = Math.max(...ranking.map((o) => Math.abs(o.lossToSales || 0)), 0.01);
  const maxAbnormal = Math.max(...ranking.map((o) => o.abnormal || 0), 1);
  const maxNominal = Math.max(...ranking.map((o) => Math.abs(o.absNominal || 0)), 1);

  const metrics = [
    { metric: '% DEV TO BOM' },
    { metric: 'RESIDUAL %' },
    { metric: 'LOSS/PENJUALAN' },
    { metric: 'Jumlah Masalah' },
    { metric: '|NOMINAL DEVIASI|' },
  ];

  const normalize = (o: any, metric: string) => {
    switch (metric) {
      case '% DEV TO BOM': return (Math.abs(o.devBom || 0) / maxDevBom) * 100;
      case 'RESIDUAL %': return (Math.abs(o.residualPct || 0) / maxResidual) * 100;
      case 'LOSS/PENJUALAN': return (Math.abs(o.lossToSales || 0) / maxLossToSales) * 100;
      case 'Jumlah Masalah': return ((o.abnormal || 0) / maxAbnormal) * 100;
      case '|NOMINAL DEVIASI|': return (Math.abs(o.absNominal || 0) / maxNominal) * 100;
      default: return 0;
    }
  };

  const chartData = metrics.map((m) => {
    const row: Record<string, any> = { metric: m.metric };
    ranking.forEach((o, i) => {
      row[`outlet${i}`] = normalize(o, m.metric);
    });
    return row;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <RadarIcon className="h-4 w-4 text-muted-foreground" />
          Radar: Top 3 Outlet Terburuk
          <FormulaInfo
            formula="Tiap metric dinormalisasi 0-100 (100 = terburuk di antara top 3)"
            description={'UNTUK APA: Membandingkan profil multi-dimensi 3 outlet terburuk dalam satu radar.\nCARA BACA: Pola radar luas = outlet bermasalah di banyak dimensi. Bentuk mirip antar outlet = akar masalah serupa.\nCONTOH: Outlet A besar di LOSS/PENJUALAN, Outlet B besar di Jumlah Masalah → prioritas berbeda.\nACTION: Bentuk radar mirip → intervensi sistemik. Berbeda → intervensi spesifik per outlet.'}
            example="Outlet A: devBom 18% / max 20% = 90 (skala 100)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Klik legend untuk fokus outlet</p>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={chartData} outerRadius={100}>
              <PolarGrid />
              <PolarAngleAxis dataKey="metric" fontSize={10} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              {ranking.map((o, i) => (
                <Radar
                  key={o.outletCode}
                  name={`${o.outletName} (${o.outletCode})`}
                  dataKey={`outlet${i}`}
                  stroke={COLORS[i % COLORS.length]}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.18}
                />
              ))}
              <Tooltip
                content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                  active && payload && payload.length
                    ? (
                      <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                        <p className="font-medium">{label}</p>
                        {payload.map((p, i) => (
                          <p key={i} className="text-muted-foreground">
                            <span className="inline-block h-2 w-2 rounded-sm mr-1" style={{ background: COLORS[i % COLORS.length] }} />
                            {p.payload ? Object.keys(p.payload).find((k) => k.startsWith('outlet') && p.payload[k] === p.value) : ''}: {(p.value as number).toFixed(0)}
                          </p>
                        ))}
                      </div>
                    )
                    : null
                }
              />
              <Legend
                content={() => (
                  <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
                    {ranking.map((o, i) => (
                      <button
                        key={o.outletCode}
                        type="button"
                        onClick={() => setScorecardOutlet(o.outletCode)}
                        className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md border hover:bg-muted/50 transition-colors"
                      >
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="font-medium">{o.outletName}</span>
                        <span className="text-muted-foreground">({o.outletCode})</span>
                      </button>
                    ))}
                  </div>
                )}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  7. DirectionDistributionPie
//  Distribusi Arah (LOSS vs SURPLUS) berdasarkan QTY
// ============================================================
export function DirectionDistributionPie({ data }: { data: AnalysisData }) {
  const l = data.lossVsSurplus;
  const total = l.loss + l.surplus;
  const chartData = [
    { name: 'LOSS', value: l.loss, color: '#dc2626' },
    { name: 'SURPLUS', value: l.surplus, color: '#10b981' },
  ].filter((d) => d.value > 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <CakeSlice className="h-4 w-4 text-muted-foreground" />
          Distribusi Arah (QTY)
          <FormulaInfo
            formula="LOSS: QTY Deviasi > 0  |  SURPLUS: QTY Deviasi < 0"
            description={'UNTUK APA: Proporsi jumlah record LOSS vs SURPLUS (bukan magnitude).\nCARA BACA: Irisan merah dominan = mayoritas item loss (aktual > standar). Bisa juga LOSS mayoritas tapi SURPLUS magnitude besar.\nCONTOH: 70% LOSS, 30% SURPLUS → dominasi pemakaian berlebih.\nACTION: Jika SURPLUS > 40% → cek under-portioning atau kesalahan pencatatan standar.'}
            example="LOSS 5500 / SURPLUS 3200 = 63% LOSS"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Komposisi arah deviation (QTY count)</p>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={75}
                  label={({ name, percent }: { name?: string; percent?: number }) =>
                    name && percent != null ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                  }
                  labelLine={false}
                >
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs">
                          <p className="font-medium">{payload[0].payload.name}</p>
                          <p className="text-muted-foreground">
                            {payload[0].payload.value.toLocaleString()} ({((payload[0].payload.value / total) * 100).toFixed(1)}%)
                          </p>
                        </div>
                      )
                      : null
                  }
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          {chartData.map((d) => (
            <div key={d.name} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
              <span className="text-muted-foreground">{d.name}</span>
              <span className="font-medium ml-auto">{d.value.toLocaleString()}</span>
              <span className="text-muted-foreground">({total > 0 ? ((d.value / total) * 100).toFixed(1) : '0'}%)</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  8. CumulativeDeviationArea
//  Deviasi Kumulatif — Area chart + % DEV TO BOM line (ComposedChart)
// ============================================================
export function CumulativeDeviationArea({ data }: { data: AnalysisData }) {
  const trend = data.trend || [];
  // Purely functional: precompute abs values, then cumulative via slice+reduce
  const absValues = trend.map((t) => Math.abs(t.nominal || 0));
  const chartData = trend.map((t, i) => ({
    weekLabel: t.weekLabel,
    nominal: absValues[i] / 1_000_000,
    cumulative: absValues.slice(0, i + 1).reduce((sum, v) => sum + v, 0) / 1_000_000,
    devBom: (t.devBom || 0) * 100,
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-muted-foreground" />
          Deviasi Kumulatif
          <FormulaInfo
            formula="Kumulatif(t) = Σ |NOMINAL DEVIASI|(0..t)  |  % DEV TO BOM = avg |pctDevToBom| × 100"
            description={'UNTUK APA: Melihat akumulasi deviasi dari waktu ke waktu — seberapa cepat bocor menumpuk.\nCARA BACA: Area biru = deviasi kumulatif (Jt). Garis kuning = % DEV TO BOM mingguan. Kemiringan curam = deviasi bertambah cepat.\nCONTOH: Akhir bulan kumulatif Rp 500Jt → rata-rata Rp 125Jt/minggu.\nACTION: Kemiringan naik tajam → evaluasi periode tersebut.'}
            example="W1 30M + W2 25M + W3 40M = 95M kumulatif di W3"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Akumulasi deviation &amp; Dev/BOM per minggu</p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data tren</p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumDev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="weekLabel" fontSize={11} />
                <YAxis yAxisId="left" tickFormatter={(v) => `${v.toFixed(0)}M`} fontSize={11} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v.toFixed(0)}%`} fontSize={11} />
                <Tooltip
                  content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                    active && payload && payload.length
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{label}</p>
                          {payload.map((p, i) => (
                            <p key={i} className="text-muted-foreground">
                              {p.payload ? (p.payload as any).name || '' : ''} {p.payload ? '' : ''}
                              {p.name === 'Kumulatif' ? 'Kumulatif: ' : p.name === 'Dev/BOM' ? 'Dev/BOM: ' : 'Mingguan: '}
                              {p.name === 'Dev/BOM' ? `${(p.value as number).toFixed(2)}%` : `Rp ${(p.value as number).toFixed(2)}M`}
                            </p>
                          ))}
                        </div>
                      )
                      : null
                  }
                />
                <Legend />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="cumulative"
                  name="Kumulatif"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  fill="url(#cumDev)"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="devBom"
                  name="Dev/BOM"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  9. AreaLossSalesComparison
//  LOSS/PENJUALAN per area — vertical bar with angled labels
// ============================================================
export function AreaLossSalesComparison({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  const areas = data.areaAnalysis || [];
  const chartData = areas.map((a) => ({
    area: a.area,
    lossToSalesPct: (a.lossToSales || 0) * 100,
    color: a.lossToSales != null && a.lossToSales > 0.10 ? '#dc2626'
      : a.lossToSales != null && a.lossToSales > 0.05 ? '#f59e0b'
      : '#10b981',
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-muted-foreground" />
          LOSS/PENJUALAN per Area
          <FormulaInfo
            formula="LOSS/PENJUALAN = Σ Nominal LOSS area / Σ Sales area × 100%"
            description={'UNTUK APA: Bar chart membandingkan rasio LOSS/PENJUALAN antar area dengan threshold 5% & 10%.\nCARA BACA: Bar merah = > 10% (kritis). Bar kuning = 5-10% (peringatan). Bar hijau = < 5% (sehat).\nCONTOH: JAWA BARAT 12% (merah), JAKARTA 4% (hijau).\nACTION: Area > 10% → audit operasional segera.'}
            example="LOSS 8M / Sales 100M = 8% (warning)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Rasio loss-to-sales (%) per area</p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 50 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="area"
                  fontSize={10}
                  angle={-35}
                  textAnchor="end"
                  interval={0}
                  height={80}
                />
                <YAxis tickFormatter={(v) => `${v.toFixed(0)}%`} fontSize={11} />
                <Tooltip
                  content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                    active && payload && payload[0]
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{payload[0].payload.area}</p>
                          <p className="text-muted-foreground">LOSS/PENJUALAN: {payload[0].payload.lossToSalesPct.toFixed(2)}%</p>
                        </div>
                      )
                      : null
                  }
                />
                <Bar dataKey="lossToSalesPct" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(d: any) => d?.area && setArea(d.area)}>
                  {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
