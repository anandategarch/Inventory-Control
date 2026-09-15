'use client';

// ============================================================
//  OutletPriorityPanel — compact row view (+ pulse placeholder)
//  (split from OutletPriorityPanel.tsx — SPLIT-G; pure code motion)
//
//  One normalized row: rank badge, outlet name, meta line with
//  the ANA-1-D / CHANGE-1 chips (recurrence, trend, ANOMALI,
//  BARU GERAK, flip), the main number + sub-caption, the
//  proportional mini-bar, and (Perubahan lens) the inline
//  ChangeItemTable expansion.
// ============================================================

import { Fragment } from 'react';
import type { Dispatch } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';
import { ChangeItemTable } from '@/components/dashboard/narrative/ChangeItemTable';
import { recurrenceTitle, type CompactRow, type Lens } from './lens-model';

/** Small pulse placeholder row (loading state — mirrors the old card's). */
export function PulseRow() {
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg border p-3">
      <span className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3.5 w-32 bg-muted rounded animate-pulse" />
        <div className="h-2.5 w-20 bg-muted rounded animate-pulse" />
      </div>
      <div className="h-4 w-14 bg-muted rounded animate-pulse shrink-0" />
    </div>
  );
}

export interface CompactRowViewProps {
  r: CompactRow;
  index: number;
  lens: Lens;
  maxValue: number;
  /** Perubahan lens: the currently inline-expanded outlet (CHANGE-1). */
  expandedOutlet: string | null;
  monthLabel: string | null;
  currentWeek: string | null;
  kelompok: string | null;
  // (Handler props spelled as Dispatch<T> = (value: T) => void instead of
  //  writing param names — the repo's base no-unused-vars rule flags
  //  type-position parameter names as unused.)
  onRowClick: Dispatch<CompactRow>;
  onOpenResto: Dispatch<string>;
}

export function CompactRowView({
  r,
  index,
  lens,
  maxValue,
  expandedOutlet,
  monthLabel,
  currentWeek,
  kelompok,
  onRowClick,
  onOpenResto,
}: CompactRowViewProps) {
  return (
    <Fragment>
      <div
        className="min-h-11 rounded-lg border bg-card p-3 cursor-pointer transition-colors hover:bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        {...clickableRowProps(() => onRowClick(r))}
        aria-expanded={lens === 'perubahan' ? expandedOutlet === r.outletCode : undefined}
        title={lens === 'perubahan' ? 'Klik untuk lihat item penggerak resto ini' : 'Klik untuk buka analisa resto ini'}
      >
        <div className="flex items-center gap-3">
          {/* Rank badge — round; #1 inverted (matches ItemPriorityPanel). */}
          <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 tabular-nums ${
            index === 0 ? 'bg-foreground text-background' : 'border bg-muted/50 text-muted-foreground'
          }`}>
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight truncate" title={r.outletName}>{r.outletName}</p>
            {/* Meta line + ANA-1-D chips (carried from the old card — the
                text <p> truncates first so the small chips stay visible
                at 375px without breaking row rhythm). */}
            <div className="mt-0.5 flex min-w-0 items-center gap-1">
              <p className="text-xs text-muted-foreground truncate">{r.area} · {r.outletCode}</p>
              {/* Recurrence chip — hidden when STABIL, when no historical
                  month exists, or when `history` is absent (payload cached
                  before the field was added). */}
              {r.history && r.history.periodCount > 0 && r.history.classification !== 'STABIL' && (
                <span
                  className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-medium leading-4 ${
                    r.history.classification === 'REKUREN'
                      ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400'
                      : 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
                  }`}
                  title={recurrenceTitle(r.history)}
                >
                  {/* sr-only: readable form of the "⟳ x/y bln" glyph text */}
                  <span className="sr-only">Bermasalah di {r.history.abnormalCount} dari {r.history.periodCount} bulan sebelumnya</span>
                  <span aria-hidden>⟳ {r.history.abnormalCount}/{r.history.periodCount} bln</span>
                </span>
              )}
              {/* Trend chip — pure frontend, rides the existing
                  signals.trendDeteriorating field (no API change). */}
              {r.trendDeteriorating && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-red-300 px-1.5 py-px text-[10px] font-medium leading-4 text-red-600 dark:border-red-800 dark:text-red-400"
                  title="Nominal deviasi naik >20% dibanding periode sebelumnya atau rata-rata historis (same-week)"
                >
                  ↗ Memburuk
                </span>
              )}
              {/* CHANGE-1 chips (Perubahan lens only). */}
              {r.status === 'ANOMALI' && (
                <span
                  className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-red-300 bg-red-50 px-1.5 py-px text-[10px] font-medium leading-4 text-red-600 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400"
                  title="Bergerak jauh di atas kebiasaannya sendiri (rasio di atas ambang anomali)"
                >
                  ANOMALI
                </span>
              )}
              {r.status === 'BARU_BERGERAK' && (
                <span
                  className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-[10px] font-medium leading-4 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400"
                  title="Riwayat geraknya datar — periode ini mulai bergerak"
                >
                  BARU GERAK
                </span>
              )}
              {r.isFlip && (
                <span
                  className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-zinc-300 bg-zinc-100 px-1.5 py-px text-[10px] font-medium leading-4 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                  title="Arah deviasi berbalik (LOSS ↔ SURPLUS) dari periode lalu"
                >
                  ↺
                </span>
              )}
            </div>
          </div>
          {/* Main number + lens-specific sub-caption. */}
          <div className="shrink-0 text-right">
            <span className={`text-sm font-bold tabular-nums ${r.valueCls}`}>{r.valueLabel}</span>
            <p className="text-[10px] text-muted-foreground tabular-nums truncate max-w-[150px]" title={r.subLabel}>{r.subLabel}</p>
          </div>
          {/* CHANGE-1: expand affordance (Perubahan lens). */}
          {lens === 'perubahan' && (
            <span className="shrink-0 text-muted-foreground" aria-hidden>
              {expandedOutlet === r.outletCode
                ? <ChevronDown className="h-4 w-4" />
                : <ChevronRight className="h-4 w-4" />}
            </span>
          )}
        </div>
        {/* Proportional mini-bar — value relative to the top row. */}
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className={`h-full ${r.barCls}`} style={{ width: `${maxValue > 0 ? Math.min(100, (r.magnitude / maxValue) * 100) : 0}%` }} />
        </div>
      </div>
      {/* CHANGE-1: Perubahan lens — inline item attribution (expansion-gated fetch). */}
      {lens === 'perubahan' && expandedOutlet === r.outletCode && (
        <ChangeItemTable
          outletCode={r.outletCode}
          outletName={r.outletName}
          monthLabel={monthLabel}
          week={currentWeek}
          kelompok={kelompok}
          onOpenResto={() => onOpenResto(r.outletCode)}
        />
      )}
    </Fragment>
  );
}
