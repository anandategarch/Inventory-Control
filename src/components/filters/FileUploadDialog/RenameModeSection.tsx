'use client';

// RenameModeSection — filename rename mode (Auto-Detect / Rename
// Manual) + manual input + CSV number-locale selector for
// FileUploadDialog. Moved verbatim from FileUploadDialog.tsx
// (REFACTOR-1-c pure split — zero behavior change).

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pencil, Wand2, Keyboard } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

interface RenameModeSectionProps {
  isBusy: boolean;
  renameMode: 'auto' | 'manual';
  onRenameModeChange: Dispatch<SetStateAction<'auto' | 'manual'>>;
  manualFileName: string;
  onManualFileNameChange: Dispatch<SetStateAction<string>>;
  manualValidation: { ok: boolean; cleaned?: string; error?: string };
  numberLocale: 'auto' | 'id' | 'us';
  onNumberLocaleChange: Dispatch<SetStateAction<'auto' | 'id' | 'us'>>;
}

export function RenameModeSection({
  isBusy,
  renameMode,
  onRenameModeChange,
  manualFileName,
  onManualFileNameChange,
  manualValidation,
  numberLocale,
  onNumberLocaleChange,
}: RenameModeSectionProps) {
  return (
    <div className="border rounded-lg p-3 space-y-3 bg-muted/30">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Pencil className="h-4 w-4" />
        Nama File untuk Import
      </div>

      {/* Mode toggle */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onRenameModeChange('auto')}
          className={`text-left p-2.5 rounded-lg border text-sm transition-colors ${
            renameMode === 'auto'
              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
              : 'border-muted hover:border-muted-foreground/40'
          } ${isBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Wand2 className="h-3.5 w-3.5" />
            Auto-Detect
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Sistem extract bulan dari nama file / data Excel
          </p>
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onRenameModeChange('manual')}
          className={`text-left p-2.5 rounded-lg border text-sm transition-colors ${
            renameMode === 'manual'
              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
              : 'border-muted hover:border-muted-foreground/40'
          } ${isBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Keyboard className="h-3.5 w-3.5" />
            Rename Manual
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Ketik nama sendiri (format: BULAN TAHUN.xlsx)
          </p>
        </button>
      </div>

      {/* Manual input */}
      {renameMode === 'manual' && (
        <div className="space-y-1.5">
          <Label htmlFor="manual-filename" className="text-xs">
            Nama file manual
          </Label>
          <Input
            id="manual-filename"
            value={manualFileName}
            onChange={(e) => onManualFileNameChange(e.target.value)}
            placeholder="MEI 2026.xlsx"
            disabled={isBusy}
            className="font-mono text-sm"
            autoComplete="off"
          />
          {manualFileName && (
            <p className={`text-xs ${manualValidation.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
              {manualValidation.ok
                ? `✓ Akan disimpan sebagai: ${manualValidation.cleaned}`
                : `⚠ ${manualValidation.error}`}
            </p>
          )}
        </div>
      )}

      {renameMode === 'auto' && (
        <p className="text-xs text-muted-foreground">
          ℹ️ Jika nama file adalah placeholder (mis. &quot;Loading Google Sheet&quot;), sistem otomatis extract bulan dari data Excel. Jika gagal, switch ke &quot;Rename Manual&quot;.
        </p>
      )}

      {/* Number format selector — for CSV file parsing */}
      <div className="space-y-1.5 pt-1 border-t">
        <Label htmlFor="upload-number-locale" className="text-xs font-semibold">
          Format Angka (untuk CSV)
        </Label>
        <Select value={numberLocale} onValueChange={(v) => onNumberLocaleChange(v as 'auto' | 'id' | 'us')} disabled={isBusy}>
          <SelectTrigger id="upload-number-locale" className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto" className="text-sm">Auto-detect (heuristic)</SelectItem>
            <SelectItem value="id" className="text-sm">Indonesia: 1.234,56 (titik=ribuan)</SelectItem>
            <SelectItem value="us" className="text-sm">US: 1,234.56 (koma=ribuan)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          File .xlsx tidak terpengaruh (Excel sudah parse angka). Hanya relevan untuk .csv — pilih sesuai format angka di file.
        </p>
      </div>
    </div>
  );
}
