'use client';

// ProcessingFeedback — transient processing feedback strip: progress
// bar (while upload/import is running) + the pipeline status log.
// Moved verbatim from FileUploadDialog.tsx (REFACTOR-1-c pure split —
// zero behavior change).

import { Progress } from '@/components/ui/progress';
import { Loader2 } from 'lucide-react';

interface ProcessingFeedbackProps {
  isBusy: boolean;
  uploading: boolean;
  progress: number;
  statusLog: string[];
}

export function ProcessingFeedback({ isBusy, uploading, progress, statusLog }: ProcessingFeedbackProps) {
  return (
    <>
      {/* Progress */}
      {isBusy && (
        <div className="space-y-2">
          <Progress value={progress} className="h-2" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{uploading ? 'Memproses... (bisa 1-5 menit untuk file besar)' : 'Mengimport week...'}</span>
          </div>
        </div>
      )}

      {/* Status Log */}
      {statusLog.length > 0 && (
        <div className="bg-muted/50 rounded-lg p-3 max-h-[300px] overflow-y-auto">
          <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            Status Log
          </p>
          <div className="space-y-1 font-mono text-xs">
            {statusLog.map((line, i) => (
              <p key={i} className="leading-relaxed">{line}</p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
