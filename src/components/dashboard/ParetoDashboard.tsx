'use client';

// ============================================================
//  ParetoDashboard — 80/20 analysis (inline tab component, not modal)
//  4-quadrant view + nested Item→Outlet breakdown
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, TrendingDown, Package, Store, MapPin, Users, Boxes, ChevronDown, ChevronRight, Target } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtNum, numberColor } from '@/lib/format';

interface ParetoRow {
  name: string;
  code?: string;
  outletCount?: number;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number; // SIGNED sum for display
  sharePct: number;
  cumPct: number;
  histAvg?: number | null;
  zScore?: number | null;
  histN?: number;
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
  qtyDeviasi: number;
  sharePct: number;
  cumPct: number;
}
interface NestedItem {
  itemName: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  outlets: NestedOutlet[];
}
interface ParetoData {
  success: boolean;
  byItem: ParetoResult;
  byOutlet: ParetoResult;
  byArea: ParetoResult;
  byKelompok: ParetoResult;
  byPIC: ParetoResult;
  nested: { items: NestedItem[]; totalAbsNominal: number };
  durationMs?: number;
}

function QuadrantCard({ title, icon, data, color, barColor }: { title: string; icon: React.ReactNode; data: ParetoResult; color: string; barColor: string }) {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${color}`}>{icon}</span>
            {title}
          </CardTitle>
          {data && data.totalCount > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {data.drivers.length} dari {data.totalCount} = 80%
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!data || data.drivers.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Tidak ada data</p>
        ) : (
          <div className="max-h-[300px] overflow-auto">
            <Table className="min-w-[600px]">
              <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider h-7 p-1">#</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wider h-7 p-1">Nama</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1">QTY</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1">Nominal</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1 hidden xl:table-cell">Hist Avg</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1 hidden xl:table-cell">Z</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1 w-10">%</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wider h-7 p-1 w-10">Cum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.drivers.map((d, i) => (
                  <TableRow key={`${d.name}-${i}`} className="hover:bg-muted/40 transition-colors border-b border-border/20 last:border-0">
                    <TableCell className="text-center text-xs tabular-nums p-1 font-bold shrink-0 w-8">
                      <span className={i === 0 ? 'text-amber-500' : i === 1 ? 'text-zinc-400' : i === 2 ? 'text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}>
                        {i + 1}
                      </span>
                    </TableCell>
                    <TableCell className="p-1">
                      <div className="font-medium text-xs truncate max-w-[180px]" title={d.name}>{d.name}</div>
                      {d.outletCount != null && <div className="text-[10px] text-muted-foreground tabular-nums">{d.outletCount} outlet</div>}
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums p-1 ${numberColor(d.qtyDeviasi)}`}>{fmtNum(d.qtyDeviasi)}</TableCell>
                    <TableCell className={`text-right text-xs tabular-nums font-medium p-1 ${numberColor(d.nominalDeviasi)}`}>{fmtIDR(d.nominalDeviasi)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground p-1 hidden xl:table-cell" title={d.histN ? `${d.histN} periode historis (all months)` : ''}>
                      {d.histAvg != null ? fmtIDR(d.histAvg) : '—'}
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums font-medium p-1 hidden xl:table-cell ${
                      d.zScore == null ? 'text-muted-foreground' : Math.abs(d.zScore) > 2 ? 'text-red-600 dark:text-red-400 font-bold' : Math.abs(d.zScore) > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                    }`} title={d.zScore != null ? `Z-score: ${d.zScore.toFixed(2)} (${d.histN} periode)` : ''}>
                      {d.zScore != null ? (d.zScore > 0 ? '+' : '') + d.zScore.toFixed(1) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground p-1">{d.sharePct.toFixed(0)}%</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground/60 p-1">{d.cumPct.toFixed(0)}%</TableCell>
                  </TableRow>
                ))}
                {data.remainderCount > 0 && (
                  <TableRow className="border-0">
                    <TableCell colSpan={8} className="text-[10px] text-muted-foreground/60 p-1 pl-6">
                      Sisa {data.remainderPct.toFixed(0)}%: {data.remainderCount} lainnya
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ParetoDashboard() {
  const { monthLabel, currentWeek, area, kelompok, pic } = useDashboard();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Reset expanded items when filter changes (stale state cleanup)
  const filterKey = `${monthLabel}|${currentWeek}|${area}|${kelompok}|${pic}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setExpandedItems(new Set());
  }

  const { data: paretoData, isLoading, error } = useQuery<ParetoData>({
    queryKey: ['pareto', monthLabel, currentWeek, area, kelompok, pic],
    queryFn: async () => {
      const p = new URLSearchParams({
        month: monthLabel!,
        week: currentWeek!,
      });
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/pareto?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(monthLabel && currentWeek),
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600 dark:text-red-400 font-medium">Gagal memuat Pareto: {error.message}</p>
        <p className="text-xs text-muted-foreground mt-1">Coba refresh halaman atau ganti periode.</p>
      </div>
    );
  }

  if (!paretoData || !paretoData.success) {
    return <div className="text-center text-muted-foreground text-sm py-12">Tidak ada data</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
          <TrendingDown className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Pareto 80/20 Analysis</h2>
          <p className="text-xs text-muted-foreground">
            Top contributors yang menyumbang 80% total deviation
            {paretoData.durationMs != null && ` · ${paretoData.durationMs}ms`}
          </p>
        </div>
      </div>

      {/* 5-Quadrant Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuadrantCard
          title="Top Items (80% Deviation)"
          icon={<Package className="h-3.5 w-3.5" />}
          data={paretoData.byItem}
          color="bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
          barColor="bg-amber-500"
        />
        <QuadrantCard
          title="Top Outlets (80% Deviation)"
          icon={<Store className="h-3.5 w-3.5" />}
          data={paretoData.byOutlet}
          color="bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
          barColor="bg-emerald-500"
        />
        <QuadrantCard
          title="Top Kelompok (80% Deviation)"
          icon={<Boxes className="h-3.5 w-3.5" />}
          data={paretoData.byKelompok}
          color="bg-cyan-100 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400"
          barColor="bg-cyan-500"
        />
        <QuadrantCard
          title="Top Areas (80% Deviation)"
          icon={<MapPin className="h-3.5 w-3.5" />}
          data={paretoData.byArea}
          color="bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400"
          barColor="bg-violet-500"
        />
        <QuadrantCard
          title="Top PIC (80% Deviation)"
          icon={<Users className="h-3.5 w-3.5" />}
          data={paretoData.byPIC}
          color="bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400"
          barColor="bg-red-500"
        />
      </div>

      {/* Nested Item → Outlet Breakdown */}
      {nestedItems.length > 0 && (
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300">
                  <ChevronDown className="h-3.5 w-3.5" />
                </span>
                Item → Outlet Breakdown
              </CardTitle>
              <Badge variant="secondary" className="text-[10px]">Klik item untuk expand outlet</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-2">
              Top 10 item by deviation. Klik untuk lihat outlet mana yang menyumbang 80% per item.
            </p>
            {/* Column headers */}
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 pb-1 border-b border-border/40 mb-1">
              <span className="w-5 shrink-0">#</span>
              <span className="w-3 shrink-0"></span>
              <span className="min-w-[120px] flex-1 shrink-0">Nama</span>
              <span className="w-20 text-right shrink-0">QTY</span>
              <span className="w-24 text-right shrink-0">Nominal</span>
              <span className="w-10 text-right shrink-0">%</span>
              <span className="w-10 text-right shrink-0">Cum</span>
            </div>
            <div className="space-y-0.5 max-h-[500px] overflow-y-auto">
              {nestedItems.map((item, i) => {
                const isExpanded = expandedItems.has(item.itemName);
                return (
                  <div key={`${item.itemName}-${i}`}>
                    <button
                      onClick={() => toggleItem(item.itemName)}
                      aria-expanded={isExpanded}
                      className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left"
                    >
                      <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                      {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="min-w-[120px] flex-1 truncate font-medium" title={item.itemName}>{item.itemName}</span>
                      <span className="text-muted-foreground text-[10px] tabular-nums shrink-0">{item.outletCount} out</span>
                      <span className={`w-20 text-right tabular-nums shrink-0 ${numberColor(item.qtyDeviasi)}`}>{fmtNum(item.qtyDeviasi)}</span>
                      <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</span>
                      <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{item.sharePct.toFixed(0)}%</span>
                      <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{item.cumPct.toFixed(0)}%</span>
                    </button>
                    {isExpanded && item.outlets.length > 0 && (
                      <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                        {/* Outlet sub-header */}
                        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 py-0.5">
                          <span className="w-4 shrink-0"></span>
                          <span className="min-w-[100px] flex-1 shrink-0">Outlet</span>
                          <span className="text-[10px] shrink-0">Area</span>
                          <span className="w-20 text-right shrink-0">QTY</span>
                          <span className="w-24 text-right shrink-0">Nominal</span>
                          <span className="w-10 text-right shrink-0">%</span>
                          <span className="w-10 text-right shrink-0">Cum</span>
                        </div>
                        {item.outlets.map((o, j) => (
                          <div key={`${o.outletCode}-${j}`} className="flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20">
                            <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                            <span className="min-w-[100px] flex-1 truncate" title={o.outletName}>{o.outletName}</span>
                            <span className="text-muted-foreground text-[10px] shrink-0">{o.area}</span>
                            <span className={`w-20 text-right tabular-nums shrink-0 ${numberColor(o.qtyDeviasi)}`}>{fmtNum(o.qtyDeviasi)}</span>
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
          </CardContent>
        </Card>
      )}

      {/* Insight Footer — Action Plan */}
      <Card className="bg-gradient-to-br from-amber-50/60 to-amber-50/20 dark:from-amber-950/30 dark:to-amber-950/10 border-amber-300/50 dark:border-amber-800/50 shadow-md shadow-amber-500/5">
        <CardContent className="py-4 px-4">
          <div className="flex items-start gap-3">
            <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 dark:bg-amber-500/10 border border-amber-400/30">
              <Target className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 space-y-1.5">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                Action Plan — Prioritas Investigasi
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <div className="flex items-center gap-1.5 text-xs">
                  <Package className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span className="text-amber-700 dark:text-amber-400">
                    <strong>{paretoData.byItem?.drivers.length || 0}</strong> item = 80% deviation
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <Store className="h-3 w-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span className="text-amber-700 dark:text-amber-400">
                    <strong>{paretoData.byOutlet?.drivers.length || 0}</strong> outlet = 80% masalah
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <Boxes className="h-3 w-3 text-cyan-600 dark:text-cyan-400 shrink-0" />
                  <span className="text-amber-700 dark:text-amber-400">
                    <strong>{paretoData.byKelompok?.drivers.length || 0}</strong> kelompok = 80% deviation
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <Users className="h-3 w-3 text-red-600 dark:text-red-400 shrink-0" />
                  <span className="text-amber-700 dark:text-amber-400">
                    <strong>{paretoData.byPIC?.drivers.length || 0}</strong> PIC = 80% deviation
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-amber-600/70 dark:text-amber-400/60 pt-1">
                Fokus ke item di atas untuk eliminasi 80% total deviation dengan efisien.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
