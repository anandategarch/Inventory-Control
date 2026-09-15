'use client';

// ============================================================
//  TrendContentStates — ItemTrendTab non-data states
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). The four CardContent branches rendered before any
//  trend data is shown:
//    1. TrendEmptyState    — no item selected (pick-an-item prompt
//                            + amber Z-Score tips Callout)
//    2. TrendErrorState    — trend query failed (message + Coba Lagi)
//    3. TrendLoadingState  — first load, no periods yet
//    4. TrendNoDataState   — item selected but 0 records with the
//                            active filters
// ============================================================

import { AlertTriangle, Info, Loader2, Package, TrendingUp } from 'lucide-react';
import { Callout } from '@/components/ui/callout';
// SHADCN-PATTERNS (Pattern 4) — reusable structured EmptyState. Replaces
// the manual `flex flex-col items-center justify-center` divs with a
// single component that takes icon + title + description + optional
// action. Loaded from `@/components/ui/empty-state` (UI library — distinct
// from the page-level `EmptyState` in `@/components/dashboard/shared`).
import { EmptyState } from '@/components/ui/empty-state';

export function TrendEmptyState() {
  return (
    // Empty state — prompt user to pick an item.
    // SHADCN-PATTERNS (Pattern 4) — replaced manual `flex flex-col ...`
    // div with <EmptyState>. The amber Tips Callout is passed as the
    // `action` so it renders below the title/description. Keeps the
    // same copy + amber theme as the previous inline block (UI-12
    // palette fix preserved).
    <EmptyState
      icon={TrendingUp}
      // FIX (BUG-SHADCN-01): restore amber icon theme (was muted gray after migration).
      iconClassName="bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
      title="Pilih item untuk melihat trend"
      description="Cari item di kotak pencarian di atas. Tren menampilkan QTY lintas semua periode dengan Z-Score historis (baseline same-week)."
      className="py-12"
      action={
        <Callout
          color="amber"
          icon={Info}
          title="Tips: Z-Score butuh minimal 4 periode"
          // FIX (BUG-SHADCN-02): removed mt-4 — EmptyState already adds mt-4 wrapper for action.
          className="max-w-md text-left"
        >
          <p>
            Baseline menggunakan weekLabel yang sama di bulan berbeda (W4 vs W4). Item dengan sedikit periode akan menampilkan Z-Score <code className="font-mono">—</code> (tidak cukup data).
          </p>
        </Callout>
      }
    />
  );
}

interface TrendErrorStateProps {
  message: string;
  onRetry: () => void;
}

export function TrendErrorState({ message, onRetry }: TrendErrorStateProps) {
  return (
    <div className="py-12 px-6 max-w-md mx-auto">
      <Callout
        color="red"
        icon={AlertTriangle}
        title="Gagal memuat trend"
      >
        <p>{message}</p>
        {/* FIX (BUG-HUNT C20/B2-13): recovery affordance — ParetoDashboard
            and the peer table already offer "Coba Lagi" on errors; the trend
            error was message-only. */}
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white shadow-sm transition-colors hover:bg-red-700"
        >
          Coba Lagi
        </button>
      </Callout>
    </div>
  );
}

export function TrendLoadingState() {
  return (
    // FIX (UI-02): standardized loading state padding to py-12.
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
      <span className="ml-2 text-xs text-muted-foreground">Memuat trend...</span>
    </div>
  );
}

interface TrendNoDataStateProps {
  selectedItem: string;
}

export function TrendNoDataState({ selectedItem }: TrendNoDataStateProps) {
  return (
    // SHADCN-PATTERNS (Pattern 4) — replaced manual `flex flex-col ...`
    // div with <EmptyState>. Uses Package icon to distinguish "item
    // exists but no records" from the no-item-selected state above.
    <EmptyState
      icon={Package}
      title="Tidak ada data untuk item ini"
      // FIX (BUG-SHADCN-07): use ReactNode (not string) for bold item name.
      description={<>Item <span className="font-medium">{selectedItem}</span> tidak memiliki record dengan filter aktif.</>}
    />
  );
}
