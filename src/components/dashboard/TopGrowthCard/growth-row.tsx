'use client';

// ============================================================
//  TopGrowthCard — GrowthRow (TASK H-5 accordion row)
//  (split from TopGrowthCard.tsx — SPLIT-G; pure code motion)
//
//  One list row: the accordion button (rank, chevron, name,
//  Δ nominal signed, Δ pct / "Baru" badge) + the drill-down
//  panel (top sub-grain contributors, row-level link-out,
//  reading footnote). Data rides the /api/analysis payload —
//  the panel only mounts when open (cheap + keeps DOM small).
// ============================================================

import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Dispatch } from 'react';
import { fmtPct, growthColor } from '@/lib/format';
import type { TopGrowthContributor, TopGrowthRow } from '@/lib/queries/growth-drivers';
import { formatDeltaSigned, type Grain } from './format';
import { ContributorHeader, ContributorLine } from './contributor';

export interface GrowthRowProps {
  r: TopGrowthRow;
  index: number;
  isOpen: boolean;
  grain: Grain;
  grainNoun: string;
  childNoun: string;
  contributorLimit: number;
  // (The three handler props are spelled as Dispatch<T> = (value: T) => void
  //  instead of writing param names — the repo's base no-unused-vars rule
  //  flags type-position parameter names as unused.)
  onToggle: Dispatch<string>;
  onContributorClick: Dispatch<TopGrowthContributor>;
  onRowLink: Dispatch<TopGrowthRow>;
}

export function GrowthRow({
  r,
  index,
  isOpen,
  grain,
  grainNoun,
  childNoun,
  contributorLimit,
  onToggle,
  onContributorClick,
  onRowLink,
}: GrowthRowProps) {
  const panelId = `topgrowth-contrib-${index}`;
  return (
    <li className="border-b border-border/40 last:border-0 last:pb-0">
      {/* TASK H-5: the row itself is a button — keyboard-focusable,
          aria-expanded, single-open accordion. 44px-ish touch
          target via py-2 on the button. */}
      <button
        type="button"
        onClick={() => onToggle(r.name)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 rounded-md py-2 text-xs text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{index + 1}</span>
        {/* Chevron — right when closed, rotates down when open. */}
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        )}
        <span className="flex-1 min-w-0 truncate font-medium" title={r.name}>{r.name}</span>
        {/* Signed nominal delta (Rp compact) — colored via
            growthColor (inverse=false): Δ>0 = toward SURPLUS /
            less loss → emerald; Δ<0 = toward LOSS → red. TASK
            H-7: the metric is the SAME for both grains. */}
        <span className={`w-20 shrink-0 text-right tabular-nums font-semibold ${growthColor(r.delta)}`}>
          {formatDeltaSigned(r.delta)}
        </span>
        {/* Signed pct — or "Baru" badge when there is no prev base. */}
        <span className="w-16 shrink-0 text-right">
          {r.isNew ? (
            <Badge
              variant="outline"
              className="h-5 px-1.5 text-[10px] font-medium border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
              title="Tidak ada nominal deviasi di periode pembanding (base nol) — % tidak dapat dihitung"
            >
              Baru
            </Badge>
          ) : (
            <span className={`tabular-nums ${growthColor(r.pct)}`}>{fmtPct(r.pct, true, 1)}</span>
          )}
        </span>
      </button>

      {/* TASK H-5: drill-down panel — top sub-grain movers driving
          this row's Δ. Data rides the payload (no fetch); the
          panel only mounts when open (cheap + keeps DOM small).
          TASK H-7: contributors are ranked by |Δ kuantiti
          deviasi| and ALSO show Δ nominal (Rp) — volume and
          value side by side, labeled by the column header. */}
      {isOpen ? (
        <div id={panelId} className="mb-1 ml-9 border-l-2 border-border/60 pl-2">
          <p className="py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {childNoun === 'barang' ? 'Barang' : 'Resto'} — Δ kuantiti deviasi terbesar (top {contributorLimit})
          </p>
          {r.contributors.length > 0 ? (
            <>
              <ContributorHeader />
              {r.contributors.map((c) => (
                <ContributorLine
                  key={c.name}
                  c={c}
                  onClick={
                    // NAVLINK-1 (B1): barang always links (item-name
                    // identity); resto links only when its code rode
                    // the payload (old caches → undefined → no link).
                    grain === 'outlet' || c.code
                      ? () => onContributorClick(c)
                      : undefined
                  }
                />
              ))}
            </>
          ) : (
            <p className="py-1 text-[11px] italic text-muted-foreground/60">
              Tidak ada {childNoun} dengan pergerakan deviasi di {grainNoun} ini.
            </p>
          )}
          {/* NAVLINK-1 (B1): row-level link-out — the expanded row's
              OWN entity, not just its contributors. Item row →
              Trend Item; outlet row → Resto deep dive (needs code). */}
          {grain === 'item' || r.code ? (
            <button
              type="button"
              onClick={() => onRowLink(r)}
              className="mt-1 inline-flex items-center gap-1 rounded-sm text-[10px] font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {grain === 'item' ? 'Trend item ini →' : 'Buka resto ini →'}
            </button>
          ) : null}
          <p className="pb-1 text-[10px] italic text-muted-foreground/55">
            Δ kuantiti = pergerakan volume (satuan); Δ nominal = pergerakan nilai (Rp). Kuantiti tetap
            dengan nominal bergerak = efek harga.
          </p>
        </div>
      ) : null}
    </li>
  );
}
