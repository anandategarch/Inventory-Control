'use client';

// ============================================================
//  GlobalItemSearchModal — Cmd+K global item search
//  Two-stage UI:
//    1. Autocomplete: user types → calls /api/item-search?mode=autocomplete
//    2. Cross-outlet view: user selects item → calls ?mode=cross-outlet
//       → shows that item's deviation across ALL outlets (table)
//
//  Triggered by Cmd+K keyboard shortcut (wired in page.tsx).
//  Closes on Escape / backdrop click / item clear.
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Search, Package, X } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { fmtIDR, fmtNum, fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';

interface AutocompleteResult {
  itemName: string;
  outletCount: number;
  totalAbsNominal: number;
}

interface CrossOutletRow {
  itemName: string;
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  satuan: string | null;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  nominalDeviasi: number;
  nominalLossSurplus: number;
  absNominalDeviasi: number;
  devBom: number | null;
  direction: string;
}

function directionColor(d: string): string {
  return d === 'LOSS' ? 'text-red-600 dark:text-red-400' : d === 'SURPLUS' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
}

function numberColor(v: number): string {
  return v < 0 ? 'text-red-600 dark:text-red-400' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
}

export function GlobalItemSearchModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { monthLabel, currentWeek, area, pic, setFocusOutlet, setActiveTab } = useDashboard();
  const [query, setQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input + reset state when modal opens.
  // FIX lint: "adjust state during render" pattern (React docs). When `open`
  // transitions to true, reset query + selectedItem. This is safe because we
  // reset to the same initial values every time (idempotent), and React will
  // immediately re-render with the updated state before committing to DOM.
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      // Modal just opened — reset search state
      setQuery('');
      setSelectedItem(null);
    }
  }

  useEffect(() => {
    if (open) {
      // Defer focus to next tick (Dialog animation)
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Stage 1: autocomplete (debounced via React Query staleTime)
  const { data: acData, isLoading: acLoading } = useQuery<{ results: AutocompleteResult[] }>({
    queryKey: ['item-search', 'autocomplete', monthLabel, currentWeek, query],
    queryFn: async () => {
      const p = new URLSearchParams({
        mode: 'autocomplete',
        q: query,
        month: monthLabel!,
        week: currentWeek!,
      });
      const res = await fetch(`/api/item-search?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(open && query.length >= 2 && monthLabel && currentWeek && !selectedItem),
    staleTime: 60_000, // cache autocomplete for 1 min (item list rarely changes)
  });

  // Stage 2: cross-outlet view
  const { data: crossData, isLoading: crossLoading, error: crossError } = useQuery<{ results: CrossOutletRow[] }>({
    queryKey: ['item-search', 'cross-outlet', monthLabel, currentWeek, selectedItem, area, pic],
    queryFn: async () => {
      const p = new URLSearchParams({
        mode: 'cross-outlet',
        item: selectedItem!,
        month: monthLabel!,
        week: currentWeek!,
      });
      if (area && area !== 'all') p.set('area', area);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/item-search?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(selectedItem && monthLabel && currentWeek),
    staleTime: 120_000,
  });

  const results = crossData?.results || [];

  // Summary stats
  const summary = useCallback((rows: CrossOutletRow[]) => {
    if (rows.length === 0) return null;
    const totalNominal = rows.reduce((s, r) => s + r.nominalDeviasi, 0);
    const totalAbs = rows.reduce((s, r) => s + r.absNominalDeviasi, 0);
    const lossOutlets = rows.filter((r) => r.direction === 'LOSS').length;
    const surplusOutlets = rows.filter((r) => r.direction === 'SURPLUS').length;
    const avgDevBom = rows.reduce((s, r) => s + (r.devBom ?? 0), 0) / rows.length;
    return { totalNominal, totalAbs, lossOutlets, surplusOutlets, avgDevBom, outletCount: rows.length };
  }, []);

  const stats = summary(results);

  const handleOutletClick = (outletCode: string) => {
    setFocusOutlet(outletCode);
    setActiveTab('resto');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1000px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="pb-3">
          <DialogTitle className="text-base flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
              <Search className="h-3.5 w-3.5" />
            </span>
            {selectedItem ? (
              <span className="flex items-center gap-2">
                <span>Item Cross-Outlet Analysis</span>
                <Badge variant="secondary" className="text-xs">{results.length} outlet</Badge>
                <button
                  onClick={() => setSelectedItem(null)}
                  className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-md hover:bg-muted/60 transition-colors"
                  aria-label="Kembali ke pencarian"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <span>Global Item Search</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground font-normal hidden sm:inline">
              {monthLabel} · {currentWeek}
            </span>
          </DialogTitle>
        </DialogHeader>

        {!selectedItem ? (
          // Stage 1: Search input + autocomplete dropdown
          <div className="flex-1 overflow-y-auto">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ketik nama item (mis: CABAI, MINYAK MIE, BAWANG)..."
                className="pl-9 h-10"
              />
              {acLoading && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            {query.length < 2 ? (
              <div className="text-center text-muted-foreground text-sm py-12">
                <Package className="h-10 w-10 mx-auto mb-3 opacity-30" />
                Ketik minimal 2 huruf untuk mencari item di seluruh outlet
              </div>
            ) : acData?.results && acData.results.length > 0 ? (
              <div className="mt-3 space-y-1">
                <p className="text-xs text-muted-foreground px-2 mb-1">
                  {acData.results.length} item ditemukan — klik untuk lihat di semua outlet
                </p>
                {acData.results.map((r) => (
                  <button
                    key={r.itemName}
                    onClick={() => setSelectedItem(r.itemName)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors text-left group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-8 w-8 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground shrink-0 group-hover:bg-amber-100 dark:group-hover:bg-amber-950/30 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">
                        <Package className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{r.itemName}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {r.outletCount} outlet · {fmtIDR(r.totalAbsNominal)} total impact
                        </p>
                      </div>
                    </div>
                    <Search className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </button>
                ))}
              </div>
            ) : !acLoading && query.length >= 2 ? (
              <div className="text-center text-muted-foreground text-sm py-12">
                <Package className="h-10 w-10 mx-auto mb-3 opacity-30" />
                Tidak ada item ditemukan untuk &ldquo;{query}&rdquo;
              </div>
            ) : null}
          </div>
        ) : (
          // Stage 2: Cross-outlet table
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Item header + summary */}
            <div className="pb-3 border-b">
              <div className="flex items-center gap-2 mb-2">
                <Package className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <h3 className="font-semibold text-sm">{selectedItem}</h3>
              </div>
              {crossLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Memuat data cross-outlet...
                </div>
              ) : stats ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">Total Outlet</p>
                    <p className="text-sm font-bold tabular-nums">{stats.outletCount}</p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">Net Nominal</p>
                    <p className={`text-sm font-bold tabular-nums ${numberColor(stats.totalNominal)}`}>{fmtIDR(stats.totalNominal)}</p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">LOSS / SURPLUS</p>
                    <p className="text-sm font-bold tabular-nums">
                      <span className="text-red-600 dark:text-red-400">{stats.lossOutlets}</span>
                      <span className="text-muted-foreground mx-1">/</span>
                      <span className="text-emerald-600 dark:text-emerald-400">{stats.surplusOutlets}</span>
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">Avg Dev/BOM</p>
                    <p className="text-sm font-bold tabular-nums">{fmtPct(stats.avgDevBom)}</p>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Cross-outlet table */}
            <div className="flex-1 overflow-auto mt-2">
              {crossError ? (
                <div className="text-center text-red-600 dark:text-red-400 text-sm py-8">
                  Gagal memuat: {crossError.message}
                </div>
              ) : crossLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
                </div>
              ) : results.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-12">
                  Item ini tidak memiliki data deviasi di periode terpilih
                </div>
              ) : (
                <Table className="min-w-[900px]">
                  <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                    <TableRow className="border-b hover:bg-transparent">
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">#</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Area</TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">PIC</TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY BOM</TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">QTY Deviasi</TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Dev/BOM</TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Nominal Deviasi</TableHead>
                      <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Dir</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((r, i) => (
                      <TableRow
                        key={`${r.outletCode}-${i}`}
                        className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                        {...clickableRowProps(() => handleOutletClick(r.outletCode))}
                      >
                        <TableCell className="text-center text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{r.outletName}</div>
                          <div className="text-xs text-muted-foreground">{r.outletCode}</div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.area}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.pic || '—'}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{fmtNum(r.qtyBom)}</TableCell>
                        <TableCell className={`text-right text-xs tabular-nums ${numberColor(r.qtyDeviasi)}`}>{fmtNum(r.qtyDeviasi)}</TableCell>
                        <TableCell className={`text-right text-xs tabular-nums ${numberColor(r.devBom ?? 0)}`}>
                          {r.devBom != null ? fmtPct(r.devBom) : '—'}
                        </TableCell>
                        <TableCell className={`text-right font-semibold text-xs tabular-nums ${numberColor(r.nominalDeviasi)}`}>
                          {fmtIDR(r.nominalDeviasi)}
                        </TableCell>
                        <TableCell className={`text-center text-xs font-bold ${directionColor(r.direction)}`}>
                          {r.direction === 'LOSS' ? 'L' : r.direction === 'SURPLUS' ? 'S' : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2 pt-2 border-t">
              💡 Klik baris outlet untuk deep dive ke Resto Analysis outlet tersebut
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
