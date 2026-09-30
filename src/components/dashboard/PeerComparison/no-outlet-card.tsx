'use client';

// ============================================================
//  PeerComparison — "no outlet selected" early-return card
//  (split from PeerComparison.tsx — SPLIT-G; pure code motion)
//
//  Pick-an-outlet state. FIX (BUG-2-a #10) used to also render the
//  network-wide "Peluang Perbaikan (Rp)" benchmark card here — removed
//  by user request (VAR12: "hapus section 'Peluang Perbaikan (Rp)'"),
//  together with the card, its query, and the tab's main render site.
// ============================================================

import { Card, CardContent } from '@/components/ui/card';
import { Users } from 'lucide-react';

export function NoOutletCard() {
  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardContent className="py-16 text-center">
        <div className="flex flex-col items-center">
          <div className="relative mb-4">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-200/30 to-emerald-200/30 dark:from-amber-900/20 dark:to-emerald-900/20 blur-xl" aria-hidden />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50">
              <Users className="h-7 w-7" />
            </div>
          </div>
          <p className="text-sm font-medium text-muted-foreground">Pilih outlet untuk melihat Peer Comparison</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Sistem akan mencari resto dengan sales ±10% sebagai peer group</p>
          {/* FIX (BUGHUNT-R2 / pasca-FILTERDROP-1): the global "filter Outlet di
              bilah atas" no longer exists — outlet scoping now comes from the
              Resto tab's in-tab "Filter Resto" picker (focusOutlet). */}
          <p className="text-xs text-muted-foreground/60 mt-1">Pilih outlet lewat picker &apos;Filter Resto&apos; di tab Resto, atau klik baris outlet di tab Resto / Area.</p>
        </div>
      </CardContent>
    </Card>
  );
}
