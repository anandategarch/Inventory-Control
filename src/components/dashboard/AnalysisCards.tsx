'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPct, fmtPctAbs } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import {
  Calendar, Utensils,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';

// Shared tooltip payload type (any required by Recharts typing)
type TipPayload = Array<{ payload?: any; value?: any; name?: any; label?: any }> | undefined;

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
                <YAxis yAxisId="left" tickFormatter={(v) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(0)}Jt` : v.toLocaleString()} fontSize={11} />
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
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
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
                          <p className="text-[11px] font-semibold text-red-600 uppercase tracking-wide mb-1">Pencilan</p>
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
                          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Item ({m.items.length})</p>
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
