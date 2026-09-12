'use client';

// ============================================================
//  PriceEffectCard — "AVG Price Effect (Harga vs Kuantitas)"
//  --------------------------------------------------------
//  Implements Master Context (business doc) §22 AVG PRICE + §55:
//  separates the change in Σ|nominalDeviasi| (current vs compare
//  period) into a PRICE effect and a QUANTITY effect (Bennet
//  decomposition, exact) so a nominal rise is never read as an
//  operational deviation rise before the price effect is stripped
//  out. Items dominated by the QTY effect are the operationally
//  relevant investigation targets; PRICE-dominated items indicate
//  price movement, not waste (§24: price effect is a comparison
//  factor, never root-cause proof).
//
//  Self-contained fetch (pattern: RestoRecommendationCard):
//    - queryKey ['price-effect', month, week, compareMonth, compareWeek, filters]
//    - staleTime 5 min + gcTime 10 min + keepPreviousData
//    - /api/price-effect (cached server-side 5 min, SWR envelope)
//
//  Interactions (§63 traceability): clicking a row opens ItemDeepDive
//  for that item (clickableRowProps — keyboard accessible).
// ============================================================

import { memo, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, ChevronRight, Tags } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

// ------------------------------------------------------------
//  Response types (mirror src/lib/queries/price-effect.ts + envelope)
// ------------------------------------------------------------
interface PriceEffectItem {
  item: string;
  qtyCurr: number;
  qtyPrev: number;
  nomCurr: number;
  nomPrev: number;
  priceCurr: number | null;
  pricePrev: number | null;
  qtyGrowth: number | null;
  priceGrowth: number | null;
  nomGrowth: number | null;
  qtyEffect: number;
  priceEffect: number;
  netDelta: number;
  priceSharePct: number | null;
  driver: 'PRICE' | 'QTY' | 'MIXED' | 'FLAT';
}

interface PriceEffectSummary {
  hasCompare: boolean;
  matchedItems: number;
  newItems: number;
  goneItems: number;
  newNominal: number;
  goneNominal: number;
  nomCurr: number;
  nomPrev: number;
  netDelta: number;
  qtyEffect: number;
  priceEffect: number;
  priceSharePct: number | null;
  avgPriceChangePct: number | null;
  medianPriceChangePct: number | null;
  itemsPriceUp: number;
  itemsPriceDown: number;
}

interface PriceEffectResponse {
  success: boolean;
  summary: PriceEffectSummary;
  items: PriceEffectItem[];
  durationMs: number;
  cached?: boolean;
  stale?: boolean;
}

// ------------------------------------------------------------
//  Sort modes — which effect dominates the ranking
// ------------------------------------------------------------
type SortMode = 'nominal' | 'price' | 'qty';
const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: 'nominal', label: 'Δ Nominal' },
  { key: 'price', label: 'Efek Harga' },
  { key: 'qty', label: 'Efek Kuantitas' },
];

const DRIVER_BADGE: Record<PriceEffectItem['driver'], { className: string; label: string; title: string }> = {
  PRICE: {
    className: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30',
    label: 'HARGA',
    title: 'Perubahan nominal didominasi efek harga (≥70%) — indikasi tekanan harga, bukan pemborosan operasional',
  },
  QTY: {
    className: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-400 bg-red-50/60 dark:bg-red-950/30',
    label: 'KUANTITAS',
    title: 'Perubahan nominal didominasi efek kuantitas (≥70%) — indikasi perubahan volume deviation, lebih relevan untuk investigasi operasional',
  },
  MIXED: {
    className: 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300 bg-zinc-50/60 dark:bg-zinc-900/30',
    label: 'CAMPURAN',
    title: 'Efek harga dan kuantitas berkontribusi seimbang (30–70%)',
  },
  FLAT: {
    className: 'border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400 bg-zinc-50/40 dark:bg-zinc-900/20',
    label: 'DATAR',
    title: 'Tidak ada perubahan efek yang berarti',
  },
};

/** Signed Rp coloring: positive effect (deviation magnitude growing) = red, negative (improving) = emerald. */
function effectColor(v: number): string {
  if (v > 0) return 'text-red-600 dark:text-red-400';
  if (v < 0) return 'text-emerald-600 dark:text-emerald-400';
  return 'text-muted-foreground';
}

/** Price growth coloring: up = amber (external price pressure), down = emerald. */
function priceGrowthColor(v: number | null): string {
  if (v == null) return 'text-muted-foreground';
  if (v > 0) return 'text-amber-600 dark:text-amber-500';
  if (v < 0) return 'text-emerald-600 dark:text-emerald-400';
  return 'text-muted-foreground';
}

function fmtPctSigned(v: number | null): string {
  return v == null ? '—' : fmtPct(v, true, 1);
}

// ------------------------------------------------------------
//  Summary tile
// ------------------------------------------------------------
function SummaryTile({ label, value, sub, valueCls, bar }: {
  label: string;
  value: string;
  sub?: string;
  valueCls?: string;
  bar?: { priceSharePct: number };
}) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2.5 min-w-0">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`mt-0.5 text-sm font-bold tabular-nums ${valueCls ?? ''}`}>{value}</p>
      {bar && (
        <div className="mt-1.5 h-1.5 w-full rounded-full overflow-hidden flex" aria-hidden>
          <div className="bg-amber-500/80" style={{ width: `${bar.priceSharePct}%` }} />
          <div className="bg-red-500/70 flex-1" />
        </div>
      )}
      {sub && <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  );
}

// ------------------------------------------------------------
//  Main component
// ------------------------------------------------------------
export const PriceEffectCard = memo(function PriceEffectCard() {
  const { monthLabel, currentWeek, comparisonMonth, comparisonWeek, area, kelompok, outletCode, pic, setDeepDiveItem } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    comparisonMonth: s.comparisonMonth,
    comparisonWeek: s.comparisonWeek,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
    setDeepDiveItem: s.setDeepDiveItem,
  })));

  const [sortMode, setSortMode] = useState<SortMode>('nominal');
  // VH-3 (spec §4 L5): the Bennet items table is COLLAPSIBLE — default view
  // is the compact 4-tile summary + domination badge; the full table (and its
  // sort chips) expand on demand (progressive disclosure).
  const [tableOpen, setTableOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['price-effect', monthLabel, currentWeek, comparisonMonth, comparisonWeek, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const month = monthLabel ?? '';
      const week = currentWeek ?? '';
      if (!month || !week) throw new Error('Bulan dan minggu belum dipilih');
      const p = new URLSearchParams();
      p.set('month', month);
      p.set('week', week);
      if (comparisonWeek && comparisonMonth) {
        p.set('compareWeek', comparisonWeek);
        p.set('compareMonth', comparisonMonth);
      }
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode && outletCode !== 'all') p.set('outlet', outletCode);
      if (pic && pic !== 'all') p.set('pic', pic);
      const res = await fetch(`/api/price-effect?${p.toString()}`);
      if (!res.ok) throw new Error('Gagal memuat data efek harga');
      return res.json() as Promise<PriceEffectResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const summary = data?.summary;
  // P3-HYG-7a pattern: pin `items` identity — `data?.items ?? []` creates a
  // new empty array whenever the field is undefined, defeating sortedItems'
  // useMemo below on every render.
  const items = useMemo(() => data?.items ?? [], [data?.items]);

  // Narrowed summary — non-null ONLY when a compare period was supplied
  // and the query returned (avoids non-null assertions in the JSX below).
  const s = summary != null && summary.hasCompare ? summary : null;

  const sortedItems = useMemo(() => {
    const arr = [...items];
    if (sortMode === 'price') arr.sort((a, b) => Math.abs(b.priceEffect) - Math.abs(a.priceEffect));
    else if (sortMode === 'qty') arr.sort((a, b) => Math.abs(b.qtyEffect) - Math.abs(a.qtyEffect));
    // 'nominal' (default) already sorted by |netDelta| from the API
    return arr;
  }, [items, sortMode]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3 border-b">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Tags className="h-3.5 w-3.5" />
          </span>
          AVG Price Effect
          <FormulaInfo
            formula="Δ|Nominal Deviasi| = Efek Kuantitas + Efek Harga (dekomposisi Bennet — eksak, tanpa residual)"
            description="Per item: harga implisit P = Σ|nominalDeviasi| / Σ|qtyDeviasi| (harga nasional dirata-ratakan, teramati melalui baris deviation). Efek Kuantitas = (Qc−Qp) × rata-rata(Pc,Pp). Efek Harga = (Pc−Pp) × rata-rata(Qc,Qp). Jumlah keduanya = Δ Nominal secara eksak. Sesuai Master Context §22/§55: kenaikan nominal deviation tidak boleh langsung dianggap kenaikan deviation operasional sebelum efek harga dipisahkan — item HARGA-dominated mengindikasikan tekanan harga; item KUANTITAS-dominated lebih relevan untuk investigasi operasional. Ini indikasi, bukan bukti root cause."
            example="QTY Deviasi 100→120 pcs, harga implisit Rp10rb→Rp12rb: efek kuantitas 20×Rp11rb = Rp220rb; efek harga Rp2rb×110 = Rp220rb; ΔNominal Rp440rb terbagi persis 50/50."
            side="bottom"
          />
          <InfoTooltip content="Harga implisit dihitung dari data deviation saja — item tanpa deviation di suatu periode tidak punya harga teramati dan masuk kategori item baru/hilang." />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Pemisahan efek harga vs kuantitas atas perubahan |Nominal Deviasi| vs periode pembanding
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {error ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">Gagal memuat data efek harga.</p>
            <p className="mt-1 text-xs text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
          </div>
        ) : isLoading ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[76px] rounded-lg" />)}
            </div>
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : !s ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground/50 mb-3">
              <Tags className="h-6 w-6" />
            </span>
            <p className="text-sm text-muted-foreground">Pilih periode pembanding di filter bar untuk mengaktifkan analisis efek harga vs kuantitas.</p>
            <p className="mt-1 text-xs text-muted-foreground/70">Periode pembanding otomatis = minggu yang sama pada bulan sebelumnya (bila tersedia).</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary tiles (compact default view) */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <SummaryTile
                label="Δ |Nominal Deviasi|"
                value={fmtIDR(s.netDelta)}
                valueCls={effectColor(s.netDelta)}
                sub={`${s.matchedItems} item cocok · ${fmtIDR(s.nomPrev)} → ${fmtIDR(s.nomCurr)}`}
              />
              <SummaryTile
                label="Efek Harga"
                value={fmtIDR(s.priceEffect)}
                valueCls={effectColor(s.priceEffect)}
                bar={s.priceSharePct != null ? { priceSharePct: s.priceSharePct } : undefined}
                sub={s.priceSharePct != null ? `${fmtPct(s.priceSharePct / 100, false, 1)} dari total efek` : 'tidak ada efek'}
              />
              <SummaryTile
                label="Efek Kuantitas"
                value={fmtIDR(s.qtyEffect)}
                valueCls={effectColor(s.qtyEffect)}
                sub={s.priceSharePct != null ? `${fmtPct((100 - s.priceSharePct) / 100, false, 1)} dari total efek` : 'tidak ada efek'}
              />
              <SummaryTile
                label="AVG Price Δ (nasional)"
                value={s.avgPriceChangePct != null ? fmtPctSigned(s.avgPriceChangePct / 100) : '—'}
                valueCls={priceGrowthColor(s.avgPriceChangePct != null ? s.avgPriceChangePct / 100 : null)}
                sub={`median ${s.medianPriceChangePct != null ? fmtPct(s.medianPriceChangePct / 100, false, 1) : '—'} · naik ${s.itemsPriceUp} / turun ${s.itemsPriceDown} item`}
              />
            </div>

            {/* VH-3: domination badge (which effect drives the Δ overall) +
                the collapsible toggle for the per-item Bennet table. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {(() => {
                // Same 70/30 driver thresholds the per-item badges use.
                const ps = s.priceSharePct;
                if (ps == null) {
                  return (
                    <Badge variant="outline" className="text-xs h-6 font-medium border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300 bg-zinc-50/60 dark:bg-zinc-900/30">
                      Belum ada efek teramati
                    </Badge>
                  );
                }
                if (ps >= 70) {
                  return (
                    <Badge variant="outline" className="text-xs h-6 font-medium border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30" title="≥70% dari total efek berasal dari pergerakan harga — tekanan harga, bukan pemborosan operasional">
                      Didominasi HARGA · {fmtPct(ps / 100, false, 0)}
                    </Badge>
                  );
                }
                if (ps <= 30) {
                  return (
                    <Badge variant="outline" className="text-xs h-6 font-medium border-red-300 text-red-700 dark:border-red-800 dark:text-red-400 bg-red-50/60 dark:bg-red-950/30" title="≥70% dari total efek berasal dari perubahan kuantitas deviation — target investigasi operasional">
                      Didominasi KUANTITAS · {fmtPct((100 - ps) / 100, false, 0)}
                    </Badge>
                  );
                }
                return (
                  <Badge variant="outline" className="text-xs h-6 font-medium border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300 bg-zinc-50/60 dark:bg-zinc-900/30" title="Efek harga dan kuantitas berkontribusi seimbang (30–70%)">
                    Campuran Harga/Kuantitas
                  </Badge>
                );
              })()}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() => setTableOpen((v) => !v)}
                aria-expanded={tableOpen}
              >
                {tableOpen ? (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" />
                    Sembunyikan tabel item
                  </>
                ) : (
                  <>
                    <ChevronRight className="h-3.5 w-3.5" />
                    Tabel detail item ({sortedItems.length})
                  </>
                )}
              </Button>
            </div>

            {/* Reconciliation note — items outside the decomposition */}
            {(s.newItems > 0 || s.goneItems > 0) && (
              <p className="text-xs text-muted-foreground">
                Di luar dekomposisi:{' '}
                {s.newItems > 0 && <span className="tabular-nums">{s.newItems} item baru (+{fmtIDR(s.newNominal)})</span>}
                {s.newItems > 0 && s.goneItems > 0 && ' · '}
                {s.goneItems > 0 && <span className="tabular-nums">{s.goneItems} item hilang (−{fmtIDR(s.goneNominal)})</span>}
                {' '}— tidak punya harga teramati di kedua periode.
              </p>
            )}

            {tableOpen && (
              <>
                {/* Sort chips */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">Urutkan</span>
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSortMode(opt.key)}
                      className={`h-6 rounded-full px-2.5 text-xs font-medium border transition-colors ${
                        sortMode === opt.key
                          ? 'bg-foreground text-background border-foreground'
                          : 'bg-background text-muted-foreground border-border hover:bg-muted/40'
                      }`}
                      aria-pressed={sortMode === opt.key}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <span className="ml-auto text-[11px] text-muted-foreground/70">Klik baris untuk drill-down item</span>
                </div>

                {/* Items table — density spec unified (Task R/T): h-8 headers, text-xs cells */}
                <ScrollArea className="h-80">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                      <TableRow className="border-b hover:bg-transparent">
                        <TableHead className="h-8 text-xs font-semibold uppercase tracking-wider">Item</TableHead>
                        <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">QTY Dev Δ</TableHead>
                        <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Avg Price Δ</TableHead>
                        <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Nominal Δ</TableHead>
                        <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Efek Harga</TableHead>
                        <TableHead className="text-right h-8 text-xs font-semibold uppercase tracking-wider">Efek Kuantitas</TableHead>
                        <TableHead className="text-center h-8 text-xs font-semibold uppercase tracking-wider w-28">Dominasi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedItems.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground text-xs py-8">
                            Tidak ada item yang dapat didekomposisi untuk periode ini.
                          </TableCell>
                        </TableRow>
                      ) : sortedItems.map((m) => {
                        const badge = DRIVER_BADGE[m.driver];
                        return (
                          <TableRow
                            key={m.item}
                            className="cursor-pointer hover:bg-muted/40 transition-colors"
                            {...clickableRowProps(() => setDeepDiveItem({ itemName: m.item, outletCode: null }))}
                          >
                            <TableCell className="font-medium text-xs whitespace-normal" title={m.item}>{m.item}</TableCell>
                            <TableCell className={`text-right text-xs tabular-nums ${m.qtyGrowth != null && m.qtyGrowth > 0 ? 'text-red-600 dark:text-red-400' : m.qtyGrowth != null && m.qtyGrowth < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>{fmtPctSigned(m.qtyGrowth)}</TableCell>
                            <TableCell className={`text-right text-xs tabular-nums ${priceGrowthColor(m.priceGrowth)}`}>{fmtPctSigned(m.priceGrowth)}</TableCell>
                            <TableCell className="text-right text-xs font-semibold tabular-nums">{fmtPctSigned(m.nomGrowth)}</TableCell>
                            <TableCell className={`text-right text-xs font-semibold tabular-nums ${effectColor(m.priceEffect)}`} title={m.priceSharePct != null ? `${fmtPct(m.priceSharePct / 100, false, 1)} dari total efek item ini` : undefined}>{fmtIDR(m.priceEffect)}</TableCell>
                            <TableCell className={`text-right text-xs font-semibold tabular-nums ${effectColor(m.qtyEffect)}`}>{fmtIDR(m.qtyEffect)}</TableCell>
                            <TableCell className="text-center">
                              <Badge variant="outline" className={`text-xs h-5 font-medium ${badge.className}`} title={badge.title}>{badge.label}</Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>

                <p className="text-[11px] text-muted-foreground/70">
                  Indikasi awal — bukan bukti root cause. Item KUANTITAS-dominan perlu diperiksa volume pemakaian vs SOC; item HARGA-dominan perlu diperiksa pergerakan harga supplier. Sesuai Master Context §22/§55.
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
