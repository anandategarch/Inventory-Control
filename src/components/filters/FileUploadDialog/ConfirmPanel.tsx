'use client';

// ConfirmPanel — panel konfirmasi setelah detect (nama file, bulan,
// week di file / sudah ada / akan diimport) dengan aksi "Edit Nama"
// + "Lanjut Import". Moved verbatim from FileUploadDialog.tsx
// (REFACTOR-1-c pure split — zero behavior change).

import { Button } from '@/components/ui/button';
import { CheckCircle2, Pencil, ArrowRight, Loader2 } from 'lucide-react';
import type { DetectResult } from './use-upload-pipeline';

interface ConfirmPanelProps {
  detectData: DetectResult;
  importing: boolean;
  onEditName: () => void;
  onRunImport: () => void;
}

export function ConfirmPanel({ detectData, importing, onEditName, onRunImport }: ConfirmPanelProps) {
  return (
    <div className="border-2 border-primary/30 rounded-lg p-4 space-y-3 bg-primary/5">
      <div className="flex items-center gap-2 text-sm font-semibold text-primary">
        <CheckCircle2 className="h-4 w-4" />
        Konfirmasi Import
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-start justify-between gap-2">
          <span className="text-muted-foreground shrink-0">📁 Nama file:</span>
          <span className="font-mono font-semibold text-right break-all">{detectData.fileName}</span>
        </div>
        {detectData.manualMode && (
          <p className="text-xs text-blue-600 dark:text-blue-400">✏️ Nama di-set manual</p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">📅 Bulan:</span>
          <span className="font-semibold">{detectData.monthLabel}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">📊 Week di file:</span>
          <span className="font-semibold">{detectData.weeksInFile.join(', ') || '-'}</span>
        </div>
        {detectData.existingWeeks.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">ℹ️ Sudah ada:</span>
            <span className="text-blue-600 dark:text-blue-400 font-medium">{detectData.existingWeeks.join(', ')}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1 border-t">
          <span className="text-muted-foreground">📦 Akan diimport:</span>
          <span className="font-bold text-emerald-600 dark:text-emerald-400">{detectData.weeksToImport.join(', ')}</span>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onEditName} className="gap-1.5">
          <Pencil className="h-3.5 w-3.5" /> Edit Nama
        </Button>
        <Button size="sm" onClick={onRunImport} disabled={importing} className="gap-1.5 flex-1">
          {importing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Mengimport...
            </>
          ) : (
            <>
              Lanjut Import <ArrowRight className="h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
