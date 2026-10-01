'use client';

// ============================================================
//  WasteRateLeagueCard — W1 "Liga Waste-Rate (waste ÷ BOM)"
//  --------------------------------------------------------
//  Per-item OUTLET league ranked by the normalized waste rate
//  Σ|qtyWaste| / Σ|qtyBom| over the multi-month same-week window:
//  "outlet mana paling boros pada bahan yang SAMA, secara adil
//  (relatif pemakaiannya, bukan nominal Rp yang bias ke outlet
//  besar)?" — the in-app version of the W1 candidate from
//  findings-DEEPWASTE2-B §2 (top-5 readiness-A #5, the "enabler
//  fondasi" normalization).
//
//  Everything statistical is computed by the PURE builder in
//  src/lib/queries/waste/rate-league.ts (server, /api/waste-
//  rate-league): rate per (item, outlet), within-item rank DESC,
//  median + MAD over the BOM>0 population, robust-z =
//  (rate − median)/(1.4826·MAD), zero-waste share reported
//  SEPARATELY (zero-inflation honesty), min-5-outlet guard. This
//  card only formats + selects the item.
//
//  Self-fetching (/api/waste-rate-league) — MIRRORS the Pareto /
//  Quadrant cards exactly: same filter props (monthLabel/
//  currentWeek/area/kelompok/pic), same query-key conventions +
//  5-min staleTime / 10-min gcTime / keepPreviousData / enabled,
//  same loading/error/empty states (own queryKey — one request
//  per card, not shared with waste-top-items because the league
//  is a different payload).
//
//  Local response types: the tab-level ./types.ts is frozen for
//  this task — the card defines its own additive mirror (the
//  quadrant-card local-type pattern).
//
//  Epistemics (house convention): the RATE is TERUKUR (a direct
//  ratio of recorded quantities — no model); the ranking +
//  robust-z outlier tone is INDIKASI (a statistical pattern, not
//  proof of cause — the action framing is audit/portioning
//  targets, never an accusation).
// ============================================================

import { memo, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trophy, ChevronDown } from 'lucide-react';
import { fmtPct, fmtNum, fmtDecimal } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';

// ------------------------------------------------------------
// Local response mirror (additive-only reading of the route payload)
// ------------------------------------------------------------

interface RateLeagueRow {
  rank: number;
  outletCode: string;
  outletName: string;
  area: string;
  wasteQty: number;
  bomQty: number;
  /** Σ|qtyWaste| / Σ|qtyBom| — unitless share of theoretical usage wasted. */
  rate: number;
  /** (rate − median) / (1.4826·MAD) — null when MAD = 0 (degenerate scale). */
  robustZ: number | null;
}

interface RateLeagueItem {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number;
  wasteQty: number;
  bomQty: number;
  outletsWithBom: number;
  league: RateLeagueRow[] | null;
  leagueOmittedReason: 'MIN_OUTLETS' | 'NO_BOM_BASIS' | null;
  zeroWasteOutlets: number;
  zeroWasteShare: number | null;
  /** #outlets with waste > 0 but BOM = 0 (orphaned waste — not ranked). */
  orphanWasteOutlets: number;
  medianRate: number | null;
  madRate: number | null;
}

interface RateLeagueMeta {
  windowMonths: number;
  minOutlets: number;
  madScale: number;
  rateDefinition: string;
  bomBasis: string;
  zeroWastePolicy: string;
  epistemicLabel: 'INDIKASI';
}

interface WasteRateLeagueResponse {
  success: boolean;
  items?: RateLeagueItem[];
  windowMonths?: number;
  meta?: RateLeagueMeta | null;
  error?: string;
}

// ------------------------------------------------------------
// Formatting helpers (house conventions)
// ------------------------------------------------------------

/** Robust-z tone — mirrors waste-profile-card's zTone (>2 merah, >1 amber). */
function zTone(z: number | null): string {
  if (z == null) return 'text-muted-foreground';
  if (z > 2) return 'text-red-600 dark:text-red-400 font-semibold';
  if (z > 1) return 'text-amber-600 dark:text-amber-400 font-semibold';
  return 'text-foreground';
}

/** Guard-reason copy (Indonesian, mirrors the server's reason codes). */
function omittedReasonText(item: RateLeagueItem, minOutlets: number): string {
  if (item.leagueOmittedReason === 'NO_BOM_BASIS') {
    return 'Liga dihilangkan: tidak ada outlet dengan basis BOM (pemakaian teoretis) untuk bahan ini di scope — waste tercatat tanpa pemakaian tidak bisa dinormalisasi.';
  }
  return `Liga dihilangkan: hanya ${item.outletsWithBom} outlet ber-BOM di scope (guard min. ${minOutlets}) — di bawah itu median/MAD/z adalah aritmetika, bukan bukti.`;
}

// ------------------------------------------------------------
// Card
// ------------------------------------------------------------

export const WasteRateLeagueCard = memo(function WasteRateLeagueCard({
  monthLabel,
  currentWeek,
  area,
  kelompok,
  pic,
}: {
  monthLabel: string;
  currentWeek: string;
  area: string | null;
  kelompok: string | null;
  pic: string | null;
}) {
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [showMethod, setShowMethod] = useState(false);

  const { data, isLoading, error } = useQuery<WasteRateLeagueResponse>({
    queryKey: ['waste-rate-league', monthLabel, currentWeek, area, kelompok, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (area) p.set('area', area);
      if (kelompok) p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/waste-rate-league?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WasteRateLeagueResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const meta = data?.meta ?? null;
  const windowMonths = data?.windowMonths ?? 0;
  const minOutlets = meta?.minOutlets ?? 5;

  // Selection: keep the current item when it survives a filter
  // change, else fall back to #1 (the biggest-waste item — KULIT
  // PANGSIT live). Derived per render — no effect, no stale state.
  const selected = useMemo(() => {
    if (items.length === 0) return null;
    return items.find((i) => i.itemId === selectedItemId) ?? items[0];
  }, [items, selectedItemId]);

  const league = selected?.league ?? null;

  // Zero-waste summary line — read SEPARATELY from the league, per
  // the server's zero-inflation-honesty policy.
  const zeroLine = useMemo(() => {
    if (!selected) return null;
    const parts: string[] = [];
    if (selected.outletsWithBom > 0) {
      parts.push(
        `${selected.zeroWasteOutlets}/${selected.outletsWithBom} outlet ber-BOM tanpa waste tercatat — dibaca terpisah, bukan 0%`,
      );
    }
    if (selected.orphanWasteOutlets > 0) {
      parts.push(`${selected.orphanWasteOutlets} outlet waste tanpa basis BOM (tak dinormalisasi)`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [selected]);

  // Baseline disclosure: the exact median/MAD behind every z in
  // the table (server-computed over the BOM>0 population).
  const baselineLine = useMemo(() => {
    if (!selected || selected.medianRate == null) return null;
    const mad =
      selected.madRate != null
        ? ` · MAD ${fmtPct(selected.madRate, false, 2)} (z = (rate−median)/(1,4826×MAD))`
        : '';
    return `Baseline populasi ${selected.outletsWithBom} outlet ber-BOM: median rate ${fmtPct(selected.medianRate, false, 2)}${mad}`;
  }, [selected]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5 flex-wrap">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Trophy className="h-3.5 w-3.5" />
          </span>
          Liga Waste-Rate (waste ÷ BOM)
          {/* Epistemic labels (house convention): the rate itself is
              TERUKUR (direct ratio, no model); the ranking + z tone is
              INDIKASI (statistical pattern, not cause). */}
          <Badge
            variant="outline"
            className="text-[10px] font-normal h-5 text-emerald-700 dark:text-emerald-400 border-emerald-300/70 dark:border-emerald-800/70 bg-emerald-50/60 dark:bg-emerald-950/30"
            title="Rate = Σ|qtyWaste| / Σ|qtyBom| dihitung langsung dari data window same-week — rasio terukur, bukan model."
          >
            TERUKUR
          </Badge>
          <Badge
            variant="outline"
            className="text-[10px] font-normal h-5 text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30"
            title="Peringkat + robust-z = pola statistik (INDIKASI), bukan bukti penyebab — target audit, bukan tuduhan."
          >
            INDIKASI
          </Badge>
          {/* FormulaInfo house tooltip: the same UNTUK APA / CARA BACA /
              CONTOH / ACTION disclosure as the sibling cards. */}
          <FormulaInfo
            formula="rate = Σ|qtyWaste| / Σ|qtyBom| · robust-z = (rate − median) / (1,4826 × MAD)"
            description={
              'UNTUK APA: perbandingan ADIL lintas outlet untuk bahan yang sama — waste dinormalisasi terhadap pemakaiannya (BOM), bukan nominal Rp yang bias ke outlet besar.\n' +
              'CARA BACA: rate 0,10 = 10% pemakaian teoretis terbuang di outlet itu; median/MAD dihitung atas seluruh outlet ber-BOM di scope; z > 2 merah (jauh di atas typical), z > 1 amber.\n' +
              'CONTOH: waste 10 kg / BOM 100 kg → rate 0,10; median populasi 0,03 & MAD 0,02 → z ≈ 2,36 (merah).\n' +
              'ACTION: outlet di puncak liga = target audit prep/portioning + verifikasi pencatatan (FEFO, ukuran batch).'
            }
            example="rate 0,10 = 10% pemakaian teoretis terbuang"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Outlet mana paling boros pada bahan yang SAMA, relatif terhadap pemakaiannya? Pilih bahan (top Pareto
          waste, default #1) → ranking outlet by rate. Liga hanya memuat outlet dengan waste &gt; 0; outlet tanpa
          waste dilaporkan terpisah. Scope mengikuti filter aktif (nasional default; area/kelompok/PIC bila dipilih).
        </p>
        {items.length > 0 && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            <label className="sr-only" htmlFor="rate-league-item">Pilih bahan untuk liga waste-rate</label>
            <Select
              value={selected ? String(selected.itemId) : undefined}
              onValueChange={(v) => setSelectedItemId(Number(v))}
            >
              <SelectTrigger id="rate-league-item" className="h-8 text-xs w-full max-w-[280px]">
                <SelectValue placeholder="Pilih bahan" />
              </SelectTrigger>
              <SelectContent>
                {items.map((it) => (
                  <SelectItem key={it.itemId} value={String(it.itemId)} className="text-xs">
                    {it.itemName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <Badge variant="secondary" className="text-xs tabular-nums font-medium" title="Σ|qtyWaste| / Σ|qtyBom| item pada window (konteks, bukan peringkat lintas item).">
                Rate item {fmtPct(selected.bomQty > 0 ? selected.wasteQty / selected.bomQty : 0, false, 2)}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat liga waste-rate…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada item waste pada scope ini.</div>
        ) : selected ? (
          <>
            {/* Collapsible methodology block (FormulaInfo content
                convention: UNTUK APA / CARA BACA / CONTOH / ACTION) —
                the tooltip above is hover-only, so the full
                methodology also lives inline for mobile readers. */}
            <div className="px-4 pt-3">
              <button
                type="button"
                onClick={() => setShowMethod((s) => !s)}
                aria-expanded={showMethod}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showMethod ? 'rotate-180' : ''}`} />
                Metodologi &amp; cara baca
              </button>
              {showMethod && (
                <div className="mt-2 rounded-lg border bg-muted/30 dark:bg-zinc-800/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground space-y-1.5">
                  <p>
                    <span className="font-semibold text-foreground/80">UNTUK APA:</span> perbandingan adil lintas
                    outlet untuk bahan yang sama — waste dinormalisasi terhadap pemakaiannya (BOM), bukan nominal Rp
                    yang bias ke outlet besar.
                  </p>
                  <p>
                    <span className="font-semibold text-foreground/80">CARA BACA:</span> rate 0,10 = 10% pemakaian
                    teoretis terbuang pada outlet itu untuk bahan terpilih. Median + MAD dihitung atas seluruh outlet
                    ber-BOM di scope (termasuk outlet tanpa waste — rate 0); robust-z = (rate − median)/(1,4826 × MAD)
                    — tahan outlier; z &gt; 2 merah, z &gt; 1 amber, MAD = 0 → z &ldquo;—&rdquo; (skala degenerate).
                  </p>
                  <p>
                    <span className="font-semibold text-foreground/80">CONTOH:</span> waste 10 kg / BOM 100 kg → rate
                    0,10 (10%); bila median populasi 0,03 dan MAD 0,02 → z ≈ 2,36 (merah).
                  </p>
                  <p>
                    <span className="font-semibold text-foreground/80">ACTION:</span> outlet di puncak liga = target
                    audit prep/portioning + verifikasi pencatatan (FEFO, ukuran batch). Rate tinggi MERATA di banyak
                    outlet = kandidat masalah resep/proses — cek kartu Kuadran Sistemik.
                  </p>
                </div>
              )}
            </div>

            {baselineLine && (
              <p className="px-4 pt-2.5 text-[11px] text-muted-foreground tabular-nums">{baselineLine}</p>
            )}

            {league ? (
              <>
                {/* Long-list convention: max-h-96 overflow-auto
                    (profile-table's CURRENT pattern — see BUGHUNT-R2). */}
                <div className="max-h-96 overflow-auto mt-2">
                  <Table className="min-w-[760px]">
                    <TableCaption className="sr-only">
                      Liga waste-rate outlet untuk {selected.itemName}: peringkat by rate
                      Σ|qtyWaste|/Σ|qtyBom| pada window same-week
                      {windowMonths > 0 ? ` ${windowMonths} bulan` : ''}, dengan robust-z vs median populasi.
                    </TableCaption>
                    <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                      <TableRow className="border-b hover:bg-transparent">
                        <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8 w-10">#</TableHead>
                        <TableHead scope="col" className="text-xs font-semibold uppercase tracking-wider h-8">Outlet</TableHead>
                        <TableHead scope="col" className="text-xs font-semibold uppercase tracking-wider h-8">Area</TableHead>
                        <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Σ|qtyWaste| / Σ|qtyBom| — unitless: porsi pemakaian teoretis yang terbuang.">Rate</TableHead>
                        <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="(rate − median) / (1,4826 × MAD) — outlier-resistant; > 2 merah, > 1 amber; '—' = MAD 0 (skala degenerate).">robust-z</TableHead>
                        <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8" title={`Σ|qtyWaste| window${selected.satuan ? ` (${selected.satuan})` : ''}.`}>QTY Waste</TableHead>
                        <TableHead scope="col" className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Σ|qtyBom| window — pemakaian teoretis (proxy resep).">QTY BOM</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {league.map((r) => (
                        <TableRow key={r.outletCode} className="h-9">
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{r.rank}</TableCell>
                          <TableCell className="text-xs font-medium max-w-[240px]">
                            <span className="block truncate" title={`${r.outletCode} · ${r.outletName} · ${r.area}`}>
                              {r.outletCode} <span className="text-muted-foreground font-normal">· {r.outletName}</span>
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.area}</TableCell>
                          <TableCell className={`text-right text-xs tabular-nums ${r.robustZ != null && r.robustZ > 2 ? 'text-red-600 dark:text-red-400 font-semibold' : r.robustZ != null && r.robustZ > 1 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>
                            {fmtPct(r.rate, false, 2)}
                          </TableCell>
                          <TableCell className={`text-right text-xs tabular-nums ${zTone(r.robustZ)}`}>
                            {r.robustZ != null ? fmtDecimal(r.robustZ, 2) : '—'}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">
                            {/* FIX (UIUX-C S2): leading space in the unit arg — fmtNum fuses
                                compact suffix + unit ("1,53JtGR" reads as milligram). */}
                            {fmtNum(r.wasteQty, selected.satuan ? ` ${selected.satuan}` : '')}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                            {fmtNum(r.bomQty, selected.satuan ? ` ${selected.satuan}` : '')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : (
              <div className="m-4 rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
                {omittedReasonText(selected, minOutlets)}
              </div>
            )}

            {zeroLine && (
              <p className="px-4 pt-2.5 pb-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/70">Zero-inflation:</span> {zeroLine}
                {selected.zeroWasteShare != null && selected.outletsWithBom > 0 && (
                  <span className="tabular-nums"> ({fmtPct(selected.zeroWasteShare, false, 1)})</span>
                )}
              </p>
            )}

            <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
              Window {windowMonths > 0 ? `${windowMonths} bulan` : '—'} same-week (maks. 12) — minggu bersifat
              kumulatif, perbandingan antar bulan hanya valid pada minggu yang sama. Basis BOM = pemakaian teoretis
              (proxy resep), bukan pemakaian aktual (POS); rate 0,10 = 10% pemakaian teoretis terbuang. Liga =
              outlet dengan waste &gt; 0 (≥ {minOutlets} outlet ber-BOM); satuan per bahan: {selected.satuan || '—'}.
              Peringkat + z = INDIKASI — validasi sebelum aksi.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
});
