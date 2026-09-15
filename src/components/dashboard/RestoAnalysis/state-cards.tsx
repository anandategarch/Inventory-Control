'use client';

// ============================================================
//  RestoAnalysis — early-return state cards
//  (split from RestoAnalysis.tsx — SPLIT-G; pure code motion)
//
//  The four pre-data branches of the Resto tab:
//    - NoOutletCard: no outlet selected (embeds the in-tab picker
//      via children — UX-RESTOFILTER-1).
//    - NoPeriodCard: month/week not selected (Bug 6.9 fix).
//    - LoadingCard: outlet-items query in flight.
//    - ErrorCard: query error or non-success payload.
// ============================================================

import { type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, Loader2, Target } from 'lucide-react';

export function NoOutletCard({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="py-16 text-center">
        <div className="flex flex-col items-center">
          <div className="relative mb-4">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-200/30 to-red-200/30 dark:from-amber-900/20 dark:to-red-900/20 blur-xl" aria-hidden />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50">
              <Target className="h-7 w-7" />
            </div>
          </div>
          <p className="text-sm font-medium text-muted-foreground">Pilih outlet untuk melihat Resto Analysis</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Gunakan filter di bawah, atau klik baris di Resto Prioritas / tabel peer</p>
          {/* UX-RESTOFILTER-1: pick a resto directly in the tab (was only
              reachable via Dashboard row clicks or the global FilterBar). */}
          <div className="mt-4 w-full max-w-sm">{children}</div>
        </div>
      </CardContent>
    </Card>
  );
}

// Bug 6.9 fix: show "select period" message instead of error when week not selected
export function NoPeriodCard() {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="py-16 text-center">
        <div className="flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50 mb-4">
            <Target className="h-7 w-7" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">Pilih bulan dan minggu untuk melihat Resto Analysis</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function LoadingCard() {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="py-16 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
        <span className="ml-2.5 text-sm text-muted-foreground font-medium">Memuat Resto Analysis...</span>
      </CardContent>
    </Card>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="overflow-hidden border-red-200/70 dark:border-red-900/60">
      <CardContent className="py-12 text-center">
        <div className="flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 mb-3">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <p className="text-sm text-red-700 dark:text-red-400 font-medium">Gagal Memuat Data</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">{message}</p>
        </div>
      </CardContent>
    </Card>
  );
}
