'use client';

// ImportResultSummary — post-import result card (total rows + per-week
// breakdown + skipped weeks). Moved verbatim from FileUploadDialog.tsx
// (REFACTOR-1-c pure split — zero behavior change).

import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { UploadResult } from './use-upload-pipeline';

export function ImportResultSummary({ result }: { result: UploadResult }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-5 w-5" />
        <span className="font-semibold">
          Import selesai: {result.totalInserted.toLocaleString()} rows
        </span>
      </div>

      {/* Week breakdown */}
      <div className="grid grid-cols-2 gap-2">
        {result.importedWeeks.map((w) => (
          <div
            key={w.weekLabel}
            className={`p-2 rounded-lg border text-sm ${
              w.status === 'IMPORTED'
                ? 'border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20'
                : w.status === 'ERROR'
                ? 'border-red-200 bg-red-50 dark:bg-red-950/20'
                : 'border-muted'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">{w.weekLabel}</span>
              {w.status === 'IMPORTED' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
              {w.status === 'ERROR' && <AlertCircle className="h-4 w-4 text-red-600" />}
            </div>
            <p className="text-xs text-muted-foreground">
              {w.status === 'IMPORTED'
                ? `${w.rowCount.toLocaleString()} rows`
                : w.status === 'ERROR'
                ? w.error || 'Error'
                : 'Skipped'}
            </p>
          </div>
        ))}
      </div>

      {result.existingWeeks.length > 0 && (
        <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 text-sm">
          ℹ️ Week sudah ada (skipped): {result.existingWeeks.join(', ')}
        </div>
      )}
    </div>
  );
}
