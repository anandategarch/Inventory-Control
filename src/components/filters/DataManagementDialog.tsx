'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2, AlertTriangle, FileSpreadsheet, CalendarRange, Bomb, ChevronDown, ChevronRight, Bug } from 'lucide-react';
import React, { useState } from 'react';
import { useToast } from '@/hooks/use-toast';

// DQ issue code explanations + recommended actions
const DQ_FIXES: Record<string, { title: string; action: string }> = {
  MISSING_OUTLET: { title: 'RESTO kosong', action: 'Cek baris tersebut di Excel, pastikan kolom RESTO terisi dengan kode outlet (mis. 1030.BDGSET).' },
  MISSING_ITEM: { title: 'NAMA BAHAN kosong', action: 'Cek baris tersebut di Excel, pastikan kolom NAMA BAHAN terisi.' },
  MISSING_WEEK: { title: 'STATUS BULAN kosong', action: 'Cek kolom STATUS BULAN di Excel, pastikan terisi (WEEK 1, WEEK 2, dll).' },
  INVALID_NUMBER: { title: 'Angka tidak valid', action: 'Cek format angka di kolom tersebut. Pastikan tidak ada teks atau karakter aneh.' },
  MISSING_BOM: { title: 'QTY BOM kosong/0', action: 'Cek master data BOM untuk item tersebut. Item tanpa BOM tidak bisa dihitung Dev/BOM-nya.' },
  TOLERANCE_NOT_SET: { title: 'Toleransi belum diset', action: 'Set toleransi di master data atau lewat Pengaturan untuk item ini.' },
  DUPLICATE: { title: 'Baris duplikat', action: 'Cek apakah ada baris dengan kombinasi Outlet+Item+Week+Akun yang sama. Hapus duplikat di Excel.' },
  BOM_POSITIVE: { title: 'QTY BOM positif', action: 'Konvensi: QTY BOM harus negatif (konsumsi). Cek tanda di Excel.' },
  ZERO_DEVIATION: { title: 'QTY DEVIASI = 0', action: 'Tidak ada deviasi (normal). Hanya info, tidak perlu tindakan.' },
  OVER_EXPLAINED: { title: 'WASTE+SUSUT+TRIAL > DEVIASI', action: 'Cek pencatatan — kemungkinan double-counting waste/susut/trial atau salah input SPV.' },
};

// ------------------------------------------------------------
//  Types
// ------------------------------------------------------------
interface SourceFileRow {
  id: number;
  fileName: string;
  monthLabel: string;
  monthKey: string;
  rowCount: number;
  dqStatus: string;
  dqErrorCount: number;
  dqWarningCount: number;
  importedAt: string;
}

interface MonthSummary {
  monthLabel: string;
  monthKey: string;
  fileCount: number;
  totalRows: number;
}

interface DataListResponse {
  success: boolean;
  files: SourceFileRow[];
  months: MonthSummary[];
  error?: string;
}

interface DeleteResponse {
  success: boolean;
  deleted: { sourceFiles: number; records: number; weeks: number };
  message?: string;
  error?: string;
}

async function fetchDataList(): Promise<DataListResponse> {
  const res = await fetch('/api/data');
  return res.json();
}

interface DataManagementDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

// ------------------------------------------------------------
//  Dialog
// ------------------------------------------------------------
export function DataManagementDialog({ open, onOpenChange }: DataManagementDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['data-mgmt'],
    queryFn: fetchDataList,
    enabled: open,
  });

  // Delete-by-month picker state
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  // DQ detail expansion state
  const [expandedFileId, setExpandedFileId] = useState<number | null>(null);

  // Reset month picker state when dialog closes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setSelectedMonth('');
    }
  }

  // Fetch DQ issues when a file is expanded
  const { data: dqData, isLoading: dqLoading } = useQuery({
    queryKey: ['dq-issues', expandedFileId],
    queryFn: async () => {
      const res = await fetch(`/api/data?fileId=${expandedFileId}`);
      return res.json();
    },
    enabled: expandedFileId !== null,
  });

  // ---------- Mutations ----------
  const deleteFileMutation = useMutation({
    mutationFn: async (fileId: number) => {
      const res = await fetch(`/api/data?fileId=${fileId}`, { method: 'DELETE' });
      return res.json() as Promise<DeleteResponse>;
    },
    onSuccess: (d) => {
      if (d.success) {
        toast({
          title: '✅ File dihapus',
          description: `${d.deleted.sourceFiles} file · ${d.deleted.records.toLocaleString()} record · ${d.deleted.weeks} week`,
        });
      } else {
        toast({ title: '❌ Gagal menghapus', description: d.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    },
    onError: (e: any) => {
      toast({ title: '❌ Gagal menghapus', description: e?.message || 'Network error', variant: 'destructive' });
    },
  });

  const deleteMonthMutation = useMutation({
    mutationFn: async (month: string) => {
      const res = await fetch(`/api/data?month=${encodeURIComponent(month)}`, { method: 'DELETE' });
      return res.json() as Promise<DeleteResponse>;
    },
    onSuccess: (d) => {
      if (d.success) {
        toast({
          title: '✅ Data bulan dihapus',
          description: `${d.deleted.sourceFiles} file · ${d.deleted.records.toLocaleString()} record · ${d.deleted.weeks} week`,
        });
        setSelectedMonth('');
      } else {
        toast({ title: '❌ Gagal menghapus', description: d.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    },
    onError: (e: any) => {
      toast({ title: '❌ Gagal menghapus', description: e?.message || 'Network error', variant: 'destructive' });
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/data?all=true&confirm=true', { method: 'DELETE' });
      return res.json() as Promise<DeleteResponse>;
    },
    onSuccess: (d) => {
      if (d.success) {
        toast({
          title: '✅ Semua data direset',
          description: `${d.deleted.sourceFiles} file · ${d.deleted.records.toLocaleString()} record · ${d.deleted.weeks} week dihapus`,
          variant: 'destructive',
        });
      } else {
        toast({ title: '❌ Gagal reset', description: d.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    },
    onError: (e: any) => {
      toast({ title: '❌ Gagal reset', description: e?.message || 'Network error', variant: 'destructive' });
    },
  });

  // Invalidate queries after any successful mutation
  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['data-mgmt'] });
    queryClient.invalidateQueries({ queryKey: ['status'] });
    // FIX: Invalidate ALL data-dependent queries, not just analysis
    queryClient.invalidateQueries({ queryKey: ['analysis'] });
    queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
    queryClient.invalidateQueries({ queryKey: ['outlet-focus'] });
    queryClient.invalidateQueries({ queryKey: ['item-history'] });
  }

  // Wrap mutations to invalidate after settle
  function handleDeleteFile(fileId: number, fileName: string) {
    if (!confirm(`Hapus file "${fileName}"?\nSemua record, week, dan DQ issue terkait akan dihapus.`)) return;
    deleteFileMutation.mutate(fileId, { onSettled: invalidateAll });
  }

  function handleDeleteMonth() {
    if (!selectedMonth) return;
    if (!confirm(`Hapus SEMUA data untuk bulan ${selectedMonth}?\nTindakan ini tidak dapat dibatalkan.`)) return;
    deleteMonthMutation.mutate(selectedMonth, { onSettled: invalidateAll });
  }

  function handleDeleteAll() {
    deleteAllMutation.mutate(undefined, { onSettled: invalidateAll });
  }

  // ---------- Render ----------
  const months: MonthSummary[] = data?.months ?? [];
  const files: SourceFileRow[] = data?.files ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Kelola Data
          </DialogTitle>
          <DialogDescription>
            Hapus file sumber, data per bulan, atau reset semua data. Aksi ini <strong>tidak dapat dibatalkan</strong>.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Memuat data...</span>
          </div>
        ) : !data?.success ? (
          <div className="py-8 text-center text-sm text-red-600">
            Gagal memuat data: {data?.error || 'Error tidak diketahui'}
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col gap-4 min-h-0">
            {/* Quick actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 shrink-0">
              {/* Hapus per bulan */}
              <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <CalendarRange className="h-3.5 w-3.5" />
                  Hapus per Bulan
                </div>
                <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Pilih bulan..." />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((m) => (
                      <SelectItem key={m.monthKey} value={m.monthLabel} className="text-xs">
                        {m.monthLabel} ({m.fileCount} file · {m.totalRows.toLocaleString()} baris)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full text-xs border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  disabled={!selectedMonth || deleteMonthMutation.isPending}
                  onClick={handleDeleteMonth}
                >
                  {deleteMonthMutation.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Menghapus...</>
                  ) : (
                    <><Trash2 className="h-3 w-3 mr-1" /> Hapus Bulan Ini</>
                  )}
                </Button>
              </div>

              {/* Reset semua */}
              <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
                  <Bomb className="h-3.5 w-3.5" />
                  Reset Semua Data
                </div>
                <p className="text-[11px] text-red-700 dark:text-red-300/80 leading-relaxed">
                  Hapus <strong>SEMUA</strong> SourceFile, InventoryRecord, Week, dan DQIssue. Tidak dapat dibatalkan.
                </p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-8 w-full text-xs"
                      disabled={deleteAllMutation.isPending || files.length === 0}
                    >
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Reset Semua Data
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Reset SEMUA data?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Tindakan ini akan menghapus seluruh {files.length} file, semua record inventory, semua week, dan semua DQ issue.
                        <br />
                        <br />
                        <strong className="text-red-600">Tidak dapat dibatalkan.</strong> Pastikan Anda memiliki backup sebelum melanjutkan.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Batal</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDeleteAll}
                        className="bg-red-600 hover:bg-red-700 text-white"
                      >
                        {deleteAllMutation.isPending ? (
                          <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Menghapus...</>
                        ) : (
                          'Ya, Reset Semua'
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            {/* File list */}
            <div className="flex-1 min-h-0 flex flex-col border rounded-md">
              <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30 shrink-0">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  File Sumber ({files.length})
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => refetch()}
                  disabled={isLoading}
                >
                  <Loader2 className={`h-3 w-3 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {files.length === 0 ? (
                  <div className="py-10 text-center text-xs text-muted-foreground">
                    Tidak ada file sumber. Import data terlebih dahulu.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[11px] h-8">File</TableHead>
                        <TableHead className="text-[11px] h-8">Bulan</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">Baris</TableHead>
                        <TableHead className="text-[11px] h-8">DQ</TableHead>
                        <TableHead className="text-[11px] h-8">Import</TableHead>
                        <TableHead className="text-[11px] h-8 text-right">Aksi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {files.map((f) => (
                        <React.Fragment key={f.id}>
                          <TableRow>
                            <TableCell className="text-[11px] py-2 max-w-[220px]">
                              <div className="truncate" title={f.fileName}>{f.fileName}</div>
                            </TableCell>
                            <TableCell className="text-[11px] py-2 whitespace-nowrap">{f.monthLabel}</TableCell>
                            <TableCell className="text-[11px] py-2 text-right tabular-nums">
                              {f.rowCount.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-[11px] py-2">
                              <button
                                onClick={() => setExpandedFileId(expandedFileId === f.id ? null : f.id)}
                                className="inline-flex items-center gap-1 hover:underline"
                                title="Klik untuk lihat detail DQ"
                              >
                                {expandedFileId === f.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                <Badge
                                  variant="outline"
                                  className={
                                    f.dqStatus === 'OK'
                                      ? 'text-[10px] text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800'
                                      : f.dqStatus === 'WARNING'
                                        ? 'text-[10px] text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800'
                                        : 'text-[10px] text-red-700 border-red-300 dark:text-red-300 dark:border-red-800'
                                  }
                                >
                                  {f.dqStatus}
                                  {(f.dqErrorCount > 0 || f.dqWarningCount > 0) && (
                                    <span className="ml-1">({f.dqErrorCount}E/{f.dqWarningCount}W)</span>
                                  )}
                                </Badge>
                              </button>
                            </TableCell>
                            <TableCell className="text-[11px] py-2 whitespace-nowrap text-muted-foreground">
                              {new Date(f.importedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: '2-digit' })}
                            </TableCell>
                            <TableCell className="text-[11px] py-2 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
                                disabled={deleteFileMutation.isPending}
                                onClick={() => handleDeleteFile(f.id, f.fileName)}
                                title={`Hapus ${f.fileName}`}
                              >
                                <Trash2 className="h-3 w-3 mr-1" />
                                Hapus
                              </Button>
                            </TableCell>
                          </TableRow>
                          {/* DQ Detail Expandable Row */}
                          {expandedFileId === f.id && (
                            <TableRow key={`${f.id}-dq`}>
                              <TableCell colSpan={6} className="py-3 px-4 bg-muted/30">
                                {dqLoading ? (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    Memuat DQ issues...
                                  </div>
                                ) : dqData?.success ? (
                                  <div className="space-y-2">
                                    <p className="text-[11px] font-semibold flex items-center gap-1.5">
                                      <Bug className="h-3 w-3" />
                                      Detail Data Quality — {f.fileName}
                                    </p>
                                    {dqData.summary.length === 0 ? (
                                      <p className="text-[11px] text-emerald-600">✅ Tidak ada DQ issues. Data bersih.</p>
                                    ) : (
                                      <div className="space-y-1.5">
                                        {dqData.summary.map((s: any, i: number) => {
                                          const fix = DQ_FIXES[s.code] || { title: s.code, action: 'Tidak ada saran tersedia.' };
                                          return (
                                            <div key={i} className={`rounded-md border p-2 ${s.severity === 'ERROR' ? 'border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900' : s.severity === 'WARNING' ? 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900' : 'border-sky-200 bg-sky-50 dark:bg-sky-950/20 dark:border-sky-900'}`}>
                                              <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                  <Badge variant="outline" className={`text-[9px] shrink-0 ${s.severity === 'ERROR' ? 'text-red-700 border-red-300' : s.severity === 'WARNING' ? 'text-amber-700 border-amber-300' : 'text-sky-700 border-sky-300'}`}>
                                                    {s.severity}
                                                  </Badge>
                                                  <span className="text-[11px] font-medium truncate">{fix.title}</span>
                                                  <span className="text-[10px] text-muted-foreground shrink-0">×{s.count}</span>
                                                </div>
                                              </div>
                                              <p className="text-[11px] text-muted-foreground mt-1">{s.message}</p>
                                              <div className="mt-1.5 flex items-start gap-1.5">
                                                <span className="text-[10px] font-semibold text-foreground shrink-0">🔧 Tindakan:</span>
                                                <span className="text-[10px] text-muted-foreground">{fix.action}</span>
                                              </div>
                                            </div>
                                          );
                                        })}
                                        <div className="pt-1.5 border-t mt-1.5">
                                          <p className="text-[10px] text-muted-foreground">
                                            💡 Setelah memperbaiki Excel, hapus file ini lalu import ulang untuk update data.
                                          </p>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <p className="text-xs text-red-600">Gagal memuat DQ issues: {dqData?.error || 'Error tidak diketahui'}</p>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="border-t pt-3 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Tutup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
