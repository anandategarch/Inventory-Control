'use client';

// ============================================================
//  FlipSummaryCard — Phase A+B (FLIP-FE) flip summary card.
//  --------------------------------------------------------
//  REFACTOR-1-b: pure move from ItemTrendTab/index.tsx (no
//  behavior change). Compact card summarizing the item's flip
//  pattern across all same-week pairs (W4 Jul vs W4 Agu,
//  W4 Agu vs W4 Sep, …).
//
//  Layout:
//    ┌────────────────────────────────────────────────┐
//    │ 🔀 Flip Pattern Analysis                       │
//    │ {N} same-week pairs:                           │
//    │ 🟢 {Sempurna} Sempurna · 🟡 {Dominan} Dominan │
//    │ · ⚪ {Konsisten} Konsisten                     │
//    │ Avg Disparity: {X}% · Risk: 🟡 {LEVEL}         │
//    └────────────────────────────────────────────────┘
//
//  Color coding:
//    risk=high     → red border + red "HIGH" badge
//    risk=moderate → amber border + amber "MODERATE" badge
//    risk=low      → emerald border + emerald "LOW" badge
// ============================================================

import { Badge } from '@/components/ui/badge';
import type { ItemFlipScore } from './flipHelpers';

function flipRiskClass(level: ItemFlipScore['riskLevel']): string {
  switch (level) {
    case 'high':
      return 'border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 text-red-700 dark:text-red-300';
    case 'moderate':
      return 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300';
    case 'low':
    default:
      return 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300';
  }
}

function flipRiskBadgeClass(level: ItemFlipScore['riskLevel']): string {
  switch (level) {
    case 'high':
      return 'text-red-700 dark:text-red-300 border-red-300 dark:border-red-800 bg-red-100 dark:bg-red-950/40';
    case 'moderate':
      return 'text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800 bg-amber-100 dark:bg-amber-950/40';
    case 'low':
    default:
      return 'text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-950/40';
  }
}

export interface FlipSummaryCardProps {
  score: ItemFlipScore;
}

export function FlipSummaryCard({ score }: FlipSummaryCardProps) {
  const avgPct = Math.round(score.avgDisparity * 100);
  const riskClass = flipRiskClass(score.riskLevel);
  const riskBadgeClass = flipRiskBadgeClass(score.riskLevel);
  const riskLabel = score.riskLevel.toUpperCase();
  // Hide parts that have zero counts to keep the summary tight.
  const parts: Array<{ emoji: string; label: string; count: number; cls: string }> = [
    { emoji: '🟢', label: 'Sempurna', count: score.sempurnaCount, cls: 'text-emerald-700 dark:text-emerald-400' },
    { emoji: '🟡', label: 'Dominan', count: score.dominanCount, cls: 'text-amber-700 dark:text-amber-400' },
    { emoji: '🔴', label: 'Parsial', count: score.parsialCount, cls: 'text-red-700 dark:text-red-400' },
    { emoji: '⚪', label: 'Konsisten', count: score.konsistenCount, cls: 'text-muted-foreground' },
  ].filter(p => p.count > 0);

  return (
    <div className={`mt-2 rounded-lg border px-3 py-2 ${riskClass}`} data-testid="flip-summary-card">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <span aria-hidden>🔀</span>
        <span>Flip Pattern Analysis</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px] leading-tight">
        <span className="font-medium tabular-nums">{score.totalPairs}</span>
        <span className="text-muted-foreground">pasangan minggu sama:</span>
        {parts.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          parts.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/60">·</span>}
              <span aria-hidden>{p.emoji}</span>
              <span className="tabular-nums">{p.count}</span>
              <span className={p.cls}>{p.label}</span>
            </span>
          ))
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]">
        <span className="text-muted-foreground">
          Disparitas Rata-rata: <span className="font-medium tabular-nums text-foreground">{avgPct}%</span>
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">Risiko:</span>
        <Badge variant="outline" className={`text-[10px] h-5 px-1.5 font-semibold ${riskBadgeClass}`}>
          {riskLabel}
        </Badge>
        {score.riskScore > 0 && (
          <span className="text-muted-foreground/70 tabular-nums">({score.riskScore}/100)</span>
        )}
      </div>
    </div>
  );
}
