'use client';

import { memo, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, History, RefreshCw } from 'lucide-react';

interface AuditLogEntry {
  id: number;
  action: string;
  detail: string;
  duration: number | null;
  createdAt: string;
}

interface AuditLogResponse {
  success: boolean;
  entries?: AuditLogEntry[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
  error?: string;
}

const ACTION_COLORS: Record<string, string> = {
  INGEST: 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:bg-blue-950/30',
  INGEST_UPLOAD: 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:bg-blue-950/30',
  IMPORT_DRIVE: 'border-purple-300 text-purple-700 bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:bg-purple-950/30',
  ANALYSIS: 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:bg-amber-950/30',
  DATA_DELETE: 'border-red-300 text-red-700 bg-red-50 dark:border-red-800 dark:text-red-400 dark:bg-red-950/30',
  SETTINGS: 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:bg-emerald-950/30',
  PIC_UPDATE: 'border-cyan-300 text-cyan-700 bg-cyan-50 dark:border-cyan-800 dark:text-cyan-400 dark:bg-cyan-950/30',
  MIGRATE_DIRECTION: 'border-orange-300 text-orange-700 bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:bg-orange-950/30',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function AuditLogDialogInner({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams();
  params.set('limit', '50');
  params.set('page', String(page));
  if (actionFilter !== 'all') params.set('action', actionFilter);

  const { data, isLoading, isFetching, error, refetch } = useQuery<AuditLogResponse>({
    queryKey: ['audit-log', params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/audit-log?${params.toString()}`);
      const json: AuditLogResponse = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    },
    enabled: open,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const handleActionChange = useCallback((v: string) => {
    setActionFilter(v);
    setPage(1);
  }, []);

  const entries = data?.entries ?? [];
  const pagination = data?.pagination;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col gap-3 p-5">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-amber-600" />
            Audit Log
          </DialogTitle>
          {/* UI-06 FIX: Move DialogDescription outside DialogTitle (h2 > p is invalid HTML) */}
          <DialogDescription className="sr-only">Riwayat aksi yang dilakukan di sistem</DialogDescription>
        </DialogHeader>

        {/* Filter bar */}
        <div className="flex items-center gap-2 pb-2 border-b shrink-0">
          <Select value={actionFilter} onValueChange={handleActionChange}>
            <SelectTrigger className="h-8 text-xs w-[180px]">
              <SelectValue placeholder="Semua Aksi" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">Semua Aksi</SelectItem>
              <SelectItem value="ANALYSIS" className="text-xs">Analysis</SelectItem>
              <SelectItem value="INGEST" className="text-xs">Ingest</SelectItem>
              <SelectItem value="INGEST_UPLOAD" className="text-xs">Upload</SelectItem>
              <SelectItem value="IMPORT_DRIVE" className="text-xs">Import Drive</SelectItem>
              <SelectItem value="DATA_DELETE" className="text-xs">Delete Data</SelectItem>
              <SelectItem value="SETTINGS" className="text-xs">Settings</SelectItem>
              <SelectItem value="PIC_UPDATE" className="text-xs">PIC Update</SelectItem>
              <SelectItem value="MIGRATE_DIRECTION" className="text-xs">Migrate Direction</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Log entries — plain scroll div (ScrollArea has height issues in flex dialogs) */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            </div>
          )}

          {!isLoading && error && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
              <p className="text-xs text-red-600 flex-1">
                Gagal memuat: {error instanceof Error ? error.message : 'Unknown error'}
              </p>
              <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => refetch()}>
                Coba Lagi
              </Button>
            </div>
          )}

          {!isLoading && !error && entries.length === 0 && (
            <div className="text-center py-12 text-sm text-muted-foreground">
              Tidak ada log untuk filter ini.
            </div>
          )}

          {!isLoading && entries.length > 0 && (
            <div className="space-y-2 py-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 p-2.5 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                >
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-medium shrink-0 ${ACTION_COLORS[entry.action] || 'border-gray-300 text-gray-700 bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:bg-gray-950/30'}`}
                  >
                    {entry.action}
                  </Badge>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className="text-xs text-foreground break-words whitespace-pre-wrap">{entry.detail}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 shrink-0">
                      {formatTime(entry.createdAt)}
                      {entry.duration != null && ` · ${entry.duration}ms`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground shrink-0">
            <span className="truncate">
              Halaman {pagination.page} dari {pagination.totalPages} ({pagination.total} total)
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                ← Sebelumnya
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                Berikutnya →
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export const AuditLogDialog = memo(AuditLogDialogInner);
