'use client';

// ============================================================
//  TopGrowthCard — drill-down contributor lines (TASK H-5 / H-7)
//  (split from TopGrowthCard.tsx — SPLIT-G; pure code motion)
//
//  One contributor line inside an expanded row. TWO delta
//  columns side by side (volume AND value — "kuantiti deviasi
//  dan ada nominal juga"):
//    - Δ kuantiti deviasi (signed, satuan barang) — the drill-down's
//      RANKING metric, bold.
//    - Δ nominal deviasi (signed, Rp) — the value movement.
//  "Baru" rides inline after the name when the contributor has no
//  deviation base of either kind in the compare period. A mini header
//  row (ContributorHeader) labels the two columns.
// ============================================================

import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { growthColor } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';
import type { TopGrowthContributor } from '@/lib/queries/growth-drivers';
import { formatDeltaSigned, formatQtySigned } from './format';

const CONTRIBUTOR_QTY_COL = 'w-24';
const CONTRIBUTOR_RP_COL = 'w-20';

export function ContributorHeader() {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
      <span className="w-1.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0" />
      <span className={`${CONTRIBUTOR_QTY_COL} shrink-0 text-right`}>Δ kuantiti</span>
      <span className={`${CONTRIBUTOR_RP_COL} shrink-0 text-right`}>Δ nominal</span>
    </div>
  );
}

export const ContributorLine = memo(function ContributorLine({
  c,
  onClick,
}: {
  c: TopGrowthContributor;
  /** NAVLINK-1 (B1): when set, the line is a keyboard-accessible link-out
   *  (barang → Trend Item tab, resto → Resto tab via focusOutlet). */
  onClick?: () => void;
}) {
  return (
    <div
      {...(onClick ? clickableRowProps(onClick) : {})}
      className={`flex items-center gap-2 rounded-md py-1 text-[11px] tabular-nums outline-none transition-colors ${
        onClick ? 'cursor-pointer hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60' : ''
      }`}
      title={onClick ? 'Klik untuk membuka analisa lengkap' : undefined}
    >
      <span className="w-1.5 shrink-0 self-stretch rounded-full bg-border/70" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-muted-foreground" title={c.name}>{c.name}</span>
        {c.isNew ? (
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1 text-[9px] font-medium leading-none border-sky-300 text-sky-700 bg-sky-50/60 dark:border-sky-800 dark:text-sky-400 dark:bg-sky-950/30"
            title="Tidak ada deviasi (kuantiti & nominal) di periode pembanding — base nol"
          >
            Baru
          </Badge>
        ) : null}
      </span>
      <span className={`${CONTRIBUTOR_QTY_COL} shrink-0 text-right font-semibold ${growthColor(c.qtyDelta)}`}>
        {formatQtySigned(c.qtyDelta, c.unit)}
      </span>
      <span className={`${CONTRIBUTOR_RP_COL} shrink-0 text-right font-medium ${growthColor(c.nominalDelta)}`}>
        {formatDeltaSigned(c.nominalDelta)}
      </span>
    </div>
  );
});
