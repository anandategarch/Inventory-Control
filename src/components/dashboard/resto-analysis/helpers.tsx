// ============================================================
//  RestoAnalysis — shared UI helpers + tiny presentational
//  components (Row, SummaryCard)
//  (split from RestoAnalysis.tsx — Phase 3)
//
//  FIX (BATCH1): fmtGrowth + growthColor moved to @/lib/format —
//  re-exported here so existing imports from './helpers' still work.
// ============================================================

import { memo } from 'react';
import { fmtIDR, fmtNum, fmtPct, fmtGrowth, growthColor } from '@/lib/format';

// ------------------------------------------------------------
//  Formatting helpers (re-export from @/lib/format for backward compat)
// ------------------------------------------------------------

// FIX (BATCH1): fmtGrowth + growthColor moved to @/lib/format.
// Imported above (used by the Row component below) + re-exported here so
// existing './helpers' imports (RestoAnalysis.tsx, item-detail-modal.tsx)
// keep working without churn.
export { fmtGrowth, growthColor } from '@/lib/format';

// FIX M-L (AUDIT-3): P2/P3 badge colors failed WCAG AA (amber-600/emerald-600 on
// 100 bg ≈ 3.5:1, need 4.5:1 for 12px text). Use 700 variants for contrast.
export function priorityColor(p: string): string {
  return p === 'P1' ? 'text-red-700 dark:text-red-400' : p === 'P2' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400';
}

export function priorityBg(p: string): string {
  return p === 'P1' ? 'bg-red-100 dark:bg-red-950/30' : p === 'P2' ? 'bg-amber-100 dark:bg-amber-950/30' : 'bg-emerald-100 dark:bg-emerald-950/30';
}

export { directionColor } from '@/lib/format';

// ------------------------------------------------------------
//  Row — label/value row used inside profile cards and modal
// ------------------------------------------------------------

export const Row = memo(function Row({ label, value, growth, sub, growthColor: gc }: {
  label: string; value: string; growth?: number | null; sub?: string; growthColor?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="font-mono font-semibold">{value}</span>
        {growth != null && (
          <span className={`text-xs ${gc || growthColor(growth, true)}`}>{fmtGrowth(growth)}</span>
        )}
        {sub && <span className="text-xs text-muted-foreground">({sub})</span>}
      </div>
    </div>
  );
});

// ------------------------------------------------------------
//  SummaryCard — small KPI card used in ItemDetailModal
// ------------------------------------------------------------

export const SummaryCard = memo(function SummaryCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border p-2 text-center">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold ${color || ''}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
});

// ------------------------------------------------------------
//  Tiny re-exports so sub-modules can import format helpers
//  from one place if desired (not strictly required).
// ------------------------------------------------------------

export { fmtIDR, fmtNum, fmtPct };
