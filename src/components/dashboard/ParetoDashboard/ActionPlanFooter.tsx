'use client';

// ============================================================
//  ActionPlanFooter — Insight Footer with Action Plan summary.
//  --------------------------------------------------------
//  Shows counts of top drivers per dimension (item/outlet/
//  kelompok/pic) that together = 80% of total deviation.
//  Pure presentational component — no hooks, no state.
// ============================================================

import { Card, CardContent } from '@/components/ui/card';
import { Target, Package, Store, Boxes, Users } from 'lucide-react';
import type { ParetoData } from './types';

export function ActionPlanFooter({ paretoData }: { paretoData: ParetoData }) {
  return (
    <Card className="bg-gradient-to-br from-amber-50/60 to-amber-50/20 dark:from-amber-950/30 dark:to-amber-950/10 border-amber-300/50 dark:border-amber-800/50 shadow-md shadow-amber-500/5">
      <CardContent className="py-4 px-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 dark:bg-amber-500/10 border border-amber-400/30">
            <Target className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 space-y-1.5">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Action Plan — Prioritas Investigasi
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <div className="flex items-center gap-1.5 text-xs">
                <Package className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="text-amber-700 dark:text-amber-400">
                  <strong>{paretoData.byItem?.drivers.length || 0}</strong> item = 80% deviasi
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <Store className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="text-amber-700 dark:text-amber-400">
                  <strong>{paretoData.byOutlet?.drivers.length || 0}</strong> outlet = 80% deviasi
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <Boxes className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="text-amber-700 dark:text-amber-400">
                  <strong>{paretoData.byKelompok?.drivers.length || 0}</strong> kelompok = 80% deviasi
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <Users className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="text-amber-700 dark:text-amber-400">
                  <strong>{paretoData.byPIC?.drivers.length || 0}</strong> PIC = 80% deviasi
                </span>
              </div>
            </div>
            <p className="text-[11px] text-amber-600/70 dark:text-amber-400/60 pt-1">
              Fokus ke item di atas untuk eliminasi 80% total deviasi dengan efisien.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
