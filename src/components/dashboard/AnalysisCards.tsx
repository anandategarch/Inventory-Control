'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  History, GitBranch, Calendar, Utensils,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ResponsiveContainer, Cell,
} from 'recharts';

// Shared tooltip payload type (any required by Recharts typing)
type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

// ============================================================
//  2.1 HistoricalAnalysisCard
//  Z-Score anomaly vs historical pattern
// ============================================================
function zScoreColor(z: number | null | undefined): string {
  if (z == null) return '';
  if (z > 3) return 'text-red-600 font-bold';
  if (z > 2) return 'text-amber-600';
  return '';
}

export function HistoricalAnalysisCard({ data }: { data: AnalysisData }) {
  const setScorecardOutlet = useDashboard((s) => s.setScorecardOutlet);
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);

  const hist = data.growthComparison?.historicalAnalysis;
  const items = (hist?.criticalItems || []).slice().sort((a, b) => b.zScore - a.zScore);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <History className="h-4 w-4 text-violet-600" />
          Analisis Historical (Z-Score)
          <FormulaInfo
            formula="Z-Score = (Current − Historical Avg) / Std Dev"
            description={'UNTUK APA: Mengidentifikasi outlet/item yang menyimpang dari pola historical (z-score > threshold).\nCARA BACA: Z-Score > 3 = ekstrem (merah). > 2 = signifikan (kuning). Menunjukkan anomali vs perilaku normal outlet.\nCONTOH: Outlet A current dev 49% vs historical avg 10% (z-score 3.5) → ekstrem.\nACTION: Investigasi perubahan operasional di outlet dengan z-score > 3.'}
            example="Current 18% vs Historical 8% ± 3% → Z = (18-8)/3 = 3.33 (outlier)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">{items.length} item dengan anomali historical</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="text-[10px] h-7 px-2">Outlet</TableHead>
                <TableHead className="text-[10px] h-7 px-2">NAMA BAHAN</TableHead>
                <TableHead className="text-[10px] h-7 px-2 text-right">Current %DEV/BOM</TableHead>
                <TableHead className="text-[10px] h-7 px-2 text-right">Historical Avg</TableHead>
                <TableHead className="text-[10px] h-7 px-2 text-right">Z-Score</TableHead>
                <TableHead className="text-[10px] h-7 px-2 text-right">|NOMINAL|</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-6">Tidak ada anomali historical</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow
                  key={`${it.outletCode}-${it.itemName}-${i}`}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => {
                    setScorecardOutlet(it.outletCode);
                    setDrilldown({ outletCode: it.outletCode, itemName: it.itemName });
                    setDeepDiveItem({ itemName: it.itemName, outletCode: it.outletCode });
                  }}
                >
                  <TableCell className="text-[11px] px-2 py-1 text-muted-foreground">{it.outletCode}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 font-medium truncate max-w-[140px]">{it.itemName}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right text-red-600 font-semibold">{fmtPctAbs(it.currentDevBom)}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right text-muted-foreground">{fmtPctAbs(it.historicalAvg)}</TableCell>
                  <TableCell className={`text-[11px] px-2 py-1 text-right ${zScoreColor(it.zScore)}`}>{it.zScore.toFixed(2)}</TableCell>
                  <TableCell className="text-[11px] px-2 py-1 text-right font-semibold">{fmtIDR(it.absNominal)}</TableCell>
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
//  2.2 TrendDecompositionCard
//  Dekomposisi trend (Volume + Price + Operational Effect)
// ============================================================
export function TrendDecompositionCard({ data }: { data: AnalysisData }) {
  const g = data.growthComparison as any;
  const volumeEffect: number | null = g?.volumeEffect ?? null;
  const priceEffect: number | null = g?.priceEffect ?? null;
  const operationalEffect: number | null = g?.operationalEffect ?? null;
  const allNull = volumeEffect == null && priceEffect == null && operationalEffect == null;

  const effects = [
    { name: 'Volume Effect', value: volumeEffect, color: '#06b6d4', desc: 'Perubahan deviation akibat perubahan volume aktivitas (BOM)' },
    { name: 'Price Effect', value: priceEffect, color: '#f59e0b', desc: 'Perubahan deviation akibat perubahan harga' },
    { name: 'Operational Effect', value: operationalEffect, color: '#dc2626', desc: 'Perubahan deviation akibat inefisiensi operasional (Dev/BOM ratio)' },
  ];

  const maxAbs = Math.max(...effects.map((e) => Math.abs(e.value ?? 0)), 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <GitBranch className="h-4 w-4 text-cyan-600" />
          Dekomposisi Trend (3-Efek)
          <FormulaInfo
            formula="ΔNOMINAL = Volume Effect + Price Effect + Operational Effect"
            description={'UNTUK APA: Mendekomposisi kenaikan NOMINAL DEVIASI ke dalam 3 efek: Volume, Price, Operational.\nCARA BACA: Volume Effect = dampak kenaikan qty. Price Effect = dampak kenaikan harga. Operational Effect = dampak perubahan usage vs SOC.\nCONTOH: Sales +54%, BOM +42%, Deviasi +442% → Volume +42%, Price +X%, Operational +sisanya.\nACTION: Operational Effect dominan → investigasi proses/portioning. Price Effect dominan → cek harga beli.'}
            example="Δ +20M = Volume +15M + Price +5M + Operational +0M"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Dekomposisi perubahan deviation vs periode sebelumnya</p>
      </CardHeader>
      <CardContent>
        {allNull ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data dekomposisi</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {effects.map((e) => {
              const positive = (e.value ?? 0) > 0;
              const barWidth = (Math.abs(e.value ?? 0) / maxAbs) * 100;
              // For deviation: positive effect = bad (red), negative = good (emerald)
              const barColor = positive ? '#dc2626' : '#10b981';
              return (
                <div key={e.name} className="space-y-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground">{e.name}</p>
                  <p className={`text-lg font-bold ${positive ? 'text-red-600' : 'text-emerald-600'}`}>
                    {fmtIDR(e.value)}
                  </p>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${barWidth}%`, background: barColor }} />
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-tight">{e.desc}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  2.3 MultiPeriodComparisonCard
//  Perbandingan multi-periode (trend sales/BOM/deviasi)
// ============================================================
export function MultiPeriodComparisonCard({ data }: { data: AnalysisData }) {
  const multi = (data.growthComparison as any)?.multiPeriodComparison as Array<Record<string, any>> | undefined;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-sky-600" />
          Perbandingan Multi-Periode
          <FormulaInfo
            formula="Trend per periode: Sales vs BOM vs Deviasi + Growth %"
            description={'UNTUK APA: Membandingkan metric kunci (Sales, BOM, Deviasi) across multiple period untuk lihat pola trend.\nCARA BACA: Bar = nilai absolut per period. Line = growth %. Trend naik di Deviasi sementara Sales flat = memburuk.\nCONTOH: W1 Dev 10M, W2 Dev 15M, W3 Dev 25M → trend naik meski Sales stabil.\nACTION: Trend deviasi naik konsisten → evaluasi perubahan proses bertahap.'}
            example="W1 → W2 → W3: Deviasi 30M → 25M → 40M (growth +60% di W3)"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Trend lintas periode pembanding</p>
      </CardHeader>
      <CardContent>
        {!multi || multi.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data multi-periode</p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={multi} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" fontSize={11} />
                <YAxis yAxisId="left" tickFormatter={(v) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(0)}M` : v.toLocaleString()} fontSize={11} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} />
                <Tooltip
                  content={({ active, payload, label }: { active?: boolean; payload?: TipPayload; label?: string }) =>
                    active && payload && payload.length
                      ? (
                        <div className="rounded-md border bg-background p-2 shadow-md text-xs space-y-0.5">
                          <p className="font-medium">{label}</p>
                          {payload.map((p, i) => (
                            <p key={i} className="text-muted-foreground">
                              {p.name}: {p.name === 'Growth' ? `${((p.value as number) * 100).toFixed(1)}%` : fmtIDR(p.value as number)}
                            </p>
                          ))}
                        </div>
                      )
                      : null
                  }
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar yAxisId="left" dataKey="sales" name="Sales" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="left" dataKey="bom" name="BOM" fill="#06b6d4" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="left" dataKey="deviation" name="Deviasi" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="growthPct" name="Growth" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
//  2.4 MenuAnalysisCard
//  Analisis Menu/BOM (group by prefix)
// ============================================================
export function MenuAnalysisCard({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);

  const menuAnalysis = (data as any)?.menuAnalysis as Array<{
    prefix: string;
    itemCount: number;
    totalDeviation: number;
    avgDeviation: number;
    items: any[];
    outliers: any[];
  }> | undefined;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          <Utensils className="h-4 w-4 text-rose-600" />
          Analisis Menu/BOM
          <FormulaInfo
            formula="Group by item prefix → detect shared deviation patterns"
            description={'UNTUK APA: Menganalisis hubungan bahan pembentuk menu — apakah semua komponen bergerak bersama?\nCARA BACA: Group by item prefix (mis. MIE-> mie, ayam, pangsit). Jika 1 bahan naik jauh lebih tinggi dari bahan lain = outlier.\nCONTOH: Menu MIE: mie +5%, ayam +200%, pangsit +3% → ayam = outlier (investigasi).\nACTION: Outlier item → cek quality issue, waste, atau SOC issue.'}
            example="Prefix 'AYAM' (5 item, 3 outlier) → pola deviation pada menu ayam"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">{menuAnalysis?.length || 0} grup menu terdeteksi</p>
      </CardHeader>
      <CardContent>
        {!menuAnalysis || menuAnalysis.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Tidak ada data menu analysis</p>
        ) : (
          <ScrollArea className="h-96">
            <Accordion type="single" collapsible className="w-full">
              {menuAnalysis.map((m, idx) => (
                <AccordionItem key={`${m.prefix}-${idx}`} value={`item-${idx}`}>
                  <AccordionTrigger className="text-xs hover:no-underline py-2">
                    <div className="flex items-center justify-between w-full pr-3">
                      <span className="font-medium">{m.prefix}</span>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{m.itemCount} item</span>
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0">{m.outliers?.length || 0} outlier</Badge>
                        <span className="font-semibold text-amber-600">{fmtIDR(m.totalDeviation)}</span>
                        <span>{fmtPctAbs(m.avgDeviation)}</span>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 py-1">
                      {(m.outliers || []).length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-red-600 uppercase tracking-wide mb-1">Outliers</p>
                          <div className="space-y-0.5">
                            {(m.outliers || []).slice(0, 5).map((o: any, i: number) => (
                              <button
                                key={i}
                                type="button"
                                className="block w-full text-left text-[11px] hover:bg-muted/50 rounded px-1.5 py-1 cursor-pointer"
                                onClick={() => {
                                  if (o?.outletCode && o?.itemName) {
                                    setDrilldown({ outletCode: o.outletCode, itemName: o.itemName });
                                    setDeepDiveItem({ itemName: o.itemName, outletCode: o.outletCode });
                                  }
                                }}
                              >
                                <span className="font-medium">{o.itemName}</span>
                                <span className="text-muted-foreground"> · {o.outletCode}</span>
                                <span className="text-red-600 font-semibold"> · {fmtIDR(o.absNominal || o.totalDeviation || 0)}</span>
                                <span className="text-muted-foreground"> · {fmtPctAbs(o.devBom || o.deviation || 0)}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {(m.items || []).length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Items ({m.items.length})</p>
                          <div className="space-y-0.5">
                            {(m.items || []).slice(0, 8).map((it: any, i: number) => (
                              <div key={i} className="text-[11px] px-1.5 py-0.5">
                                <span className="font-medium">{it.itemName || it.name}</span>
                                <span className="text-muted-foreground"> · {it.outletCode || ''}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
