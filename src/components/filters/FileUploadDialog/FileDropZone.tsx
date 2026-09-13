'use client';

// FileDropZone — klik/drag-and-drop file picker area for
// FileUploadDialog. Moved verbatim from FileUploadDialog.tsx
// (REFACTOR-1-c pure split — zero behavior change).

import type { RefObject, ChangeEventHandler, DragEventHandler } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, FileSpreadsheet, X } from 'lucide-react';

interface FileDropZoneProps {
  file: File | null;
  isBusy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: ChangeEventHandler<HTMLInputElement>;
  onDrop: DragEventHandler;
  onClearFile: () => void;
}

export function FileDropZone({ file, isBusy, fileInputRef, onFileSelect, onDrop, onClearFile }: FileDropZoneProps) {
  return (
    <div
      className="border-2 border-dashed border-muted-foreground/30 rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
      onClick={() => !isBusy && fileInputRef.current?.click()}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.csv"
        onChange={onFileSelect}
        className="hidden"
      />
      {file ? (
        <div className="flex flex-col items-center gap-2">
          <FileSpreadsheet className="h-12 w-12 text-emerald-600" />
          <p className="font-semibold">{file.name}</p>
          <p className="text-sm text-muted-foreground">
            {(file.size / 1024 / 1024).toFixed(1)}MB
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            disabled={isBusy}
            onClick={(e) => {
              e.stopPropagation();
              onClearFile();
            }}
          >
            <X className="h-4 w-4" /> Ganti file
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <Upload className="h-12 w-12 text-muted-foreground" />
          <p className="font-semibold">Klik atau drag file ke sini</p>
          <p className="text-sm text-muted-foreground">
            Format: .xlsx, .csv (maks 50MB)
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Nama file wajib format: &quot;17.MEI 2026.xlsx&quot; atau &quot;JULI 2026.xlsx&quot;
          </p>
        </div>
      )}
    </div>
  );
}
