'use client';

// ============================================================
//  ChangeItemTable — item attribution drill (CHANGE-1 / DESIGN-1)
//  --------------------------------------------------------
//  Rendered INLINE under a "Perubahan" lens row when the row is
//  expanded: "item apa yang buat resto ini menyimpang?"
//    - Ide 1 (spine): items sorted by |Δ nominal| with a swing-share
//      "Kontribusi" column — the big movers of THIS period's move.
//    - Ide 2 (badge): items moving ≥ threshold × their OWN average
//      move get the ANOMALI badge (small-but-out-of-character items
//      surface; big-but-habitual items do not).
//    - Ide 3 (toggle): "Hanya arah melawan resto" filters to items
//      whose move OPPOSES the outlet's net move — the cancellers
//      hidden behind a small net number.
//  Fetch is EXPANSION-GATED (the component only mounts when the row
//  is expanded) and cached by React Query — same lens-gated pattern
//  as the Peluang Rp lens.
// ============================================================

import { memo, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RotateCcw } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtIDR, fmtNum, fmtPct, fmtFullSigned, fmtDecimal, growthColorClass } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';

// ------------------------------------------------------------
//  Response types (UI-side mirror of the API payload — decoupled
//  from the server module on purpose, same convention as
//  BenchmarkOpportunityResponse in the Peer tab card).
// ------------------------------------------------------------
export interface ChangeOutletStat {
  outletCode: string;
  outletName: string;
  area: string | null;
  pairs: number;
  hasCurrent: boolean;
  avgSwingNominal: number;
  avgSwingQty: number;
  avgPctNominal: number | null;
  deltaNominal: number | null;
  deltaQty: number | null;
  deltaPctNominal: number | null;
  swingNominal: number | null;
  swingQty: number | null;
  ratioNominal: number | null;
  ratioQty: number | null;
  isFlip: boolean;
  isNew: boolean;
  status: 'ANOMALI' | 'BARU_BERGERAK' | 'NORMAL' | 'DATA_KURANG';
}

export interface ChangeItemStat {
  itemName: string;
  satuan: string | null;
  pairs: number;
  avgSwingNominal: number;
  avgSwingQty: number;
  deltaNominal: number | null;
  deltaQty: number | null;
  deltaPctNominal: number | null;
  swingNominal: number | null;
  ratioNominal: number | null;
  ratioQty: number | null;
  isFlip: boolean;
  isNew: boolean;
  isAnomali: boolean;
  opposesOutlet: boolean;
  contributionPct: number | null;
}

export interface ChangeAnalysisItemsResponse {
  success: boolean;
  error?: string;
  period: { month: string; week: string | null };
  outlet: ChangeOutletStat | null;
  items: ChangeItemStat[];
}

/** Outlet-level response of /api/change-analysis (the lens "Perubahan" list). */
export interface ChangeAnalysisResponse {
  success: boolean;
  error?: string;
  period: { month: string; week: string | null };
  thresholds?: { ratioThreshold: number; minPairs: number; minNominal: number };
  counts: { ranked: number; anomali: number; baruBergerak: number; dataKurang: number };
  outlets: ChangeOutletStat[];
}

/** Signed Rp with an explicit "+" for positive deltas (+ = membesar/memburuk). */
function fmtSignedIDR(v: number | null | undefined): string {
  const s = fmtIDR(v, true);
  if (v != null && v > 0 && !s.startsWith('-')) return `+${s}`;
  return s;
}

/** Status chip reused per row (ANOMALI / BARU). */
function StatusChip({ label, tone }: { label: string; tone: 'red' | 'amber' }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-medium leading-4 ${
        tone === 'red'
          ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400'
          : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400'
      }`}
    >
      {label}
    </span>
  );
}

export const ChangeItemTable = memo(function ChangeItemTable({
  outletCode,
  outletName,
  monthLabel,
  week,
  kelompok,
  onOpenResto,
}: {
  outletCode: string;
  outletName: string;
  monthLabel: string | null;
  week: string | null;
  kelompok: string | null;
  onOpenResto: () => void;
}) {
  const [onlyOpposing, setOnlyOpposing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<ChangeAnalysisItemsResponse>({
    queryKey: ['change-analysis', 'items', outletCode, monthLabel, week, kelompok],
    queryFn: async () => {
      if (!monthLabel || !week) throw new Error('Periode belum dipilih');
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', week);
      p.set('outletCode', outletCode);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      const res = await fetch(`/api/change-analysis/items?${p.toString()}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Server error');
      return res.json() as Promise<ChangeAnalysisItemsResponse>;
    },
    enabled: Boolean(outletCode && monthLabel && week),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const outlet = data?.outlet ?? null;
  const visible = useMemo(
    () => (onlyOpposing ? items.filter((i) => i.opposesOutlet) : items),
    [items, onlyOpposing],
  );
  const opposingCount = useMemo(() => items.filter((i) => i.opposesOutlet).length, [items]);

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      {/* Header — outlet context + the Navigation Bridge to the Resto tab. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold leading-tight">Item penggerak — {outletName}</p>
          {outlet && outlet.deltaNominal != null && (
            <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums" title="Δ resto vs kebiasaan geraknya (same-week)">
              Δ resto {fmtSignedIDR(outlet.deltaNominal)} · gerak biasa ±{fmtIDR(outlet.avgSwingNominal)} ·{' '}
              {outlet.ratioNominal != null ? `${fmtDecimal(outlet.ratioNominal, 1)}× kebiasaannya` : outlet.status === 'BARU_BERGERAK' ? 'mulai bergerak (riwayat datar)' : '—'}
              {outlet.isFlip ? ' · ↺ arah berbalik' : ''}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={onOpenResto}>
          Buka Tab Resto
        </Button>
      </div>

      {/* Ide 3 toggle — surface the cancellers (moves opposing the outlet's net move). */}
      <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Tampilkan hanya item yang bergerak melawan arah resto (pergerakan saling meniadakan yang tertutup angka net)">
        <Checkbox
          checked={onlyOpposing}
          onCheckedChange={(v) => setOnlyOpposing(v === true)}
          aria-label="Hanya arah melawan resto"
        />
        Hanya arah melawan resto{opposingCount > 0 ? ` (${opposingCount})` : ''}
        <InfoTooltip content="Item yang bergerak berlawanan dengan arah resto — mis. waste memburuk +8Jt tapi susut membaik −6Jt tertutup net +2Jt. Aktifkan untuk melihat pergerakan yang saling meniadakan." />
      </label>

      {isLoading ? (
        <div className="space-y-1.5" aria-busy>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 rounded bg-muted animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="py-3 text-center space-y-2">
          <p className="text-xs text-red-600 dark:text-red-400">Gagal memuat rincian item.</p>
          <Button onClick={() => refetch()} variant="outline" size="sm">
            <RotateCcw className="h-3.5 w-3.5" /> Coba Lagi
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-3 text-center text-xs text-muted-foreground">
          {onlyOpposing
            ? 'Tidak ada item yang bergerak melawan arah resto.'
            : 'Tidak ada perubahan item pada periode ini.'}
        </p>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 text-xs">Item</TableHead>
                <TableHead className="h-8 text-xs text-right">Δ Qty</TableHead>
                <TableHead className="h-8 text-xs text-right">Δ Nominal</TableHead>
                <TableHead className="h-8 text-xs text-right">Kontribusi</TableHead>
                <TableHead className="h-8 text-xs text-right">Rasio</TableHead>
                <TableHead className="h-8 text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((it) => (
                <TableRow key={it.itemName} className={it.isAnomali ? 'bg-red-50/60 dark:bg-red-950/20' : undefined}>
                  <TableCell className="py-1.5 text-xs font-medium">
                    <span title={it.itemName}>{it.itemName}</span>
                    {it.satuan ? <span className="ml-1 text-[10px] font-normal text-muted-foreground">({it.satuan})</span> : null}
                    {it.opposesOutlet ? <span className="ml-1 text-[10px] font-normal text-muted-foreground" title="Bergerak melawan arah resto">⇄</span> : null}
                  </TableCell>
                  <TableCell className={`py-1.5 text-right text-xs tabular-nums ${growthColorClass(it.deltaQty)}`}>
                    {fmtFullSigned(it.deltaQty ?? 0)}
                  </TableCell>
                  <TableCell className={`py-1.5 text-right text-xs tabular-nums ${growthColorClass(it.deltaNominal)}`} title={it.isFlip ? 'Arah LOSS↔SURPLUS berbalik dari periode lalu' : undefined}>
                    {fmtSignedIDR(it.deltaNominal)}{it.isFlip ? ' ↺' : ''}
                  </TableCell>
                  <TableCell className="py-1.5 text-right text-xs tabular-nums">
                    {it.contributionPct != null ? fmtPct(it.contributionPct / 100, false, 0) : '—'}
                  </TableCell>
                  <TableCell className="py-1.5 text-right text-xs tabular-nums" title={it.avgSwingNominal > 0 ? `Gerak biasa ±${fmtIDR(it.avgSwingNominal)}` : 'Riwayat gerak datar / kurang'}>
                    {it.ratioNominal != null ? `${fmtDecimal(it.ratioNominal, 1)}×` : '—'}
                  </TableCell>
                  <TableCell className="py-1.5 text-xs">
                    {it.isAnomali ? (
                      <StatusChip label="ANOMALI" tone="red" />
                    ) : it.isNew ? (
                      <StatusChip label="BARU" tone="amber" />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Footnote — semantics reminder (compact, one line). */}
      <p className="text-[10px] text-muted-foreground border-t pt-1.5">
        Δ per periode same-week ({week ?? '—'}) · + = deviasi membesar (memburuk), − = mengecil (membaik) · Rasio = gerak sekarang ÷ rata-rata gerak item itu sendiri · Kontribusi = porsi |Δ| terhadap total gerak resto.
      </p>
    </div>
  );
});
