'use client';

// ============================================================
//  BridgeWaterfall — "Jembatan Perubahan" (ANA-1-B)
//  --------------------------------------------------------
//  Compact waterfall rendered INSIDE PriceEffectCard (L5
//  DIAGNOSTIC EVIDENCE, primary 2-col row). The ONE question it
//  answers (Master Context §21, question-first):
//    "Dari perubahan nominal, berapa dari harga vs kuantitas?"
//
//  Legs (all values from /api/price-effect summary — Bennet exact):
//    Sebelumnya (anchor)  prevTotalNominal   Σ|nominalDeviasi| of ALL
//                          items, compare period (matched + gone)
//    + Efek Harga          priceEffect        matched items
//    + Efek Kuantitas      qtyEffect          matched items
//    + Item Baru           newNominal         items only in current period
//    − Item Hilang         −goneNominal       items only in compare period
//    Sekarang (anchor)     currTotalNominal   Σ|nominalDeviasi| of ALL
//                          items, current period (matched + new)
//  Identity (dev-asserted inside price-effect.ts):
//    currTotalNominal − prevTotalNominal
//      === qtyEffect + priceEffect + newNominal − goneNominal
//
//  Technique: stacked-bar waterfall (classic Recharts recipe) — a
//  transparent `base` Bar lifts each visible `delta` Bar to its
//  running level; dashed ReferenceLine segments bridge consecutive
//  legs at the running level. Item Baru / Item Hilang legs render
//  ONLY when those items exist (zero-height legs read as bugs).
//
//  Colors — --chart-* tokens ONLY, no new hex (§5.4):
//    anchors  = --chart-residual (zinc family)
//    legs +   = --chart-waste    (amber family)
//    legs −   = --chart-loss     (red)
//
//  PERF (AUDIT-FE): isAnimationActive={false} on every Bar — the
//  card re-mounts on period-change refetch; entrance animations
//  would replay every time.
// ============================================================

import { memo, useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fmtHeatmapCompact, fmtIDR } from '@/lib/format';
import { getTooltipStyle } from '@/lib/chart-constants';
import type { PriceEffectSummary } from '@/hooks/usePriceEffect';

// Semantic colors — tokens only (zinc anchors, amber positive legs,
// red negative legs; dark-mode variants resolve via the CSS vars).
const ANCHOR_COLOR = 'var(--chart-residual)';
const LEG_UP_COLOR = 'var(--chart-waste)';
const LEG_DOWN_COLOR = 'var(--chart-loss)';

function legColor(v: number): string {
  if (v > 0) return LEG_UP_COLOR;
  if (v < 0) return LEG_DOWN_COLOR;
  return ANCHOR_COLOR; // zero-height leg — never visible
}

/** One waterfall step. `base` is the transparent stack lifter. */
interface BridgeRow {
  key: string;
  /** Full leg name — tooltip + aria-label (Indonesian). */
  name: string;
  /** X tick — short + unsigned on narrow screens, signed on wide. */
  label: string;
  /** Signed leg value (anchors: the period total). */
  value: number;
  /** Transparent base = min(level before, level after); 0 for anchors. */
  base: number;
  /** Visible stack height = |value|. */
  delta: number;
  /** Running level AFTER this step (tooltip "Level"). */
  running: number;
  color: string;
  kind: 'anchor' | 'leg';
  /** Item count — only present on the Item Baru / Item Hilang legs. */
  count?: number;
}

/** Anchors print the plain total; legs print a signed contribution. */
function fmtLeg(row: BridgeRow): string {
  if (row.kind === 'anchor') return fmtIDR(row.value);
  return `${row.value >= 0 ? '+' : '−'}${fmtIDR(Math.abs(row.value))}`;
}

/**
 * Narrow screens (< sm) swap to short unsigned ticks — six long labels
 * would collide inside a half-width card at ~300px. SSR-safe (defaults
 * to full labels; compact flips after mount, not during hydration).
 */
function useCompactTicks(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return compact;
}

function buildRows(s: PriceEffectSummary, compact: boolean): BridgeRow[] {
  const sign = (v: number) => (v >= 0 ? '+' : '−');
  const defs: Array<{
    key: string; name: string; short: string;
    value: number; kind: 'anchor' | 'leg'; count?: number;
  }> = [
      { key: 'prev', name: 'Sebelumnya', short: 'Awal', value: s.prevTotalNominal, kind: 'anchor' },
      { key: 'price', name: 'Efek Harga', short: 'Harga', value: s.priceEffect, kind: 'leg' },
      { key: 'qty', name: 'Efek Kuantitas', short: 'Kuantitas', value: s.qtyEffect, kind: 'leg' },
    ];
  // Reconciliation legs only when they exist — keeps the bridge compact.
  if (s.newItems > 0 || s.newNominal !== 0) {
    defs.push({ key: 'new', name: 'Item Baru', short: 'Baru', value: s.newNominal, kind: 'leg', count: s.newItems });
  }
  if (s.goneItems > 0 || s.goneNominal !== 0) {
    // Stored negative so the sign logic + running total stay uniform.
    defs.push({ key: 'gone', name: 'Item Hilang', short: 'Hilang', value: -s.goneNominal, kind: 'leg', count: s.goneItems });
  }
  defs.push({ key: 'curr', name: 'Sekarang', short: 'Akhir', value: s.currTotalNominal, kind: 'anchor' });

  let running = s.prevTotalNominal;
  return defs.map((d) => {
    const before = running;
    running = d.kind === 'anchor' ? d.value : before + d.value;
    return {
      ...d,
      label: compact
        ? d.short
        : d.kind === 'anchor' ? d.name : `${sign(d.value)} ${d.name}`,
      // Anchors always rise from zero; legs float between levels.
      base: d.kind === 'anchor' ? 0 : Math.min(before, running),
      delta: Math.abs(d.value),
      running,
      color: d.kind === 'anchor' ? ANCHOR_COLOR : legColor(d.value),
    };
  });
}

/** Custom tooltip — renders ONE row (the stacked transparent base is skipped). */
function BridgeTooltip({ active, payload }: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: BridgeRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload.find((p) => p.payload != null)?.payload;
  if (!row) return null;
  return (
    <div style={getTooltipStyle()} className="space-y-0.5">
      <p className="font-semibold">
        {row.name}
        {row.count != null && row.count > 0 ? ` · ${row.count} item` : ''}
      </p>
      <p className="tabular-nums">{fmtLeg(row)}</p>
      <p className="tabular-nums opacity-70">Level: {fmtIDR(row.running)}</p>
    </div>
  );
}

export const BridgeWaterfall = memo(function BridgeWaterfall({ summary }: { summary: PriceEffectSummary }) {
  const compact = useCompactTicks();
  const rows = useMemo(() => buildRows(summary, compact), [summary, compact]);

  // Guard AFTER all hooks (stable hook order): render only with a compare
  // period, finite anchors, at least one decomposable item and a non-zero
  // level. Also covers stale cached payloads missing the new fields.
  const hasData = summary.hasCompare
    && Number.isFinite(summary.prevTotalNominal)
    && Number.isFinite(summary.currTotalNominal)
    && (summary.matchedItems > 0 || summary.newItems > 0 || summary.goneItems > 0)
    && (summary.prevTotalNominal > 0 || summary.currTotalNominal > 0);
  if (!hasData) return null;

  // Dashed connectors — horizontal line at the running level, bridging
  // each step to the next (classic waterfall grammar).
  const connectors = rows.slice(0, -1).map((r, i) => ({
    key: `${r.key}→${rows[i + 1].key}`,
    from: r.label,
    to: rows[i + 1].label,
    y: r.running,
  }));

  // role="img" makes the SVG subtree presentational — the label carries
  // every leg's number for screen readers (color is never the only signal).
  const ariaLabel = `Jembatan perubahan nominal deviasi semua item: ${rows
    .map((r) => `${r.name}${r.count != null && r.count > 0 ? ` (${r.count} item)` : ''}: ${fmtLeg(r)}`)
    .join('; ')}.`;

  return (
    <div className="space-y-1.5">
      {/* SPEC-1 (§21): question-first heading + reconciliation caption. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Dari perubahan nominal, berapa dari harga vs kuantitas?</span>
          {' '}— jembatan harga · kuantitas · item baru/hilang
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          Rekonsiliasi: {fmtIDR(summary.prevTotalNominal)} → {fmtIDR(summary.currTotalNominal)}
        </p>
      </div>

      <div className="h-[160px]" role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ left: 0, right: 4, top: 6, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" className="opacity-60" />
            <XAxis dataKey="label" interval={0} fontSize={10} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} />
            <YAxis
              width={40}
              domain={[(dataMin: number) => Math.min(0, dataMin), (dataMax: number) => dataMax]}
              tickFormatter={(v: number) => (v === 0 ? '0' : fmtHeatmapCompact(v))}
              fontSize={10}
              stroke="var(--muted-foreground)"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.3 }} content={<BridgeTooltip />} />
            {connectors.map((c) => (
              <ReferenceLine
                key={c.key}
                segment={[{ x: c.from, y: c.y }, { x: c.to, y: c.y }]}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.55}
                strokeDasharray="3 3"
                ifOverflow="extendDomain"
              />
            ))}
            {/* Transparent stack lifter — carries each delta to its level. */}
            <Bar dataKey="base" stackId="bridge" isAnimationActive={false} fill="transparent" />
            <Bar dataKey="delta" stackId="bridge" isAnimationActive={false} maxBarSize={48}>
              {rows.map((r) => <Cell key={r.key} fill={r.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Mini color legend — sign semantics also live in tooltip + aria. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ANCHOR_COLOR }} aria-hidden />
          total periode
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LEG_UP_COLOR }} aria-hidden />
          kaki naik
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LEG_DOWN_COLOR }} aria-hidden />
          kaki turun
        </span>
      </div>
    </div>
  );
});
