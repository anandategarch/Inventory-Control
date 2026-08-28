'use client';

// ============================================================
//  ParetoDashboard — 80/20 analysis (inline tab component, not modal)
//  4-quadrant view + nested Item→Outlet breakdown
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, TrendingDown, Package, Store, MapPin, Users, Boxes, ChevronDown, ChevronRight, Target, RotateCcw } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ParetoDevBomCard, GapAnalysisCard } from '@/components/dashboard/TopItems';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR, fmtNum, numberColor } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

// FIX #42: ParetoDimension mirror of backend enum (see src/lib/queries/pareto.ts)
type ParetoDimension = 'item' | 'outlet' | 'area' | 'kelompok' | 'pic';

const DIM_LABELS: Record<ParetoDimension, string> = {
  item: 'Item',
  outlet: 'Outlet',
  area: 'Area',
  kelompok: 'Kelompok',
  pic: 'PIC',
};

// FIX #28: countSuffix helper — picks the short label for the dimension
// shown under each row in a QuadrantCard (e.g. "3 out", "5 klp", "2 pic").
function countSuffix(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('kelompok')) return 'klp';
  if (t.includes('pic')) return 'pic';
  if (t.includes('outlet')) return 'out';
  if (t.includes('area')) return 'area';
  return ''; // items have no count suffix
}

// FIX #23: per-quadrant tooltip text describing what each card shows.
const QUADRANT_TOOLTIPS: Record<string, string> = {
  'Top Items (80% Deviation)': 'Top item yang menyumbang 80% total |nominalDeviasi|. Sisa item hanya 20%.',
  'Top Outlets (80% Deviation)': 'Top outlet yang menyumbang 80% total |nominalDeviasi|. Fokus ke sini untuk impact maksimal.',
  'Top Kelompok (80% Deviation)': 'Top kelompok (segment) yang menyumbang 80% total |nominalDeviasi|. Bisa signalkan masalah sistemik di kelompok tersebut.',
  'Top Areas (80% Deviation)': 'Top area geografis yang menyumbang 80% total |nominalDeviasi|.',
  'Top PIC (80% Deviation)': 'Top PIC (Person In Charge) yang menyumbang 80% total |nominalDeviasi|.',
};

// FIX #42: nestedGeneralized child row shape (mirrors NestedParetoResultItem.children)
interface NestedChild {
  name: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  sharePct: number;
  cumPct: number;
}
// FIX #42: nestedGeneralized parent row shape (mirrors NestedParetoResultItem)
interface NestedGeneralizedItem {
  name: string;
  totalAbsNominal: number;
  nominalDeviasi: number;
  qtyDeviasi: number;
  outletCount: number;
  sharePct: number;
  cumPct: number;
  children: NestedChild[];
}

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
  // FIX #42: optional generalized nested response (set when both parentDim +
  // childDim query params are sent to /api/pareto)
  nestedGeneralized?: {
    items: NestedGeneralizedItem[];
    totalAbsNominal: number;
    parentDim: ParetoDimension;
    childDim: ParetoDimension;
  };
  parentDim?: ParetoDimension;
  childDim?: ParetoDimension;
  durationMs?: number;
}

function QuadrantCard({ title, icon, data, color, barColor, tooltip }: { title: string; icon: React.ReactNode; data: ParetoResult; color: string; barColor: string; tooltip?: string }) {
  const suffix = countSuffix(title);
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2.5">
            <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${color}`}>{icon}</span>
            {title}
            {tooltip && <InfoTooltip content={tooltip} />}
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
                      {d.outletCount != null && suffix && <div className="text-[10px] text-muted-foreground tabular-nums">{d.outletCount} {suffix}</div>}
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

export function ParetoDashboard({ analysisData }: { analysisData?: any }) {
  const { monthLabel, currentWeek, area, kelompok, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    pic: s.pic,
  })));
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  // FIX #42: parent + child dimension state for the generalized nested query.
  // Defaults to 'item' → 'outlet' (same as the hardcoded nested breakdown).
  const [parentDim, setParentDim] = useState<ParetoDimension>('item');
  const [childDim, setChildDim] = useState<ParetoDimension>('outlet');
  const [expandedGen, setExpandedGen] = useState<Set<string>>(new Set());

  // Reset expanded items when filter changes (stale state cleanup)
  const filterKey = `${monthLabel}|${currentWeek}|${area}|${kelompok}|${pic}|${parentDim}|${childDim}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setExpandedItems(new Set());
    setExpandedGen(new Set());
  }

  const { data: paretoData, isLoading, error, refetch } = useQuery<ParetoData>({
    queryKey: ['pareto', monthLabel, currentWeek, area, kelompok, pic, parentDim, childDim],
    queryFn: async () => {
      const p = new URLSearchParams({
        month: monthLabel!,
        week: currentWeek!,
      });
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      // FIX: only send parentDim/childDim when NOT default (item→outlet)
      // to avoid unnecessary queryParetoNested call on every request.
      if (parentDim !== 'item' || childDim !== 'outlet') {
        p.set('parentDim', parentDim);
        p.set('childDim', childDim);
      }
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
  const toggleGen = (name: string) => {
    setExpandedGen(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const nestedItems = paretoData?.nested?.items || [];
  const nestedGen = paretoData?.nestedGeneralized;

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
        {/* FIX #29: retry button using the dead RotateCcw import */}
        <Button onClick={() => refetch()} variant="outline" size="sm" className="mt-3">
          <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
        </Button>
      </div>
    );
  }

  if (!paretoData || !paretoData.success) {
    return <div className="text-center text-muted-foreground text-sm py-12">Tidak ada data</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
          <TrendingDown className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">Pareto 80/20 Analysis</h2>
          <p className="text-xs text-muted-foreground">
            Top contributors yang menyumbang 80% total deviation
            {paretoData.durationMs != null && ` · ${paretoData.durationMs}ms`}
          </p>
        </div>
        {/* FIX #42: parent + child dimension selectors for the generalized
            nested breakdown. Backend supports any (parentDim, childDim)
            combination where the two differ. */}
        <div className="flex items-center gap-2">
          <Select value={parentDim} onValueChange={(v) => setParentDim(v as ParetoDimension)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="Parent" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DIM_LABELS) as ParetoDimension[]).map((d) => (
                <SelectItem key={d} value={d}>{DIM_LABELS[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">→</span>
          <Select value={childDim} onValueChange={(v) => setChildDim(v as ParetoDimension)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="Child" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DIM_LABELS) as ParetoDimension[])
                .filter((d) => d !== parentDim)
                .map((d) => (
                  <SelectItem key={d} value={d}>{DIM_LABELS[d]}</SelectItem>
                ))}
            </SelectContent>
          </Select>
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
          tooltip={QUADRANT_TOOLTIPS['Top Items (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Outlets (80% Deviation)"
          icon={<Store className="h-3.5 w-3.5" />}
          data={paretoData.byOutlet}
          color="bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
          barColor="bg-emerald-500"
          tooltip={QUADRANT_TOOLTIPS['Top Outlets (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Kelompok (80% Deviation)"
          icon={<Boxes className="h-3.5 w-3.5" />}
          data={paretoData.byKelompok}
          color="bg-cyan-100 dark:bg-cyan-950/40 text-cyan-600 dark:text-cyan-400"
          barColor="bg-cyan-500"
          tooltip={QUADRANT_TOOLTIPS['Top Kelompok (80% Deviation)']}
        />
        <QuadrantCard
          title="Top Areas (80% Deviation)"
          icon={<MapPin className="h-3.5 w-3.5" />}
          data={paretoData.byArea}
          color="bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400"
          barColor="bg-violet-500"
          tooltip={QUADRANT_TOOLTIPS['Top Areas (80% Deviation)']}
        />
        <QuadrantCard
          title="Top PIC (80% Deviation)"
          icon={<Users className="h-3.5 w-3.5" />}
          data={paretoData.byPIC}
          color="bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400"
          barColor="bg-red-500"
          tooltip={QUADRANT_TOOLTIPS['Top PIC (80% Deviation)']}
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

      {/* FIX #42: Generalized nested breakdown (parentDim → childDim) —
          rendered when the user-selected combo differs from the default
          Item→Outlet (which is already shown by the card above). */}
      {nestedGen && nestedGen.items.length > 0 && (parentDim !== 'item' || childDim !== 'outlet') && (
        <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                  <ChevronDown className="h-3.5 w-3.5" />
                </span>
                {DIM_LABELS[parentDim]} → {DIM_LABELS[childDim]} Breakdown
                <InfoTooltip content={`Top 10 ${DIM_LABELS[parentDim].toLowerCase()} by |nominalDeviasi|, with per-parent ${DIM_LABELS[childDim].toLowerCase()} breakdown (80% cutoff).`} />
              </CardTitle>
              <Badge variant="secondary" className="text-[10px]">Klik untuk expand</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-2">
              Top 10 {DIM_LABELS[parentDim].toLowerCase()} by deviation. Klik untuk lihat {DIM_LABELS[childDim].toLowerCase()} mana yang menyumbang 80% per parent.
            </p>
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
              {nestedGen.items.map((item, i) => {
                const isExpanded = expandedGen.has(item.name);
                return (
                  <div key={`${item.name}-${i}`}>
                    <button
                      onClick={() => toggleGen(item.name)}
                      aria-expanded={isExpanded}
                      className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors text-left"
                    >
                      <span className="w-5 text-muted-foreground tabular-nums shrink-0">{i + 1}.</span>
                      {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="min-w-[120px] flex-1 truncate font-medium" title={item.name}>{item.name}</span>
                      <span className={`w-20 text-right tabular-nums shrink-0 ${numberColor(item.qtyDeviasi)}`}>{fmtNum(item.qtyDeviasi)}</span>
                      <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(item.nominalDeviasi)}`}>{fmtIDR(item.nominalDeviasi)}</span>
                      <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{item.sharePct.toFixed(0)}%</span>
                      <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{item.cumPct.toFixed(0)}%</span>
                    </button>
                    {isExpanded && item.children.length > 0 && (
                      <div className="ml-10 mr-2 mb-1 border-l-2 border-border/40 pl-2 space-y-0.5">
                        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 py-0.5">
                          <span className="w-4 shrink-0"></span>
                          <span className="min-w-[100px] flex-1 shrink-0">{DIM_LABELS[childDim]}</span>
                          <span className="w-20 text-right shrink-0">QTY</span>
                          <span className="w-24 text-right shrink-0">Nominal</span>
                          <span className="w-10 text-right shrink-0">%</span>
                          <span className="w-10 text-right shrink-0">Cum</span>
                        </div>
                        {item.children.map((c, j) => (
                          <div key={`${c.name}-${j}`} className="flex items-center gap-2 text-[11px] py-1 px-2 rounded bg-muted/20">
                            <span className="w-4 text-muted-foreground tabular-nums shrink-0">{j + 1}.</span>
                            <span className="min-w-[100px] flex-1 truncate" title={c.name}>{c.name}</span>
                            <span className={`w-20 text-right tabular-nums shrink-0 ${numberColor(c.qtyDeviasi)}`}>{fmtNum(c.qtyDeviasi)}</span>
                            <span className={`w-24 text-right tabular-nums font-medium shrink-0 ${numberColor(c.nominalDeviasi)}`}>{fmtIDR(c.nominalDeviasi)}</span>
                            <span className="w-10 text-right text-muted-foreground tabular-nums shrink-0">{c.sharePct.toFixed(0)}%</span>
                            <span className="w-10 text-right text-muted-foreground/60 tabular-nums shrink-0">{c.cumPct.toFixed(0)}%</span>
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

      {/* Pareto Item Abnormal (|Dev/BOM| > 50%) — full width, below Nested Breakdown */}
      <ParetoDevBomCard data={analysisData} />

      {/* Gap Analysis: Rank BOM vs Rank Nasional — full width */}
      <GapAnalysisCard data={analysisData} />

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
