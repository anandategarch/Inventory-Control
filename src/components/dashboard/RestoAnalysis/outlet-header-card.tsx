'use client';

// ============================================================
//  RestoAnalysis — outlet header card + health score ring
//  (split from RestoAnalysis.tsx — SPLIT-G; pure code motion)
//
//  Header card of the Resto tab: outlet identity (name, code,
//  area, PIC, period line) + the Health Score ring. FIX
//  (BUG-2-a #2): the ring renders ONLY with a full restoProfile;
//  a partial payload would otherwise show a fabricated
//  "0 / Kritis" ring.
// ============================================================

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Target } from 'lucide-react';
import type { OutletItemsResponse, RestoProfile } from '@/components/dashboard/resto-analysis/types';

export interface OutletHeaderCardProps {
  data: OutletItemsResponse;
  profile: RestoProfile | null;
  isFetching: boolean;
  isLoading: boolean;
}

export function OutletHeaderCard({ data, profile, isFetching, isLoading }: OutletHeaderCardProps) {
  const outlet = data.outlet ?? { code: '', name: '', area: '', pic: null };

  // Health score ring color — only reached with a profile present (see the
  // conditional render below). FIX (BUG-2-a #2, follow-up Main): `profile` is
  // genuinely nullable at runtime, so this must be optional-chained — with
  // healthScore falling back to 0 on partial payloads (the ring itself is
  // not rendered without a profile, so the 0 is never shown as a fabricated
  // score).
  const healthScore = profile?.investigation?.healthScore ?? 0;
  const scoreRing = healthScore < 30 ? 'stroke-red-500' : healthScore < 50 ? 'stroke-amber-500' : healthScore < 70 ? 'stroke-yellow-500' : 'stroke-emerald-500';
  const scoreText = healthScore < 30 ? 'text-red-600 dark:text-red-400' : healthScore < 50 ? 'text-amber-600 dark:text-amber-400' : healthScore < 70 ? 'text-yellow-600 dark:text-yellow-400' : 'text-emerald-600 dark:text-emerald-400';
  const radius = 26;
  const circ = 2 * Math.PI * radius;
  const dash = (healthScore / 100) * circ;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 shrink-0">
              <Target className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="truncate">{outlet.name}</span>
                <span className="text-muted-foreground font-normal text-sm shrink-0">({outlet.code})</span>
                {isFetching && !isLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  {outlet.area} {outlet.pic ? `· PIC: ${outlet.pic}` : ''} · {data.period.week} {data.period.month}
                  {data.period.prevWeek ? ` vs ${data.period.prevWeek}` : ''}
                </p>
            </div>
          </div>
          {/* Health Score ring — FIX (BUG-2-a #2): only with a full
              restoProfile; a partial payload would otherwise show a
              fabricated "0 / Kritis" ring. */}
          {profile && (
            <div className="flex items-center gap-3 shrink-0">
              <div className="relative h-14 w-14 rounded-full bg-muted/30 ring-2 ring-foreground/10 flex items-center justify-center">
                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 64 64" aria-hidden>
                  <circle cx="32" cy="32" r={radius} className="fill-none stroke-muted/50" strokeWidth="4" />
                  <circle cx="32" cy="32" r={radius} className={`fill-none ${scoreRing}`} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} />
                </svg>
                <span className={`text-sm font-bold tabular-nums ${scoreText}`}>{healthScore}</span>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Health Score</p>
                <p className={`text-xs font-semibold ${scoreText}`}>{healthScore < 30 ? 'Kritis' : healthScore < 50 ? 'Perhatian' : healthScore < 70 ? 'Cukup' : 'Sehat'}</p>
              </div>
            </div>
          )}
        </div>
      </CardHeader>
    </Card>
  );
}
