'use client';

import { memo, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import type { AnalysisData } from '@/hooks/useAnalysis';
// GODSPLIT-W2-B: buildInsights (9-rule derivation engine) + the Insight
// contract now live in '@/lib/insights' — pure, unit-testable
// (tests/lib/insights.test.ts), and memoized at the call site below.
import { buildInsights, type Insight, type InsightIcon } from '@/lib/insights';
import {
  Lightbulb, TrendingUp, TrendingDown, AlertTriangle, Coins,
  MapPin, Package, ShieldAlert, Zap, ArrowRight, ChevronDown, ChevronUp,
} from 'lucide-react';

// ============================================================
//  Insight presentation spec (view-side)
//  VH-3 (spec §4 L4): callout-style cards — border-left only +
//  prose (Gestalt similarity: two shapes, two meanings — data
//  cards keep the full border, insights read as annotations).
//  critical border-red-500 bg-red-500/5, warning border-amber-400
//  bg-amber-50/40, positive emerald, info zinc.
// ============================================================

// GODSPLIT-W2-B: the engine emits icon KEYS (InsightIcon) so that
// lib/insights.ts stays JSX-free and unit-testable in node vitest;
// this map renders each key with the exact same `h-4 w-4` lucide
// element buildInsights used to inline into the data.
const INSIGHT_ICONS: Record<InsightIcon, React.ReactNode> = {
  'shield-alert': <ShieldAlert className="h-4 w-4" />,
  'alert-triangle': <AlertTriangle className="h-4 w-4" />,
  lightbulb: <Lightbulb className="h-4 w-4" />,
  zap: <Zap className="h-4 w-4" />,
  'map-pin': <MapPin className="h-4 w-4" />,
  coins: <Coins className="h-4 w-4" />,
  package: <Package className="h-4 w-4" />,
  'trending-down': <TrendingDown className="h-4 w-4" />,
  'trending-up': <TrendingUp className="h-4 w-4" />,
};

// SPEC-1 (§6.1): hover explanations for each certainty level.
const CERTAINTY_TOOLTIPS: Record<Insight['certainty'], string> = {
  TERUKUR: 'Temuan langsung dari nilai/kalkulasi yang dapat diverifikasi pada data.',
  INDIKASI: 'Pola kuat dari data — bukan root cause. Perlu validasi lanjutan.',
  HIPOTESIS: 'Kemungkinan penyebab yang masih perlu validasi — bukan kesimpulan.',
};

const SEVERITY_STYLES: Record<Insight['severity'], {
  container: string;
  icon: string;
  title: string;
}> = {
  critical: {
    container: 'border-red-500 bg-red-500/5',
    icon: 'text-red-600 dark:text-red-400',
    title: 'text-red-700 dark:text-red-400',
  },
  warning: {
    container: 'border-amber-400 bg-amber-50/40 dark:bg-amber-950/20',
    icon: 'text-amber-600 dark:text-amber-400',
    title: 'text-amber-700 dark:text-amber-400',
  },
  info: {
    container: 'border-zinc-400 bg-zinc-50/40 dark:bg-zinc-900/20',
    icon: 'text-zinc-600 dark:text-zinc-300',
    title: 'text-zinc-700 dark:text-zinc-300',
  },
  positive: {
    container: 'border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20',
    icon: 'text-emerald-600 dark:text-emerald-400',
    title: 'text-emerald-700 dark:text-emerald-400',
  },
};

// VH-3 (spec §4 L4): at most 5 insight cards visible by default —
// the rest collapse behind an "N lainnya" expander (progressive
// disclosure; the summary count badges above stay complete).
const MAX_VISIBLE = 5;

// ============================================================
//  InsightsPanel — main component
//  (GODSPLIT-W2-B: the 190-LOC buildInsights derivation engine moved
//  to src/lib/insights.ts — see that file's header.)
// ============================================================
export const InsightsPanel = memo(function InsightsPanel({ data }: { data: AnalysisData }) {
  const setArea = useDashboard((s) => s.setArea);
  // FILTERDROP-1 + dead-code audit: `setOutlet` AND `setScorecardOutlet`
  // subscriptions REMOVED — their ONLY usage was the `type === 'outlet'`
  // action branch below, which was already dead BEFORE the filter removal
  // (no insight in buildInsights ever emits actionTarget type 'outlet' —
  // verified by grep), and the global outlet filter it targeted no longer
  // exists. Outlet navigation now goes through setDrilldown /
  // setDeepDiveItem / setFocusOutlet only.
  const setItem = useDashboard((s) => s.setItem);
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setDeepDiveItem = useDashboard((s) => s.setDeepDiveItem);
  // VH-3 (spec §4 L4): ≤5 cards visible by default, "N lainnya" expander
  // for the rest.
  const [showAll, setShowAll] = useState(false);

  // GODSPLIT-W2-B: memoized on the single data dependency — previously
  // the ~190-LOC 9-rule pipeline recomputed on EVERY render.
  const insights = useMemo(() => buildInsights(data), [data]);
  const counts = {
    critical: insights.filter((i) => i.severity === 'critical').length,
    warning: insights.filter((i) => i.severity === 'warning').length,
    info: insights.filter((i) => i.severity === 'info').length,
    positive: insights.filter((i) => i.severity === 'positive').length,
  };
  const visible = showAll ? insights : insights.slice(0, MAX_VISIBLE);
  const hiddenCount = insights.length - visible.length;

  const onAction = (insight: Insight) => {
    if (!insight.actionTarget) return;
    const { type, value } = insight.actionTarget;
    if (type === 'area') {
      setArea(value);
    } else if (type === 'item') {
      setItem(value);
      setDeepDiveItem({ itemName: value, outletCode: null });
      setDrilldown({ outletCode: null, itemName: value });
    }
  };

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3 border-b">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-start gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
              <Lightbulb className="h-3.5 w-3.5" />
            </span>
            <div>
              <CardTitle className="text-sm">Insight Otomatis</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                <span className="font-medium tabular-nums">{insights.length}</span> insight dari analisis periode <span className="font-medium">{data.period.weekLabel} {data.period.monthLabel}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {counts.critical > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-red-300 text-red-700 dark:border-red-800 dark:text-red-400 bg-red-50/50 dark:bg-red-950/30 font-medium">
                Kritis: <span className="tabular-nums">{counts.critical}</span>
              </Badge>
            )}
            {counts.warning > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/30 font-medium">
                Warning: <span className="tabular-nums">{counts.warning}</span>
              </Badge>
            )}
            {counts.positive > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/30 font-medium">
                Positif: <span className="tabular-nums">{counts.positive}</span>
              </Badge>
            )}
            {counts.info > 0 && (
              <Badge variant="outline" className="text-xs h-5 border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300 bg-zinc-50/50 dark:bg-zinc-900/30 font-medium">
                Info: <span className="tabular-nums">{counts.info}</span>
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {/* FIX (UIUX-D D1): grid-cols-2 → grid-cols-1 gap-3 sm:grid-cols-2 —
            insight callouts get full width on mobile, 2 columns at ≥sm. */}
        {insights.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground/50 mb-3">
              <Lightbulb className="h-6 w-6" />
            </div>
            <p className="text-sm text-muted-foreground">Tidak ada insight yang dapat dihasilkan dari data ini.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visible.map((insight) => {
              const style = SEVERITY_STYLES[insight.severity];
              return (
                // VH-3 (spec §4 L4): callout anatomy — border-left accent +
                // tint, no icon chip / lift / full border (that chrome now
                // belongs to DATA cards; insights read as annotations).
                <div
                  key={insight.id}
                  className={`rounded-r-lg border-l-4 p-3 pl-4 flex items-start gap-2.5 ${style.container}`}
                >
                  <span className={`shrink-0 mt-0.5 ${style.icon}`}>{INSIGHT_ICONS[insight.icon]}</span>
                  <div className="flex-1 min-w-0">
                    {/* SPEC-1 (§20): CERTAINTY → FINDING → EVIDENCE → ACTION —
                        the certainty eyebrow rides above the title so the
                        reader knows HOW to read the finding (measured vs
                        pattern) before reading it. Neutral zinc styling on
                        purpose: certainty is epistemics, NOT urgency — it
                        must not fight the severity colors (§11.1). */}
                    <p
                      title={CERTAINTY_TOOLTIPS[insight.certainty]}
                      className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70"
                    >
                      {insight.certainty}
                    </p>
                    <p className={`text-sm font-semibold ${style.title}`}>{insight.title}</p>
                    <p className="text-sm leading-relaxed text-foreground/90 mt-1">{insight.body}</p>
                    {insight.action && insight.actionTarget && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 mt-2 px-2 text-xs hover:bg-foreground/5"
                        onClick={() => onAction(insight)}
                      >
                        {insight.action}
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* "N lainnya" expander — progressive disclosure for the tail */}
        {insights.length > MAX_VISIBLE && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 h-7 px-2 text-xs text-muted-foreground"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
          >
            {showAll ? (
              <>
                <ChevronUp className="h-3.5 w-3.5 mr-1" />
                Tampilkan lebih sedikit
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5 mr-1" />
                Tampilkan {hiddenCount} insight lainnya
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
});
