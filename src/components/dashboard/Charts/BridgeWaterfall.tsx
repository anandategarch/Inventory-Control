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
//    ± Anomali Data        anomalyNominal     items with nominal but NO
//                          (FIX BUG-2-a #8)   quantity recorded (qty=0) on
//                          one side — cannot be decomposed into
//                          price/quantity, so their residual rides as
//                          its own leg (neutral color)
//    Sekarang (anchor)     currTotalNominal   Σ|nominalDeviasi| of ALL
//                          items, current period (matched + new)
//  Identity (ALWAYS exact, per BUG-2-a #8 + BUG-2-c server field):
//    prev + price + qty + new − gone + anomaly = curr
//
//  Technique (FIX BUG-2-a #7): CUSTOM BAR SHAPE — each leg is one
//  <rect> drawn from yPixel(from) to yPixel(to) (from = level before
//  the step, to = running level after; anchors span 0 → total). The
//  old stacked [base, delta] recipe depended on Recharts' mixed-sign
//  stack internals; the shape gives full control and renders a leg
//  that crosses zero (e.g. 1Jt → −2Jt) as ONE continuous bar. Dashed
//  ReferenceLine segments bridge consecutive legs at the running
//  level. Item Baru / Item Hilang / Anomali legs render ONLY when
//  they exist (zero-height legs read as bugs).
//
//  Colors — --chart-* tokens ONLY, no new hex (§5.4):
//    anchors  = --chart-residual (zinc family)
//    legs +   = --chart-waste    (amber family)
//    legs −   = --chart-loss     (red)
//    anomali  = --chart-residual (zinc — neutral, not a verdict)
//
//  PERF (AUDIT-FE): isAnimationActive={false} on the Bar — the
//  card re-mounts on period-change refetch; entrance animations
//  would replay every time.
// ============================================================

import { memo, useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fmtHeatmapCompact, fmtIDR } from '@/lib/format';
import { getTooltipStyle } from '@/lib/chart-constants';
import type { PriceEffectSummary } from '@/hooks/usePriceEffect';

// Semantic colors — tokens only (zinc anchors, amber positive legs,
// red negative legs; dark-mode variants resolve via the CSS vars).
const ANCHOR_COLOR = 'var(--chart-residual)';
const LEG_UP_COLOR = 'var(--chart-waste)';
const LEG_DOWN_COLOR = 'var(--chart-loss)';
// FIX (BUG-2-a #8): anomaly is data quality noise, not a verdict — neutral zinc.
const ANOMALY_COLOR = 'var(--chart-residual)';

function legColor(v: number): string {
  if (v > 0) return LEG_UP_COLOR;
  if (v < 0) return LEG_DOWN_COLOR;
  return ANCHOR_COLOR; // zero-height leg — never visible
}

/** One waterfall step (FIX BUG-2-a #7): `from`/`to` are the DATA extents of
 *  the bar — anchors rise 0 → total, legs span before → running level. The
 *  custom shape maps them to pixels; `running` stays for the tooltip. */
interface BridgeRow {
  key: string;
  /** Full leg name — tooltip + aria-label (Indonesian). */
  name: string;
  /** X tick — short + unsigned on narrow screens, signed on wide. */
  label: string;
  /** Signed leg value (anchors: the period total). */
  value: number;
  /** Data level the bar starts from (0 for anchors, `before` for legs). */
  from: number;
  /** Data level the bar ends at (= running level after this step). */
  to: number;
  /** Running level AFTER this step (tooltip "Level"). */
  running: number;
  color: string;
  kind: 'anchor' | 'leg';
  /** Item count — only present on the Item Baru / Item Hilang legs. */
  count?: number;
  /** Extra tooltip line — only the Anomali Data leg (FIX BUG-2-a #8). */
  note?: string;
}

/**
 * FIX (BUG-2-a #8): contract with BUG-2-c (server / price-effect.ts) — the
 * summary will carry `anomalyNominal`: Σ per-item Bennet residual
 * (netDelta − qtyEffect − priceEffect) of "ghost" rows (qtyDeviasi = 0 but
 * nominalDeviasi > 0 on one side). Declared locally so this file compiles
 * independently of that change; `?? 0` keeps stale cached responses safe.
 */
type SummaryWithAnomaly = PriceEffectSummary & { anomalyNominal?: number };

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

function buildRows(s: SummaryWithAnomaly, compact: boolean): BridgeRow[] {
  const sign = (v: number) => (v >= 0 ? '+' : '−');
  const defs: Array<{
    key: string; name: string; short: string;
    value: number; kind: 'anchor' | 'leg'; count?: number; note?: string;
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
  // FIX (BUG-2-a #8): ghost rows (qty=0 but nominal>0 on one side) cannot be
  // decomposed into price/quantity — surface their residual as its own leg
  // so the bridge reconciles EXACTLY: prev + price + qty + new − gone +
  // anomaly = curr. Skip when ~0 (float dust / stale cache without the field).
  const anomaly = s.anomalyNominal ?? 0;
  if (Math.abs(anomaly) > 0.005) {
    defs.push({
      key: 'anomaly', name: 'Anomali Data', short: 'Anomali', value: anomaly, kind: 'leg',
      note: 'Item dengan nominal tanpa kuantitas tercatat (qty=0) — tidak bisa didekomposisi harga/kuantitas',
    });
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
      // FIX (BUG-2-a #7): anchors rise from zero; legs span before → running.
      from: d.kind === 'anchor' ? 0 : before,
      to: running,
      running,
      color: d.key === 'anomaly'
        ? ANOMALY_COLOR
        : d.kind === 'anchor' ? ANCHOR_COLOR : legColor(d.value),
    };
  });
}

/** Custom tooltip — renders ONE row (a single Bar means a single payload entry). */
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
      {/* FIX (BUG-2-a #8): short explanation for the Anomali Data leg. */}
      {row.note && <p className="opacity-70 max-w-[220px] leading-snug">{row.note}</p>}
    </div>
  );
}

/** Props Recharts passes into a custom Bar `shape` (the subset we read). */
interface BridgeShapeProps {
  x?: number;
  width?: number;
  /** Full Y-axis plot extent — from the bar entry's `background`. */
  background?: { x?: number; y?: number; width?: number; height?: number };
  payload?: BridgeRow;
}

export const BridgeWaterfall = memo(function BridgeWaterfall({ summary }: { summary: PriceEffectSummary }) {
  const compact = useCompactTicks();
  const rows = useMemo(() => buildRows(summary, compact), [summary, compact]);
  const hasAnomaly = rows.some((r) => r.key === 'anomaly');

  // FIX (BUG-2-a #7): EXPLICIT Y domain, shared by the axis ticks and the
  // custom shape below — the shape must map data values to pixels with the
  // exact same [lo, hi] the YAxis renders (the old function-form domain
  // [(dataMin) => Math.min(0, dataMin), …] is replaced by the same values
  // computed up-front from the rows). Floor at 0 like before; guard against
  // a degenerate flat domain. Declared BEFORE the hasData early-return so
  // the hook order stays stable (same rule as the rows memo above).
  const [yLo, yHi] = useMemo(() => {
    const lo = Math.min(0, ...rows.map((r) => Math.min(r.from, r.to)));
    const hi = Math.max(...rows.map((r) => Math.max(r.from, r.to)));
    return [lo, Math.max(hi, lo + 1)];
  }, [rows]);

  // Guard AFTER all hooks (stable hook order): render only with a compare
  // period, finite anchors, at least one decomposable item and a non-zero
  // level. Also covers stale cached payloads missing the new fields.
  const hasData = summary.hasCompare
    && Number.isFinite(summary.prevTotalNominal)
    && Number.isFinite(summary.currTotalNominal)
    && (summary.matchedItems > 0 || summary.newItems > 0 || summary.goneItems > 0)
    && (summary.prevTotalNominal > 0 || summary.currTotalNominal > 0);
  if (!hasData) return null;

  /**
   * FIX (BUG-2-a #7): custom bar shape — ONE <rect> per step, drawn from
   * yPixel(from) to yPixel(to). Unlike the old stacked [base, delta] recipe,
   * this renders every case correctly (positive, negative, and CROSS-ZERO
   * legs: a harga leg from 1Jt down to −2Jt is one continuous bar, not two
   * pieces split at the zero line). Recharts hands each shape the entry's
   * `background` (= the full Y-axis plot extent) and our `payload`; the
   * linear scale maps [yLo, yHi] onto [background.y + height, background.y]
   * — the exact mapping the axis ticks use.
   */
  const renderBridgeBar = (props: unknown) => {
    // FIX (BUG-2-a #7, follow-up Main): Recharts' ActiveShape union types the
    // callable as `(props: unknown) => JSX.Element`, so the parameter must be
    // `unknown` and cast to the subset we actually read.
    const { x, width, background, payload } = props as BridgeShapeProps;
    if (x == null || width == null || !background || background.y == null || background.height == null || !payload) {
      return <g />;
    }
    const { from, to, color } = payload;
    const span = yHi - yLo;
    const yPixel = (v: number) => background.y! + ((yHi - v) / span) * background.height!;
    const yTop = yPixel(Math.max(from, to));
    const height = Math.abs(yPixel(from) - yPixel(to));
    if (height <= 0) return <g />; // zero-height leg — never visible
    return <rect x={x} y={yTop} width={width} height={height} fill={color} />;
  };

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
          {' '}— jembatan harga · kuantitas · item baru/hilang{hasAnomaly ? ' · anomali' : ''}
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
              domain={[yLo, yHi]}
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
            {/* FIX (BUG-2-a #7): single Bar + custom shape (see renderBridgeBar).
                dataKey="to" only feeds Recharts' internal rect/tooltip plumbing —
                the shape ignores it (its values stay inside [yLo, yHi], so the
                axis domain is never widened behind the shape's mapping). */}
            <Bar dataKey="to" isAnimationActive={false} maxBarSize={48} shape={renderBridgeBar} />
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
        {hasAnomaly && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ANOMALY_COLOR }} aria-hidden />
            anomali data (qty=0)
          </span>
        )}
      </div>
    </div>
  );
});
