'use client';

// ============================================================
//  ConcentrationStrip — ANA-1-C (Contribution Analysis ringkas)
//  --------------------------------------------------------
//  Slim summary strip above the quadrant grid: concentration
//  ratio (CR) for the ACTIVE dimension (the parentDim selector
//  in the tab header). Pure FRONTEND derivation from the
//  existing pareto payload — zero query/API/payload changes
//  (all math lives in deriveConcentration, constants.ts).
//
//  Renders nothing when the active dimension has no drivers.
// ============================================================

import { Badge } from '@/components/ui/badge';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { fmtPctAbs } from '@/lib/format';
import { CONCENTRATION_LEVEL_STYLE, DIM_LABELS, deriveConcentration } from './constants';
import type { ParetoDimension, ParetoResult } from './types';

export function ConcentrationStrip({
  dimension,
  data,
}: {
  dimension: ParetoDimension;
  data: ParetoResult | undefined;
}) {
  if (!data || data.drivers.length === 0) return null;

  const stats = deriveConcentration(data);
  if (!stats) return null;

  // FIX (BUG-2-a #6): with fewer than 5 drivers the CR5 the level is computed
  // from is the LAST driver's cumPct (≈100% whenever the whole dimension
  // fits inside the 80% cut), so the chip would read TINGGI trivially and
  // carry no signal. Show "—" instead; the CR3/CR5 numbers above still tell
  // the actual concentration story.
  const levelKnown = data.drivers.length >= 5;

  const dimLabel = DIM_LABELS[dimension].toLowerCase();
  // cumPct is stored 0-100 — fmtPctAbs expects a ratio, hence /100.
  const cr3Text = fmtPctAbs(stats.cr3 / 100);
  const cr5Text = fmtPctAbs(stats.cr5 / 100);
  const n80Label =
    stats.n80 != null
      ? `${stats.n80} entitas = 80%`
      : `${data.drivers.length}+ entitas = 80%`; // maxDrivers cap hit before 80%

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 dark:bg-zinc-800/40">
      <span className="flex min-w-0 items-center gap-1 text-xs font-semibold">
        Konsentrasi masalah
        <span className="font-normal text-muted-foreground">· {DIM_LABELS[dimension]}</span>
        <InfoTooltip
          content={`Seberapa besar masalah terpusat di sedikit entitas — Top ${stats.cr3Count} ${dimLabel} menyumbang ${cr3Text} dari total deviasi. Klasifikasi dari Top 5: TINGGI bila ≥ 70% · SEDANG ≥ 50% · RENDAH di bawahnya.`}
        />
      </span>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span>
          Top {stats.cr3Count} ={' '}
          <span className="font-semibold text-foreground">{cr3Text}</span>
        </span>
        <span aria-hidden="true" className="text-muted-foreground/60">·</span>
        <span>
          Top {stats.cr5Count} ={' '}
          <span className="font-semibold text-foreground">{cr5Text}</span>
        </span>
        <span aria-hidden="true" className="text-muted-foreground/60">·</span>
        <span>{n80Label}</span>
      </p>
      {levelKnown ? (
        <Badge
          variant="outline"
          className={`ml-auto text-[10px] font-semibold ${CONCENTRATION_LEVEL_STYLE[stats.level]}`}
        >
          {stats.level}
        </Badge>
      ) : (
        <Badge
          variant="outline"
          title="Level konsentrasi belum bisa ditentukan — dimensi ini memiliki kurang dari 5 entitas"
          className="ml-auto text-[10px] font-semibold text-muted-foreground bg-muted/40"
        >
          —
        </Badge>
      )}
    </div>
  );
}
