'use client';

// ============================================================
//  FileUploadDialog — dialog shell for the 3-phase file upload
//  flow (upload chunks → detect weeks → confirm → import weeks).
//  Implementation split from the former 873-line god file
//  (REFACTOR-1-c pure move — zero behavior change):
//    use-upload-pipeline.ts — ALL pipeline state + actions
//    FileDropZone.tsx       — drop/click file picker area
//    RenameModeSection.tsx  — auto/manual rename + CSV locale
//    ConfirmPanel.tsx       — post-detect confirmation panel
//    ProcessingFeedback.tsx — progress bar + status log
//    ImportResultSummary.tsx — post-import result breakdown
//  This index keeps the public module path
//  `@/components/filters/FileUploadDialog` (named export
//  `FileUploadDialog`) exactly as before — consumers and the
//  /api/ingest-process request/response contract unchanged.
// ============================================================

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, AlertCircle, Loader2, ArrowRight } from 'lucide-react';
import { useUploadPipeline } from './use-upload-pipeline';
import { FileDropZone } from './FileDropZone';
import { RenameModeSection } from './RenameModeSection';
import { ConfirmPanel } from './ConfirmPanel';
import { ProcessingFeedback } from './ProcessingFeedback';
import { ImportResultSummary } from './ImportResultSummary';

interface FileUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FileUploadDialog({ open, onOpenChange }: FileUploadDialogProps) {
  const {
    file,
    uploading,
    importing,
    progress,
    statusLog,
    result,
    error,
    renameMode,
    setRenameMode,
    manualFileName,
    setManualFileName,
    manualValidation,
    numberLocale,
    setNumberLocale,
    detectData,
    fileInputRef,
    handleClose,
    handleFileSelect,
    handleDrop,
    handleUploadAndDetect,
    handleRunImport,
    handleEditName,
    clearFile,
    isBusy,
    showConfirm,
  } = useUploadPipeline({ onOpenChange });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import File Excel
          </DialogTitle>
          <DialogDescription>
            Upload file Excel dari komputer. Sistem otomatis deteksi week yang belum ada.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* File Drop Zone — hidden once confirmation or result is shown */}
          {!result && !showConfirm && (
            <FileDropZone
              file={file}
              isBusy={isBusy}
              fileInputRef={fileInputRef}
              onFileSelect={handleFileSelect}
              onDrop={handleDrop}
              onClearFile={clearFile}
            />
          )}

          {/* Rename Mode Section — only show when file is selected and not yet confirmed/imported */}
          {file && !result && !showConfirm && (
            <RenameModeSection
              isBusy={isBusy}
              renameMode={renameMode}
              onRenameModeChange={setRenameMode}
              manualFileName={manualFileName}
              onManualFileNameChange={setManualFileName}
              manualValidation={manualValidation}
              numberLocale={numberLocale}
              onNumberLocaleChange={setNumberLocale}
            />
          )}

          {/* Confirmation Panel — shown after detect, before import */}
          {showConfirm && detectData && (
            <ConfirmPanel
              detectData={detectData}
              importing={importing}
              onEditName={handleEditName}
              onRunImport={handleRunImport}
            />
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Progress + Status Log */}
          <ProcessingFeedback
            isBusy={isBusy}
            uploading={uploading}
            progress={progress}
            statusLog={statusLog}
          />

          {/* Result Summary */}
          {result && (
            <ImportResultSummary result={result} />
          )}

          {/* Info */}
          {!file && !result && !showConfirm && (
            <div className="text-xs text-muted-foreground space-y-1">
              <p>📋 <strong>Cara kerja:</strong></p>
              <p>1. Pilih file Excel (.xlsx) dari komputer</p>
              <p>2. Pilih mode: Auto-Detect (otomatis) atau Rename Manual</p>
              <p>3. Upload + sistem deteksi week yang belum ada</p>
              <p>4. Konfirmasi nama file &amp; week sebelum import</p>
              <p>5. Import hanya week yang belum ada (partial commit per week)</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button onClick={handleClose} className="w-full">
              Selesai
            </Button>
          ) : showConfirm ? (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={importing}>
                Batal
              </Button>
              <Button onClick={handleRunImport} disabled={importing} className="gap-2">
                {importing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Mengimport...
                  </>
                ) : (
                  <>
                    Lanjut Import <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={isBusy}>
                Batal
              </Button>
              <Button
                onClick={handleUploadAndDetect}
                disabled={!file || isBusy || (renameMode === 'manual' && !manualValidation.ok)}
                className="gap-2"
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Memproses...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Upload &amp; Deteksi
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
