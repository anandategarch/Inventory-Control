'use client';

// ============================================================
//  ParetoDashboard — 80/20 analysis across 4 dimensions
//  + nested Item→Outlet breakdown
//  Triggered via a button in the header or a new tab.
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingDown, Package, Store, MapPin, Users, ChevronDown, ChevronRight } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtPctAbs } from '@/lib/format';

interface ParetoRow {
  name: string;
  code?: string;
  outletCount?: number;
  totalAbsNominal: number;
  nominalDeviasi: number;
  sharePct: number;
  cumPct: number;
}
interface ParetoResult {
  drivers: ParetoRow[];
  remainderCount: number;
  remainderPct: number;
  totalAbsNominal: number;
  totalCount: number;
}
interface NestedOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  sharePct: number;
  cumPct: number;
}
interface NestedItem {
  itemName: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  outlets: NestedOutlet[];
}
interface ParetoData {
  byItem: ParetoResult;
  byOutlet: ParetoResult;
  byArea: ParetoResult;
  byPIC: ParetoResult;
  nested: { items: NestedItem[]; totalAbsNominal: number };
}

function numberColor(v: number): string {
  return v < 0 ? 'text-red-600 dark:text-red-400' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
}

function QuadrantCard({ title, icon, data, color }: { title: string; icon: React.ReactNode; data: ParetoResult; color: string }) {
  if (!data || data.drivers.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${color}`}>{icon}</span>
          {title}
        </div>
        <p className="text-xs text-muted-foreground py-4 text-center">Tidak ada data</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-card p-4 space-y-2 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${color}`}>{icon}</span>
          {title}
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {data.drivers.length} dari {data.totalCount} = 80%
        </Badge>
      </div>
      <div className="space-y-0.5 max-h-[280px] overflow-y-auto">
        {data.drivers.map((d, i) => (
          <div key={`${d.name}-${i}`} className="flex items-center gap-2 text-xs py-1 border-b border-border/30 last:border-0">
            <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
            <span className="flex-1 truncate font-medium" title={d.name}>{d.name}</span>
            {d.outletCount != null && <span className="text-muted-foreground text-[10px] tabular-nums shrink-0">{d.outletCount} outlet</span>}
            <span className="w-20 text-right tabular-nums font-medium shrink-0">{fmtIDR(d.totalAbsNominal)}</span>
            <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{d.sharePct.toFixed(0)}%</span>
            <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{d.cumPct.toFixed(0)}%</span>
          </div>
        ))}
        {data.remainderCount > 0 && (
          <p className="text-[10px] text-muted-foreground/60 pl-6 pt-1">
            Sisa {data.remainderPct.toFixed(0)}%: {data.remainderCount} lainnya
          </p>
        )}
      </div>
    </div>
  );
}

export function ParetoDashboard({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { monthLabel, currentWeek, area, pic } = useDashboard();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const { data: paretoData, isLoading, error } = useQuery<{ success: boolean; byItem: ParetoResult; byOutlet: ParetoResult; byArea: ParetoResult; byPIC: ParetoResult; nested: { items: NestedItem[]; totalAbsNominal: number }; durationMs?: number }>({
    queryKey: ['pareto', monthLabel, currentWeek, area, pic],
    queryFn: async () => {
      const p = new URLSearchParams({
        month: monthLabel!,
        week: currentWeek!,
      });
      if (area && area !== 'all') p.set('area', area);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/pareto?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(open && monthLabel && currentWeek),
    staleTime: 120_000,
  });

  const toggleItem = (name: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const nestedItems = paretoData?.nested?.items || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1100px] max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="pb-2 shrink-0">
          <DialogTitle className="text-base flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
              <TrendingDown className="h-3.5 w-3.5" />
            </span>
            Pareto 80/20 Analysis
            {paretoData?.durationMs != null && (
              <Badge variant="outline" className="text-[10px] ml-1">{paretoData.durationMs}ms</Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground font-normal hidden sm:inline">
              {monthLabel} · {currentWeek}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">Pareto analysis — top contributors yang menyumbang 80% total deviation</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
          </div>
        ) : error ? (
          <div className="text-center text-red-600 dark:text-red-400 text-sm py-12">
            Gagal memuat: {error.message}
          </div>
        ) : !paretoData || !paretoData.success ? (
          <div className="text-center text-muted-foreground text-sm py-12">Tidak ada data</div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {/* 4-Quadrant Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <QuadrantCard
                title="Top Items (80% Deviation)"
                icon={<Package className="h-3.5 w-3.5" />}
                data={paretoData.byItem}
                color="bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
              />
              <QuadrantCard
                title="Top Outlets (80% Deviation)"
                icon={<Store className="h-3.5 w-3.5" />}
                data={paretoData.byOutlet}
                color="bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
              />
              <QuadrantCard
                title="Top Areas (80% Deviation)"
                icon={<MapPin className="h-3.5 w-3.5" />}
                data={paretoData.byArea}
                color="bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400"
              />
              <QuadrantCard
                title="Top PIC (80% Deviation)"
                icon={<Users className="h-3.5 w-3.5" />}
                data={paretoData.byPIC}
                color="bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400"
              />
            </div>

            {/* Nested Item → Outlet Breakdown */}
            {nestedItems.length > 0 && (
              <div className="rounded-xl border bg-card p-4 space-y-2 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </span>
                    Item → Outlet Breakdown
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    Klik item untuk expand outlet
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Top 10 item by deviation. Klik untuk lihat outlet mana yang menyumbang 80% per item.
                </p>
                <div className="space-y-0.5 max-h-[400px] overflow-y-auto">
                  {nestedItems.map((item, i) => {
                    const isExpanded = expandedItems.has(item.itemName);
                    return (
                      <div key={`${item.itemName}-${i}`}>
                        <button
                          onClick={() => toggleItem(item.itemName)}
                          className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left"
                        >
                          <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                          {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                          <span className="flex-1 truncate font-medium" title={item.itemName}>{item.itemName}</span>
                          <span className="text-muted-foreground text-[10px] tabular-nums shrink-0">{item.outletCount} outlet</span>
                          <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</span>
                          <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{item.sharePct.toFixed(0)}%</span>
                          <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{item.cumPct.toFixed(0)}%</span>
                        </button>
                        {isExpanded && item.outlets.length > 0 && (
                          <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                            {item.outlets.map((o, j) => (
                              <div key={`${o.outletCode}-${j}`} className="flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20">
                                <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                                <span className="flex-1 truncate" title={o.outletName}>{o.outletName}</span>
                                <span className="text-muted-foreground text-[10px] shrink-0">{o.area}</span>
                                <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(o.nominalDeviasi)}`}>{fmtIDR(o.nominalDeviasi)}</span>
                                <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{o.sharePct.toFixed(0)}%</span>
                                <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{o.cumPct.toFixed(0)}%</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground pt-1">
              💡 <strong>Insight:</strong> Fokus ke {paretoData.byItem.drivers.length} item ini untuk eliminasi 80% total deviation.
              {paretoData.byOutlet.drivers.length} outlet = 80% masalah. {paretoData.byPIC.drivers.length} PIC = 80% deviation.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
