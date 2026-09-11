'use client';

// ============================================================
//  TopGrowthCard — "Top Growth (Resto & Barang)"
//  --------------------------------------------------------
//  Task H-2c (CHANGE 6): Top movers of nominal SALES vs the compare
//  period, toggleable between two grains:
//    - Per Resto  → data.topGrowth.byOutlet (group o.name)
//    - Per Barang → data.topGrowth.byItem   (group i.name)
//
//  Data comes from the /api/analysis payload (`topGrowth`, computed
//  by queryTopGrowth) — same compare-period semantics as
//  GrowthComparison: auto = same weekLabel in the previous month, or
//  the user's explicit compare period. No separate fetch, no separate
//  cache — it rides the 30-min cache / SWR / background-recompute
//  envelope of the analysis payload.
//
//  Sign convention (sacred): delta = curr − prev. Sales UP = good →
//  emerald (growthColor with inverse=false — NOT growthColorClass,
//  which is the up-is-bad variant used for deviation metrics).
//
//  Display-only v1 — no click-through.
//
//  Loading note: page.tsx gates the whole tab tree on `analysis.data`
//  (LoadingState), so this card only ever renders with a resolved
//  payload. `data.topGrowth` being undefined (payload cached before
//  the field existed) renders a tidy empty state instead of crashing.
// ============================================================

import { memo, useCallback, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RefreshCw, TrendingUp } from 'lucide-react';
import { fmtGrowth, growthColor } from '@/lib/format';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import type { AnalysisData } from '@/hooks/useAnalysis';
import type { TopGrowthRow } from '@/lib/queries/growth-drivers';

/** Server caps each list at 15 rows (queryTopGrowth); the card shows the top 10. */
const DISPLAY_LIMIT = 10;

type Grain = 'outlet' | 'item';

// ------------------------------------------------------------
//  Formatting — compact signed nominal delta, mirrored verbatim
//  from GrowthComparison.tsx formatDelta so the two growth sections
//  (same tab, adjacent sections) read identically.
// ------------------------------------------------------------
function formatDelta(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}M`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
  return v.toFixed(0);
}

function formatDeltaSigned(v: number): string {
  // Negative sign is already emitted by formatDelta; only append "+".
  return v > 0 ? `+${formatDelta(v)}` : formatDelta(v);
}

/** Shared empty-state block (icon + copy) — pattern from GrowthComparison. */
function GrowthEmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

// ------------------------------------------------------------
//  FIX (TASK H-3): old-cache empty state is now ACTIONABLE. The passive
//  "tunggu recompute background" copy was useless — pre-H-3, a pre-deploy
//  cache row was served as a FRESH hit (no recompute ever triggered), and
//  refreshing only re-hit the same server row. With the H-3 server fix
//  (payload-schema versioning in the cache key) this branch is effectively
//  unreachable, but the button guarantees recovery even if it somehow
//  appears: it triggers the full refresh flow (server cache clear +
//  client refetch) instead of asking the user to wait.
// ------------------------------------------------------------
function StalePayloadEmptyState({ onRefresh }: { onRefresh?: () => void }) {
  const [requested, setRequested] = useState(false);

  const handleClick = useCallback(() => {
    if (requested) return;
    setRequested(true);
    onRefresh?.();
    // Re-arm after 2 minutes in case the recompute failed. The success path
    // never lands here: the refreshed payload contains topGrowth, so this
    // whole branch unmounts. (setState-after-unmount is a no-op in React 18+.)
    window.setTimeout(() => setRequested(false), 120_000);
  }, [onRefresh, requested]);

  return (
    <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
      <TrendingUp className="h-8 w-8 text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">
        Data Top Growth belum ada di payload lama (cache sebelum pembaruan).
        {onRefresh ? ' Hitung ulang data analisis untuk memuatnya.' : ' Muat ulang halaman setelah beberapa saat.'}
      </p>
      {onRefresh ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleClick}
          disabled={requested}
          className="h-8 gap-1.5 text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${requested ? 'animate-spin' : ''}`} />
          {requested ? 'Menghitung ulang…' : 'Hitung Ulang Data Analisis'}
        </Button>
      ) : null}
    </div>
  );
}

export const TopGrowthCard = memo(function TopGrowthCard({
  data,
  onRefresh,
}: {
  data: AnalysisData;
  /** TASK H-3: full refresh flow (server cache clear + client refetch) — used by the stale-payload recovery button. */
  onRefresh?: () => void;
}) {
  const [grain, setGrain] = useState<Grain>('outlet');

  // Pin field identities first (P3-HYG-7a lesson) so the useMemo below
  // isn't defeated by fresh fallback arrays on every render.
  const topGrowth = data.topGrowth;
  const byOutlet = topGrowth?.byOutlet;
  const byItem = topGrowth?.byItem;

  // Derived display list — MUST be memoized (audit D-b lesson: never
  // recompute inline per render). Deps are stable references under
  // TanStack Query structural sharing.
  const rows = useMemo<TopGrowthRow[]>(() => {
    const list = grain === 'outlet' ? byOutlet : byItem;
    return list ? list.slice(0, DISPLAY_LIMIT) : [];
  }, [grain, byOutlet, byItem]);

  // Compare-period label — same conditional as GrowthComparison's subtitle
  // (append comparisonMonth only when it differs from the current month).
  const { monthLabel, weekLabel, comparisonWeek, comparisonMonth } = data.period;
  const compareLabel = comparisonWeek
    ? `${comparisonWeek}${comparisonMonth && comparisonMonth !== monthLabel ? ` ${comparisonMonth}` : ''}`
    : null;

  const grainNoun = grain === 'outlet' ? 'resto' : 'barang';

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/50 dark:bg-zinc-800/50 text-muted-foreground shrink-0">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          Top Growth
          <FormulaInfo
            formula="ΔSales = Σ Sales periode ini − Σ Sales periode pembanding"
            description={
              'UNTUK APA: melihat resto / barang dengan pergerakan Sales (nominal) terbesar vs periode pembanding — minggu yang sama di bulan sebelumnya (otomatis), atau pembanding yang dipilih.\n' +
              'CARA BACA: Δ = Sales sekarang − Sales pembanding (bertanda; naik = emerald, turun = merah). % = Δ / |Sales pembanding| — tidak bisa dihitung saat base pembanding nol, ditampilkan sebagai badge "Baru". Ranking berdasar |Δ|; perubahan < Rp1.000 disaring sebagai noise. Server meranking 15, kartu menampilkan 10 teratas.\n' +
              'CONTOH: Sales 5,3Jt → 7,4Jt: Δ = +2,1Jt, % = +39,6%.'
            }
            side="bottom"
          />
          <InfoTooltip content="Naik = baik (Sales bertambah). Badge 'Baru' = tidak ada Sales di periode pembanding (base nol) — tetap diranking berdasar |Δ|. V1: display only, tanpa drill-down." />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9 tabular-nums">
          Sales {weekLabel} {monthLabel} vs {compareLabel ?? 'periode sebelumnya'} — ranking |Δ| nominal
        </p>
      </CardHeader>
      <CardContent>
        {/* Grain toggle — pattern from RestoAnalysis.tsx (TabsList grid-cols-2/3),
            state kept local: switching grain must not re-render sibling sections. */}
        <Tabs value={grain} onValueChange={(v) => setGrain(v === 'item' ? 'item' : 'outlet')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="outlet" className="text-xs">Per Resto</TabsTrigger>
            <TabsTrigger value="item" className="text-xs">Per Barang</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Payload predates the field (old cache entry) — ACTIONABLE recovery
            since TASK H-3: the button clears the server cache + refetches, so
            the next payload contains topGrowth and this branch unmounts. */}
        {!topGrowth ? (
          <StalePayloadEmptyState onRefresh={onRefresh} />
        ) : !comparisonWeek ? (
          // Mirrors GrowthComparison's no-compare-period branch — without a
          // compare period every group would be "Baru" (base nol), which is
          // top-sales, not growth.
          <GrowthEmptyState text="Tidak ada data periode pembanding. Upload beberapa minggu untuk mengaktifkan analisis growth." />
        ) : rows.length === 0 ? (
          <GrowthEmptyState text={`Tidak ada ${grainNoun} dengan perubahan Sales signifikan (|Δ| ≥ Rp1.000) vs periode pembanding.`} />
        ) : (
          <div className="mt-3 max-h-[420px] overflow-y-auto pr-1">
            <ul className="space-y-0.5">
              {rows.map((r, i) => (
                <li
                  key={r.name}
                  className="flex items-center gap-2 text-xs py-1.5 border-b border-border/40 last:border-0 last:pb-0"
                >
                  <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="flex-1 min-w-0 truncate font-medium" title={r.name}>{r.name}</span>
                  {/* Signed nominal delta — colored via growthColor (inverse=false):
                      SALES naik = baik → emerald. */}
                  <span className={`w-16 shrink-0 text-right tabular-nums font-semibold ${growthColor(r.delta)}`}>
                    {formatDeltaSigned(r.delta)}
                  </span>
                  {/* Signed pct — or "Baru" badge when there is no prev base. */}
                  <span className="w-16 shrink-0 text-right">
                    {r.isNew ? (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 text-[10px] font-medium border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
                        title="Tidak ada Sales di periode pembanding (base nol) — % tidak dapat dihitung"
                      >
                        Baru
                      </Badge>
                    ) : (
                      <span className={`tabular-nums ${growthColor(r.pct)}`}>{fmtGrowth(r.pct)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground/60">
              Top {rows.length} dari maksimal 15 mover terbesar per {grainNoun} · |Δ| ≥ Rp1.000
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
