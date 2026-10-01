'use client';

// ============================================================
//  MetricSelector — 4-option metric toggle buttons
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Toggle buttons matching the HistoricalZScoreCard
//  style: QTY Deviasi / Waste / Susut / Trial.
// ============================================================

import type { ItemTrendMetric } from '@/hooks/useAnalysis';
import { METRICS } from '../types';

interface MetricSelectorProps {
  metric: ItemTrendMetric;
  setMetric: (m: ItemTrendMetric) => void;
}

export function MetricSelector({ metric, setMetric }: MetricSelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 p-0.5 rounded-lg bg-muted/40 self-auto">
      {/* FIX (UIUX-D D3): added flex-wrap — the 4 nowrap buttons total ~280px and
          must wrap to 2 rows on narrow screens instead of overflowing the row
          (pairs with TrendHeader's flex-col sm:flex-row stack). */}
      {METRICS.map((m) => (
        <button
          key={m.value}
          onClick={() => setMetric(m.value)}
          className={`text-[11px] px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
            metric === m.value
              ? 'bg-amber-600 text-white shadow-sm'
              : 'text-muted-foreground hover:bg-muted/60'
          }`}
          aria-pressed={metric === m.value}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
