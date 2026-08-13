'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  Coins, TrendingDown, Grid3x3, Calculator, Activity,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ResponsiveContainer, Cell,
  ScatterChart, Scatter, ZAxis, ReferenceLine, ComposedChart, Line,
} from 'recharts';

type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

// ============================================================
//  6.1 CostImpactDecomposition
//  Dampak biaya per kategori deviation
// ============================================================
export function CostImpactDecomposition({ data }: { data: AnalysisData }) {
  const b = data.deviationBreakdown;
  const cost = data.costImpact || { totalCost: 0, pctOfSales: null, lossNominal: 0, surplusNominal: 0 };
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
          <Coins className="h-4 w-4 text-amber-600" />
          Dampak Biaya per Kategori
          <FormulaInfo
            formula="Total = WASTE + SUSUT + TRIAL + RESIDUAL"
            description={'UNTUK APA: Mendekomposisi total dampak biaya deviasi ke dalam kategori penyebab.\nCARA BACA: Setiap kategori ditampilkan sebagai % dari total dan % dari PENJUALAN. RESIDUAL dominan = banyak deviasi tidak terjelaskan.\nCONTOH: WASTE Rp 2M (20%), SUSUT Rp 1M (10%), RESIDUAL Rp 7M (70%).\nACTION: WASTE tinggi → evaluasi proses produksi. RESIDUAL tinggi → audit pencatatan komponen.'}
            example="Waste 8K + Susut 6K + Trial 4K + Residual 42K = 60K total"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Total: {fmtIDR(cost.totalCost)} · {fmtPct(cost.pctOfSales, false)} dari PENJUALAN
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)} fontSize={11} />
                  <Tooltip
                    content={({ active, payload }: { active?: boolean; payload?: TipPayload }) =>
                      active && payload && payload[0]
                        ? (
                          <div className="rounded-md border bg-background p-2 shadow-md text-xs">
                            <p className="font-medium">{payload[0].payload.name}</p>
                            <p className="text-muted-foreground">{payload[0].payload.value.toLocaleString()} ({((payload[0].payload.value / total) * 100).toFixed(1)}%)</p>
                          </div>
                        )
                        : null
                    }
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              {chartData.map((d) => (
                <div key={d.name} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
                  <span className="text-muted-foreground">{d.name}:</span>
                  <span className="font-medium">{d.value.toLocaleString()}</span>
                  <span className="text-muted-foreground">({((d.value / total) * 100).toFixed(1)}%)</span>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-2 border-t grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Total LOSS:</span>{' '}
                <span className="font-semibold text-red-600">{fmtIDR(cost.lossNominal)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Total SURPLUS:</span>{' '}
                <span className="font-semibold text-emerald-600">{fmtIDR(cost.surplusNominal)}</span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  6.2 ParetoAnalysis
//  ABC classification berdasarkan cumulative cost
// ============================================================
function classBadge(cls: 'A' | 'B' | 'C'): string {
  switch (cls) {
    case 'A': return 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/60 dark:border-red-800 dark:text-red-400';
    case 'B': return 'text-amber-700 bg-amber-100 border-amber-300 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-400';
    case 'C': return 'text-sky-700 bg-sky-100 border-sky-300 dark:bg-sky-950/60 dark:border-sky-800 dark:text-sky-400';
  }
}

function classifyByCumPct(cumPct: number): 'A' | 'B' | 'C' {
  if (cumPct <= 70) return 'A';
  if (cumPct <= 90) return 'B';
  return 'C';
}

export function ParetoAnalysis({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);
  const pareto = data.pareto;

  if (!pareto) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-1.5">
            <TrendingDown className="h-4 w-4 text-red-600" />
            Analisis Pareto (ABC) — per Item+Outlet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        </CardContent>
      </Card>
    );
  }

  const items = (pareto.items || []).slice(0, 30);
  const classBCount = items.filter((it) => classifyByCumPct(it.cumPct) === 'B').length;
  const classCCount = items.filter((it) => classifyByCumPct(it.cumPct) === 'C').length;

  const onClick = (it: any) => {
    setDrilldown({ outletCode: it.outletCode, itemName: it.itemName });
    setDeepDiveItem({ itemName: it.itemName, outletCode: it.outletCode });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <TrendingDown className="h-4 w-4 text-red-600" />
          Analisis Pareto (ABC) — per Item+Outlet
          <FormulaInfo
            formula="Class A: cumulative ≤ 70% | Class B: 70-90% | Class C: > 90%"
            description={'UNTUK APA: Mengidentifikasi vital few items yang menyumbang sebagian besar dampak biaya (prinsip 80/20).\nCARA BACA: Class A = 70% pertama cumulative biaya. Class B = 70-90%. Class C = > 90%.\nCONTOH: 15 item Class A (20% items) = 70% total biaya.\nACTION: Fokus investigasi pada Class A dulu → dampak terbesar dengan effort terkecil.'}
            example="20 item Class A menghasilkan 70% total |NOMINAL DEVIASI|"
            side="bottom"
          />
        </CardTitle>
        <div className="flex items-center gap-1.5 flex-wrap mt-1">
          <Badge variant="outline" className={`text-[11px] ${classBadge('A')}`}>A: {pareto.classACount} ({(pareto.classAPctOfCost * 100).toFixed(1)}%)</Badge>
          <Badge variant="outline" className={`text-[11px] ${classBadge('B')}`}>B: {classBCount}</Badge>
          <Badge variant="outline" className={`text-[11px] ${classBadge('C')}`}>C: {classCCount}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-64">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[11px] h-7 px-2 w-8">#</TableHead>
                <TableHead className="text-[11px] h-7 px-2">Kelas</TableHead>
                <TableHead className="text-[11px] h-7 px-2">NAMA BAHAN</TableHead>
                <TableHead className="text-[11px] h-7 px-2">RESTO</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Biaya</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Cum %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">Tidak ada data</TableCell></TableRow>
              ) : items.map((it, i) => {
                const cls = classifyByCumPct(it.cumPct);
                return (
                  <TableRow
                    key={`${it.itemName}-${it.outletCode}-${i}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => onClick(it)}
                  >
                    <TableCell className="text-[11px] text-muted-foreground px-2 py-1">{i + 1}</TableCell>
                    <TableCell className="px-2 py-1">
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${classBadge(cls)}`}>{cls}</Badge>
                    </TableCell>
                    <TableCell className="text-[11px] px-2 py-1 font-medium whitespace-normal max-w-[180px]" title={it.itemName}>{it.itemName}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-muted-foreground">{it.outletCode}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(it.absNominal)}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right text-muted-foreground">{it.cumPct.toFixed(1)}%</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  6.3 OutletEfficiencyMatrix
//  Scatter plot: Sales (X) vs Loss/Sales (Y), bubble = absNominal
// ============================================================
function quadrantOf(salesJt: number, lossPct: number): { label: string; color: string } {
  // X threshold = 500 Jt, Y threshold = 5%
  if (salesJt >= 500 && lossPct < 5) return { label: 'STAR', color: '#10b981' };
  if (salesJt >= 500 && lossPct >= 5) return { label: 'ATTENTION', color: '#f59e0b' };
  if (salesJt < 500 && lossPct < 5) return { label: 'STABLE', color: '#64748b' };
  return { label: 'PROBLEM', color: '#dc2626' };
}

export function OutletEfficiencyMatrix({ data }: { data: AnalysisData }) {
  const setFocusOutlet = useDashboard((s) => s.setFocusOutlet);
  const ranking = data.outletHealthRanking || [];

  const chartData = ranking.map((o) => ({
    outletCode: o.outletCode,
    outletName: o.outletName,
    sales: (o.sales || 0) / 1_000_000, // Juta
    lossToSales: (o.lossToSales || 0) * 100, // %
    absNominal: (o.absNominal || 0) / 1_000_000, // Juta
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Grid3x3 className="h-4 w-4 text-indigo-600" />
          Matriks Efisiensi Outlet
          <FormulaInfo
            formula="X = PENJUALAN (Jt) | Y = LOSS/PENJUALAN (%)"
            description={'UNTUK APA: Memetakan posisi setiap outlet dalam matriks PENJUALAN vs efisiensi.\nCARA BACA: Bintang = belajar best practice. Masalah = prioritaskan intervensi. Perhatian = PENJUALAN besar tapi boros.\nCONTOH: Outlet PENJUALAN Rp 800Jt & LOSS/PENJUALAN 3% = Bintang.\nACTION: Pairing outlet Masalah dengan Bintang se-area untuk knowledge transfer.'}
            example="Outlet A: Sales 800Jt, LOSS/PENJUALAN 3% → STAR (emerald)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'BENCHMARK_AREA_FACTOR', label: 'Faktor Benchmark Area', dataType: 'number', min: 1, max: 5, step: 0.5 },
              { key: 'BENCHMARK_NETWORK_FACTOR', label: 'Faktor Benchmark Network', dataType: 'number', min: 1, max: 5, step: 0.5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Klik bubble untuk buka scorecard · Ukuran bubble = total biaya
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data</p>
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ left: 0, right: 20, top: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="sales"
                    name="PENJUALAN"
                    unit="Jt"
                    tickFormatter={(v) => `${v.toFixed(0)}`}
                    fontSize={11}
                  />
                  <YAxis
                    type="number"
                    dataKey="lossToSales"
                    name="LOSS/PENJUALAN"
                    unit="%"
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                    fontSize={11}
                  />
                  <ZAxis type="number" dataKey="absNominal" range={[40, 400]} name="|NOMINAL|" unit="Jt" />
                  <ReferenceLine y={5} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: '5%', fontSize: 10, fill: '#f59e0b' }} />
                  <ReferenceLine x={500} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: '500Jt', fontSize: 10, fill: '#94a3b8', position: 'top' }} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    content={({ active, payload }: { active?: boolean; payload?: TipPayload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const p = payload[0].payload;
                      const q = quadrantOf(p.sales, p.lossToSales);
                      return (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{p.outletName}</p>
                          <p className="text-muted-foreground">Outlet: {p.outletCode}</p>
                          <p className="text-muted-foreground">PENJUALAN: {fmtIDR(p.sales * 1_000_000)}</p>
                          <p className="text-muted-foreground">LOSS/PENJUALAN: {p.lossToSales.toFixed(2)}%</p>
                          <p className="text-muted-foreground">|NOMINAL|: {fmtIDR(p.absNominal * 1_000_000)}</p>
                          <p className="font-semibold" style={{ color: q.color }}>Kuadran: {q.label}</p>
                        </div>
                      );
                    }}
                  />
                  <Scatter
                    data={chartData}
                    cursor="pointer"
                    onClick={(d: any) => d?.outletCode && setFocusOutlet(d.outletCode)}
                  >
                    {chartData.map((d, i) => {
                      const q = quadrantOf(d.sales, d.lossToSales);
                      return <Cell key={i} fill={q.color} fillOpacity={0.65} stroke={q.color} />;
                    })}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5 text-[11px]">
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#10b981' }} /><span className="text-muted-foreground">STAR</span></div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#64748b' }} /><span className="text-muted-foreground">STABLE</span></div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#f59e0b' }} /><span className="text-muted-foreground">ATTENTION</span></div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#dc2626' }} /><span className="text-muted-foreground">PROBLEM</span></div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  6.4 CostPerThousandCard
//  Biaya per Rp 1.000 Penjualan
// ============================================================
function costPerThousandColor(v: number): string {
  if (v > 100) return 'text-red-600';
  if (v > 50) return 'text-amber-600';
  return 'text-emerald-600';
}

export function CostPerThousandCard({ data }: { data: AnalysisData }) {
  const setFocusOutlet = useDashboard((s) => s.setFocusOutlet);
  const ranking = data.outletHealthRanking || [];
  const cost = data.costImpact;
  const sales = data.executiveSummary?.sales?.current ?? 0;
  const totalCost = cost?.totalCost ?? 0;
  const costPerThousand = sales > 0 ? (totalCost / sales) * 1000 : 0;

  // Per outlet
  const byOutlet = ranking
    .filter((o) => o.sales > 0)
    .map((o) => ({
      outletCode: o.outletCode,
      outletName: o.outletName,
      area: o.area,
      sales: o.sales,
      costPerThousand: ((o.absNominal || 0) / o.sales) * 1000,
    }))
    .sort((a, b) => b.costPerThousand - a.costPerThousand);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Calculator className="h-4 w-4 text-emerald-600" />
          Biaya per Rp 1.000 Penjualan
          <FormulaInfo
            formula="Biaya per Rp 1000 = |NOMINAL DEVIASI| / PENJUALAN × 1000"
            description={'UNTUK APA: Metrik sederhana untuk benchmark antar outlet — setiap Rp 1.000 PENJUALAN, berapa rupiah yang bocor?\nCARA BACA: Angka tinggi = boros. > Rp 100 = kritis. < Rp 50 = sehat.\nCONTOH: PENJUALAN Rp 100Jt, DEVIASI Rp 5Jt → Rp 50 per Rp 1.000 (5%).\nACTION: Outlet > Rp 100 → audit operasional segera.'}
            example="Deviasi 5M / Sales 100M × 1000 = Rp 50 per Rp 1.000 (warning)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Rata-rata: <span className={`font-bold ${costPerThousandColor(costPerThousand)}`}>Rp {costPerThousand.toFixed(2)}</span> per Rp 1.000 sales
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-48">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[11px] h-7 px-2">Outlet</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">Biaya/Rb</TableHead>
                <TableHead className="text-[11px] h-7 px-2 text-right">PENJUALAN</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byOutlet.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center text-xs text-muted-foreground py-6">Tidak ada data</TableCell></TableRow>
              ) : byOutlet.map((o) => (
                <TableRow
                  key={o.outletCode}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setFocusOutlet(o.outletCode)}
                >
                  <TableCell className="text-[11px] px-2 py-1">
                    <div className="font-medium whitespace-normal max-w-[180px]" title={o.outletName}>{o.outletName}</div>
                    <div className="text-[11px] text-muted-foreground">{o.outletCode} · {o.area}</div>
                  </TableCell>
                  <TableCell className={`text-[11px] px-2 py-1 text-right font-bold ${costPerThousandColor(o.costPerThousand)}`}>
                    Rp {o.costPerThousand.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right">{fmtIDR(o.sales)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ============================================================
//  6.5 NetCostTrendChart
//  Tren biaya bersih (LOSS - SURPLUS) per minggu
// ============================================================
export function NetCostTrendChart({ data }: { data: AnalysisData }) {
  const trend = data.netCostTrend || [];

  const chartData = trend.map((t) => ({
    weekLabel: t.weekLabel,
    lossJuta: (t.lossNominal || 0) / 1_000_000,
    surplusJuta: (t.surplusNominal || 0) / 1_000_000,
    netCostRatio: (t.netCostRatio || 0) * 100, // %
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-rose-600" />
          Tren Biaya Bersih
          <FormulaInfo
            formula="Biaya Bersih = Total LOSS − Total SURPLUS"
            description={'UNTUK APA: Melacak NET cost impact dari waktu ke waktu (LOSS dikurangi SURPLUS).\nCARA BACA: Positif = net loss (uang bocor). Negatif = net surplus (over-portioning atau under-recording). Trend menurun = membaik.\nCONTOH: LOSS Rp 10Jt - SURPLUS Rp 9Jt = Net Rp 1Jt (loss).\nACTION: Trend naik = evaluasi perubahan proses. Net negatif konsisten = cek under-portioning.'}
            example="W1: LOSS 80M − SURPLUS 20M = Net 60M (LOSS dominan)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Net cost ratio trend per minggu</p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data tren</p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="weekLabel" fontSize={11} />
                <YAxis yAxisId="left" tickFormatter={(v) => `${v.toFixed(0)}M`} fontSize={11} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v.toFixed(1)}%`} fontSize={11} />
                <Tooltip
                  content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                    active && payload && payload.length
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{label}</p>
                          {payload.map((p, i) => (
                            <p key={i} className="text-muted-foreground">
                              {p.name}: {p.name === 'Net Cost Ratio'
                                ? `${(p.value as number).toFixed(2)}%`
                                : `Rp ${(p.value as number).toFixed(2)}M`}
                            </p>
                          ))}
                        </div>
                      )
                      : null
                  }
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine yAxisId="right" y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                <Bar yAxisId="left" dataKey="lossJuta" name="LOSS" fill="#dc2626" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="left" dataKey="surplusJuta" name="SURPLUS" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="netCostRatio" name="Net Cost Ratio" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
