'use client';

// ============================================================
//  FilterActions — FilterBar's right-side action cluster: the
//  secondary icon-only buttons (Pengaturan / Kelola Data / Kelola
//  PIC) + the primary actions (Import Drive / Upload File /
//  Sinkron File). Moved verbatim from FilterBar.tsx (SPLIT-C pure
//  code motion — zero behavior change): JSX, classNames, tooltips,
//  and every comment are unchanged; the three dialog-open setters
//  and the ingest handler arrive as props.
// ============================================================

import { Button } from '@/components/ui/button';
import { Database, CloudDownload, FolderSync, Settings, Users, Upload } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export interface FilterActionsProps {
  /** "Sinkron File" busy state (useIngest). */
  ingesting: boolean;
  /** "Sinkron File" handler (useIngest.handleIngest). */
  onIngest: () => void;
  onOpenSettings: () => void;
  onOpenDataMgmt: () => void;
  onOpenPicMgmt: () => void;
}

export function FilterActions({ ingesting, onIngest, onOpenSettings, onOpenDataMgmt, onOpenPicMgmt }: FilterActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
      {/* Secondary icon-only buttons with tooltips */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-muted/50 transition-all active:scale-95"
            onClick={onOpenSettings}
            aria-label="Pengaturan"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Pengaturan</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-muted/50 transition-all active:scale-95"
            onClick={onOpenDataMgmt}
            aria-label="Kelola Data"
          >
            <Database className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Kelola Data</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-muted/50 transition-all active:scale-95"
            onClick={onOpenPicMgmt}
            aria-label="Kelola PIC"
          >
            <Users className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Kelola PIC</TooltipContent>
      </Tooltip>

      {/* Primary actions — Import dari Drive, Upload File, Sinkron File */}
      <div className="h-5 w-px bg-border/60 mx-0.5" aria-hidden />

      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs font-medium hover:bg-muted/50 transition-all active:scale-95"
        onClick={() => document.dispatchEvent(new CustomEvent('open-drive-dialog'))}
      >
        <CloudDownload className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        <span className="inline">Import Drive</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs font-medium hover:bg-muted/50 transition-all active:scale-95"
        onClick={() => document.dispatchEvent(new CustomEvent('open-upload-dialog'))}
      >
        <Upload className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        <span className="inline">Upload File</span>
      </Button>
      {/* VH-6 (Superset "Name with Purpose"): this button RE-SCANS the
          Excel files in the server's data directory (POST /api/ingest) —
          it is NOT a display refresh. Renamed from "Refresh Data"
          (misleading — audit H-14-b found users expected a refresh;
          the true display refresh now lives in the header as
          "Muat Ulang"). FIX (BUG-HUNT C1/B1): icon was RotateCcw — the
          SAME glyph as the Reset-filters button visible in this toolbar
          (two identical icons, two different actions). FolderSync =
          folder re-scan semantics; RotateCcw stays exclusive to Reset. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs font-medium hover:bg-muted/50 transition-all active:scale-95"
            onClick={onIngest}
            disabled={ingesting}
          >
            <FolderSync className={`h-3.5 w-3.5 ${ingesting ? 'animate-spin' : ''}`} />
            <span className="inline">{ingesting ? 'Memproses...' : 'Sinkron File'}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          Baca ulang file Excel di folder server (re-ingest) — untuk data baru yang sudah diunggah ke server.
          Untuk memperbarui tampilan, gunakan tombol Muat Ulang di header (⌘/Ctrl+R).
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
