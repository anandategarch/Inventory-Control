'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPctAbs, directionColor, priorityColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { ShieldAlert } from 'lucide-react';

type PriorityTab = 'all' | 'P1' | 'P2' | 'P3';

// ============================================================
//  AlertPanel
//  Sistem Peringatan — kartu alert dengan filter priority
// ============================================================
export function AlertPanel({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);
  const [tab, setTab] = useState<PriorityTab>('all');

  const items = data.investigationWorklist || [];
  const p1Count = items.filter((w: any) => w.priority === 'P1').length;
  const p2Count = items.filter((w: any) => w.priority === 'P2').length;
  const p3Count = items.filter((w: any) => w.priority === 'P3').length;

  const filtered = tab === 'all' ? items : items.filter((w: any) => w.priority === tab);

  const onClick = (w: any) => {
    setDrilldown({ outletCode: w.outletCode, itemName: w.itemName });
    setDeepDiveItem({ itemName: w.itemName, outletCode: w.outletCode });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4 text-red-600" />
              Sistem Peringatan
              <FormulaInfo
                formula="Priority = rule severity × magnitude deviation × outlet impact"
                description={'UNTUK APA: Sistem peringatan otomatis berdasarkan aturan deteksi anomali.\nCARA BACA: P1 = prioritas tertinggi (investigasi segera). P2 = menengah. P3 = rendah. Setiap alert ada issue, evidence, recommended action.\nCONTOH: P1 alert: Outlet A item B, |NOMINAL| Rp 50M, deviasi > 2x area avg.\nACTION: Fokus P1 dulu → investigasi fisik + cek evidence + lakukan recommended action.'}
                example="Outlet A · LOSS Rp 200M · Dev/BOM 25% → P1 (kritis)"
                side="bottom"
              />
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {items.length} peringatan aktif · P1: {p1Count} · P2: {p2Count} · P3: {p3Count}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className={`text-[11px] ${priorityColor('P1')}`}>P1: {p1Count}</Badge>
            <Badge variant="outline" className={`text-[11px] ${priorityColor('P2')}`}>P2: {p2Count}</Badge>
            <Badge variant="outline" className={`text-[11px] ${priorityColor('P3')}`}>P3: {p3Count}</Badge>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as PriorityTab)} className="mt-2">
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs">All ({items.length})</TabsTrigger>
            <TabsTrigger value="P1" className="text-xs">P1 ({p1Count})</TabsTrigger>
            <TabsTrigger value="P2" className="text-xs">P2 ({p2Count})</TabsTrigger>
            <TabsTrigger value="P3" className="text-xs">P3 ({p3Count})</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            {items.length === 0 ? 'Tidak ada peringatan aktif' : `Tidak ada peringatan ${tab}`}
          </p>
        ) : (
          <ScrollArea className="h-96 px-3 pb-3">
            <div className="space-y-2">
              {filtered.map((w: any, i: number) => (
                <button
                  key={`${w.outletCode}-${w.itemName}-${i}`}
                  type="button"
                  onClick={() => onClick(w)}
                  className="w-full text-left rounded-lg border p-3 hover:bg-muted/40 hover:border-primary/40 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${priorityColor(w.priority)}`}>{w.priority}</Badge>
                        <span className="text-sm font-medium truncate">{w.outletName || w.outletCode}</span>
                        <span className="text-[11px] text-muted-foreground">({w.outletCode})</span>
                        <span className="text-[11px] text-muted-foreground">· {w.area}</span>
                      </div>
                    </div>
                    {w.direction && (
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${directionColor(w.direction) === 'text-red-600' ? 'text-red-700 bg-red-50 border-red-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>
                        {w.direction}
                      </Badge>
                    )}
                  </div>

                  {w.itemName && (
                    <p className="text-xs font-medium mb-1 truncate">{w.itemName}</p>
                  )}

                  {w.issue && (
                    <p className="text-[11px] text-muted-foreground mb-1.5">{w.issue}</p>
                  )}

                  {w.evidence && (
                    <p className="text-[11px] text-muted-foreground italic mb-2 leading-tight">
                      <span className="font-semibold not-italic">Bukti:</span> {w.evidence}
                    </p>
                  )}

                  {w.recommendedAction && (
                    <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-2 py-1.5 mb-2">
                      <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 mb-0.5">Rekomendasi Tindakan</p>
                      <p className="text-[11px] text-amber-900 dark:text-amber-300 leading-tight">{w.recommendedAction}</p>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      |NOMINAL|: <span className="font-semibold text-foreground">{fmtIDR(w.absNominalDeviasi)}</span>
                    </span>
                    <span>
                      % DEV TO BOM: <span className="font-semibold text-foreground">{w.deviationToBom != null ? fmtPctAbs(w.deviationToBom) : '—'}</span>
                    </span>
                    {w.ruleCodes && w.ruleCodes.length > 0 && (
                      <span className="truncate ml-2">Rules: {w.ruleCodes.join(', ')}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
