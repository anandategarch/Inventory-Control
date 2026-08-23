'use client';

// ============================================================
//  PrioritySummaryCard — shows WHY this outlet is priority
//  Displays: Priority Score + Level + 8 signal badges + analysis
//  bullets + 15-signal interactive breakdown with charts
//
//  Phase 3 split: implementation lives in ./priority-summary/*
//  This file is a thin wrapper that re-exports types for backward
//  compatibility (RestoAnalysis.tsx imports Recommendation + OutletItem).
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Target, AlertTriangle, TrendingUp, ChevronDown, ChevronRight,
  BarChart3, Activity, Trophy,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { fmtIDR, fmtPctAbs } from '@/lib/format';
import {
  SIGNAL_GROUPS, SIGNAL_ICONS, SIGNAL_EXPLANATIONS,
} from './priority-summary/constants';
import { priorityBadge } from './priority-summary/helpers';
import { SignalChart } from './priority-summary/signal-chart';
import type { SignalScore, Recommendation, OutletItem } from './priority-summary/types';

// Backward-compat re-exports — RestoAnalysis.tsx imports these from here.
export type { Recommendation, OutletItem };

export function PrioritySummaryCard({
  recommendation,
  outletItems = [],
}: {
  recommendation: Recommendation | null | undefined;
  outletItems?: OutletItem[];
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Pull the parts of recommendation we depend on so React Compiler can
  // track granular dependencies (optional chaining in deps arrays confuses it).
  const outletCode = recommendation?.outletCode;
  const signalScores = recommendation?.signalScores;

  // Default-expand set: signals with score > 50.
  const defaultExpanded = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    if (signalScores) {
      for (const sig of signalScores) {
        if (sig.score > 50) s.add(sig.name);
      }
    }
    return s;
  }, [signalScores]);

  // FIX REACT-1: reset expanded state when outlet OR period changes (was: only outletCode).
  // Use composite key: outletCode + monthLabel + currentWeek so switching period
  // on same outlet resets to defaults.
  // FIX PSC-2: include signalScores content hash in resetKey so period change triggers reset
  const signalScoresHash = signalScores ? signalScores.map(s => `${s.name}:${s.score}`).join(',') : 'none';
  const resetKey = `${outletCode}|${signalScoresHash}`;

  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded);
  const [expandedResetKey, setExpandedResetKey] = useState<string | undefined>(resetKey);
  if (resetKey !== expandedResetKey) {
    setExpandedResetKey(resetKey);
    setExpanded(defaultExpanded);
  }

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Top 3 contributors by score × weight (memoized before early return)
  const topContributors = useMemo(() => {
    if (!signalScores) return [];
    return [...signalScores]
      .map((s) => ({ ...s, contribution: Math.round(s.score * s.weight) }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3);
  }, [signalScores]);

  // Signal lookup by name (memoized before early return)
  const signalByName = useMemo(() => {
    const m = new Map<string, SignalScore>();
    if (signalScores) {
      for (const s of signalScores) m.set(s.name, s);
    }
    return m;
  }, [signalScores]);

  if (!recommendation) return null;

  const r = recommendation;
  const levelColor =
    r.priorityLevel === 'TINGGI'
      ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
      : r.priorityLevel === 'SEDANG'
      ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'
      : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900';

  const scoreColor =
    r.priorityScore >= 55
      ? 'text-red-600 dark:text-red-400'
      : r.priorityScore >= 30
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';

  const scoreBarColor =
    r.priorityScore >= 55 ? 'bg-red-500' : r.priorityScore >= 30 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <Card className="overflow-hidden shadow-sm dark:shadow-black/20 border-amber-200/50 dark:border-amber-900/40">
      <CardHeader className="pb-3 border-b bg-gradient-to-r from-amber-50/50 to-transparent dark:from-amber-950/20">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Target className="h-3.5 w-3.5" />
          </span>
          Priority Summary — Kenapa Resto Ini Prioritas?
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {/* Score + Level + Quick Metrics */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            {/* Priority Score */}
            <div className="text-center">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Priority Score</p>
              <p className={`text-3xl font-bold tabular-nums ${scoreColor}`}>{r.priorityScore}</p>
              <div className="w-24 h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                <div className={`h-full ${scoreBarColor} transition-all duration-500`} style={{ width: `${r.priorityScore}%` }} />
              </div>
            </div>
            {/* Level Badge */}
            <div>
              <Badge variant="outline" className={`text-xs font-semibold ${levelColor}`}>
                {r.priorityLevel}
              </Badge>
              <p className="text-[10px] text-muted-foreground mt-1">
                {r.priorityLevel === 'TINGGI' ? 'Investigasi segera' : r.priorityLevel === 'SEDANG' ? 'Perlu perhatian' : 'Monitor saja'}
              </p>
            </div>
          </div>
          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Dev/BOM</p>
              <p className="text-sm font-semibold tabular-nums">{fmtPctAbs(r.metrics.devBom)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Nominal</p>
              <p className={`text-sm font-semibold tabular-nums ${r.metrics.nominalDeviasi < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {fmtIDR(r.metrics.nominalDeviasi)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Items</p>
              <p className="text-sm font-semibold tabular-nums">{r.metrics.itemCount}</p>
            </div>
          </div>
        </div>

        {/* Signal Badges — 8 key signals */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={`text-[10px] ${r.metrics.direction === 'LOSS' ? 'text-red-600 border-red-200 dark:text-red-400 dark:border-red-900' : 'text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900'}`}>
            {r.metrics.direction}
          </Badge>
          {r.signals.directionFlip && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Flip
            </Badge>
          )}
          {r.signals.trendDeteriorating && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              <TrendingUp className="h-2.5 w-2.5 mr-0.5" /> Memburuk
            </Badge>
          )}
          {r.signals.residualRatio > 0.4 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Residual {(r.signals.residualRatio * 100).toFixed(0)}%
            </Badge>
          )}
          {r.signals.toleranceBreachHighCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Tol Breach High: {r.signals.toleranceBreachHighCount}
            </Badge>
          )}
          {r.signals.overExplainedCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Anomali: {r.signals.overExplainedCount}
            </Badge>
          )}
          {r.signals.highLossItemCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              High Loss: {r.signals.highLossItemCount}
            </Badge>
          )}
          {r.signals.noToleranceItems > 0 && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              No Tol: {r.signals.noToleranceItems}
            </Badge>
          )}
          {r.signals.benchmarkHighCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-900">
              Bench High: {r.signals.benchmarkHighCount}
            </Badge>
          )}
          {r.signals.zScoreAbnormalCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-red-600 border-red-200 dark:text-red-400 dark:border-red-900">
              Z-Score Abnormal: {r.signals.zScoreAbnormalCount}
            </Badge>
          )}
        </div>

        {/* Analysis Bullets — WHY this outlet is priority */}
        <div className="space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Analisa Priority Engine</p>
          {r.analysis.map((a, j) => (
            <p key={j} className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-tight">
              <span className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0">•</span>
              <span>{a}</span>
            </p>
          ))}
        </div>

        {/* ============================================================ */}
        {/*  BREAKDOWN 15 SINYAL — interactive accordion with charts      */}
        {/* ============================================================ */}
        {r.signalScores && r.signalScores.length > 0 && (
          <div className="border-t pt-3 space-y-3">
            {/* Toggle button */}
            <button
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showBreakdown ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Breakdown 15 Sinyal Priority Score
              <span className="ml-auto text-[10px] text-muted-foreground/70">{r.signalScores.filter(s => s.score > 0).length} aktif · {expanded.size} terbuka</span>
            </button>

            {showBreakdown && (
              <div className="space-y-3">
                {/* FIX CHART-7: disclaimer that charts use illustrative data */}
                <p className="text-[10px] text-muted-foreground/70 italic">
                  ℹ️ Chart di bawah adalah ilustrasi berdasarkan nilai sinyal. Klik sinyal untuk melihat visualisasi.
                </p>

                {/* ---- Top Contributors Highlight ---- */}
                {topContributors.length > 0 && (
                  <div className="rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-gradient-to-br from-amber-50/60 to-transparent dark:from-amber-950/20 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-1">
                      <Trophy className="h-3 w-3" /> Top Contributors
                    </p>
                    <div className="space-y-1.5">
                      {topContributors.map((c, i) => (
                        <div key={c.name} className="flex items-center gap-2 text-[11px]">
                          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold shrink-0">
                            {i + 1}
                          </span>
                          <span className="flex-1 truncate font-medium" title={c.name}>{c.name}</span>
                          <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-400">+{c.contribution}</span>
                          <span className="tabular-nums text-muted-foreground/80 text-[10px] w-16 text-right">
                            {Math.round(c.weight * 100)}% bobot
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ---- Accordion grouped by category ---- */}
                {SIGNAL_GROUPS.map((group) => {
                  const groupSignals = group.signals
                    .map((name) => signalByName.get(name))
                    .filter((s): s is SignalScore => Boolean(s));
                  if (groupSignals.length === 0) return null;
                  const GroupIcon = group.icon;
                  const groupContribution = groupSignals.reduce((sum, s) => sum + Math.round(s.score * s.weight), 0);
                  const groupExpandedCount = groupSignals.filter((s) => expanded.has(s.name)).length;

                  return (
                    <div key={group.name} className="rounded-lg border border-border/60 overflow-hidden">
                      {/* Group header */}
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/60">
                        <span className="text-sm">{group.emoji}</span>
                        <GroupIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[11px] font-semibold flex-1">{group.name}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {groupSignals.length} sinyal · +{groupContribution}
                        </span>
                        {groupExpandedCount > 0 && (
                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 tabular-nums">
                            {groupExpandedCount} buka
                          </span>
                        )}
                      </div>

                      {/* Signal rows */}
                      <div className="divide-y divide-border/40">
                        {groupSignals.map((s) => {
                          const contribution = Math.round(s.score * s.weight);
                          const badge = priorityBadge(s.score);
                          const Icon = SIGNAL_ICONS[s.name] || Activity;
                          const isExpanded = expanded.has(s.name);

                          return (
                            <div key={s.name} className="bg-background hover:bg-muted/20 transition-colors">
                              {/* Collapsed row */}
                              <button
                                onClick={() => toggleExpand(s.name)}
                                className="w-full flex items-center gap-2 px-3 py-2 text-left"
                              >
                                {/* Expand chevron */}
                                {isExpanded
                                  ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                                  : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                                {/* Status dot */}
                                <span className={`h-1.5 w-1.5 rounded-full ${badge.dot} shrink-0`} />
                                {/* Icon */}
                                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                {/* Name */}
                                <span className="text-[11px] font-medium flex-1 truncate" title={s.name}>{s.name}</span>
                                {/* Score */}
                                <span className="text-[11px] tabular-nums font-semibold w-7 text-right">{s.score}</span>
                                {/* Contribution */}
                                <span className="text-[11px] tabular-nums w-8 text-right text-muted-foreground">+{contribution}</span>
                                {/* Value */}
                                <span className="text-[10px] tabular-nums text-muted-foreground/80 w-16 text-right truncate hidden sm:block" title={s.value}>{s.value}</span>
                                {/* Badge */}
                                <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${badge.cls}`}>{badge.label}</Badge>
                              </button>

                              {/* Expanded chart + explanation */}
                              {isExpanded && (
                                <div className="px-3 pb-3 pt-1">
                                  <div className="bg-muted/20 dark:bg-muted/10 rounded-lg p-3">
                                    <p className="text-[10px] font-medium text-muted-foreground mb-2 uppercase tracking-wider flex items-center gap-1">
                                      <BarChart3 className="h-3 w-3" />
                                      {s.name}
                                    </p>
                                    <SignalChart name={s.name} r={r} items={outletItems} />
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                                    <span className="font-semibold text-foreground/80">Apa ini: </span>
                                    {SIGNAL_EXPLANATIONS[s.name] || 'Sinyal priority score dari Priority Engine.'}
                                  </p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* ---- Total ---- */}
                {/* FIX CHART-2: show computed sum (not r.priorityScore which uses different rounding).
                    Server computes priorityScore with single rounding at end;
                    per-row contributions use double rounding (Math.round(Math.round(score) * weight)).
                    Show the computed sum so the breakdown math reconciles. */}
                <div className="flex items-center gap-2 text-[11px] pt-2 border-t">
                  <span className="flex-1 font-semibold text-foreground">Total (dari breakdown)</span>
                  <span className="tabular-nums font-bold text-foreground">
                    = {(r.signalScores || []).reduce((sum, s) => sum + Math.round(Math.round(s.score) * s.weight), 0)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70">
                    Score server: {r.priorityScore}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
