'use client';

// ============================================================
//  DashboardFooter — sticky bottom footer extracted from page.tsx
//  --------------------------------------------------------
//  Two-column layout:
//    Left: brand + total outlets/items/records (status.stats)
//    Right: last-analysis perf + drill-down hint
// ============================================================

import { Activity, ShieldAlert } from 'lucide-react';
import type { AnalysisData, StatusData } from '@/hooks/useAnalysis';

export interface DashboardFooterProps {
  status: StatusData | undefined;
  analysisData: AnalysisData | undefined;
}

export function DashboardFooter({ status, analysisData }: DashboardFooterProps) {
  return (
    <footer className="sticky bottom-0 mt-auto border-t border-border/60 bg-background/95 backdrop-blur z-30">
      {/* DESKTOP-ONLY (mobile adaptation removed): single text size + padding;
          the iOS home-indicator safe-area inset was dropped with the mobile
          focus — the footer no longer needs notch-zone handling. */}
      <div className="px-6 pt-2.5 pb-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground max-w-[1600px] mx-auto">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-medium text-foreground/80">
            <ShieldAlert className="h-3 w-3 text-amber-500" />
            Inventory Control Intelligence
          </span>
          {status?.stats && (
            <span className="inline tabular-nums">
              {/* FIX (BUG-HUNT C16/BUG-3-05): explicit id-ID — bare toLocaleString()
                  follows the browser locale ("1,234,567" on EN browsers) and broke
                  the app-wide "1.234.567" thousands convention (VH-7 fixed the same
                  pattern in AnalysisCards but missed the footer). */}
              {status.stats.totalOutlets} outlet · {status.stats.totalItems} item · {status.stats.totalRecords.toLocaleString('id-ID')} record
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {analysisData && (
            <span
              className="tabular-nums"
              // QW-B (Phase C item 5): mirror the header's stale indicator —
              // "cache lama" = served from an expired DB-cache entry while a
              // background recompute runs (stale-while-revalidate).
              title={analysisData.stale
                ? 'Data dari cache kedaluwarsa — versi terbaru sedang dihitung ulang di latar belakang'
                : undefined}
            >
              Analisis terakhir: {analysisData.durationMs}ms · {analysisData.stale
                ? 'cache lama (menghitung ulang)'
                : analysisData.cached ? 'cache' : 'segar'}
            </span>
          )}
          <span className="inline text-muted-foreground flex items-center gap-1">
            <Activity className="h-3 w-3" />
            Klik baris mana saja untuk drill-down ke sumber
          </span>
        </div>
      </div>
    </footer>
  );
}
