'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateAllData } from '@/lib/query-invalidation';
import {
  Loader2, Save, X, Search, Users, Upload, Pencil, Check, Trash2, FileSpreadsheet,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToast } from '@/hooks/use-toast';

// ------------------------------------------------------------
//  Types — outlet list comes from /api/status (includes pic field)
// ------------------------------------------------------------
interface OutletRow {
  code: string;
  name: string;
  area: string;
  pic: string | null;
}

interface StatusData {
  success: boolean;
  outlets: OutletRow[];
  error?: string;
}

interface PicListResponse {
  success: boolean;
  pics: Array<{ id: number; outletCode: string; pic: string; updatedAt: string }>;
  error?: string;
}

interface ImportResponse {
  success: boolean;
  imported: number;
  errors: string[];
  errorCount: number;
  error?: string;
}

async function fetchStatus(): Promise<StatusData> {
  const res = await fetch('/api/status');
  return res.json();
}

interface PicManagementDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

// ------------------------------------------------------------
//  Dialog
// ------------------------------------------------------------
export function PicManagementDialog({ open, onOpenChange }: PicManagementDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: status, isLoading } = useQuery({
    queryKey: ['status'],
    queryFn: fetchStatus,
    enabled: open,
  });

  // Search + inline edit state
  const [search, setSearch] = useState('');
  const [filterNoPic, setFilterNoPic] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Import dialog state
  const [importOpen, setImportOpen] = useState(false);
  const [csvContent, setCsvContent] = useState('');

  // Reset transient state when dialog closes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setSearch('');
      setFilterNoPic(false);
      setEditingCode(null);
      setEditValue('');
      setImportOpen(false);
      setCsvContent('');
    }
  }

  const outlets: OutletRow[] = status?.outlets ?? [];

  // Filter by search (code, name, area, pic) + "no PIC only" filter
  const filtered = useMemo(() => {
    let result = outlets;
    // Filter: only show outlets without PIC
    if (filterNoPic) {
      result = result.filter((o) => !o.pic);
    }
    // Search filter
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (o) =>
          o.code.toLowerCase().includes(q) ||
          o.name.toLowerCase().includes(q) ||
          o.area.toLowerCase().includes(q) ||
          (o.pic ?? '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [outlets, search, filterNoPic]);

  const stats = useMemo(() => {
    const total = outlets.length;
    const withPic = outlets.filter((o) => o.pic).length;
    return { total, withPic, without: total - withPic };
  }, [outlets]);

  // ---------- Mutations ----------
  const savePicMutation = useMutation({
    mutationFn: async ({ outletCode, pic }: { outletCode: string; pic: string }) => {
      const res = await fetch('/api/pic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outletCode, pic }),
      });
      return res.json();
    },
    onSuccess: (d) => {
      if (d.success) {
        toast({
          title: '✅ PIC disimpan',
          description: `${d.pic.outletCode} → ${d.pic.pic}`,
        });
        setEditingCode(null);
        setEditValue('');
      } else {
        toast({ title: '❌ Gagal menyimpan', description: d.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    },
    onError: (e: any) => {
      toast({ title: '❌ Gagal menyimpan', description: (e instanceof Error ? e.message : 'Network error'), variant: 'destructive' });
    },
  });

  const deletePicMutation = useMutation({
    mutationFn: async (outletCode: string) => {
      const res = await fetch(`/api/pic?outletCode=${encodeURIComponent(outletCode)}`, { method: 'DELETE' });
      return res.json();
    },
    onSuccess: (d) => {
      if (d.success) {
        toast({ title: '✅ PIC dihapus' });
      } else {
        toast({ title: '❌ Gagal menghapus', description: d.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    },
    onError: (e: any) => {
      toast({ title: '❌ Gagal menghapus', description: (e instanceof Error ? e.message : 'Network error'), variant: 'destructive' });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch('/api/pic/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvContent: content }),
      });
      return res.json() as Promise<ImportResponse>;
    },
    onSuccess: (d) => {
      if (d.success) {
        toast({
          title: '✅ Import PIC selesai',
          description: `${d.imported} PIC berhasil diimpor${d.errorCount > 0 ? ` (${d.errorCount} error)` : ''}`,
        });
        setCsvContent('');
        setImportOpen(false);
      } else {
        toast({ title: '❌ Gagal import', description: d.error || 'Error tidak diketahui', variant: 'destructive' });
      }
    },
    onError: (e: any) => {
      toast({ title: '❌ Gagal import', description: (e instanceof Error ? e.message : 'Network error'), variant: 'destructive' });
    },
  });

  // FIX (BUG-PIC-STALE): /api/status GET response has Cache-Control: s-maxage=60
  // (CDN caches for 60s). statusCache.clear() in /api/pic POST only clears the
  // server-side in-memory cache — it does NOT clear the CDN edge cache.
  // So invalidateQueries(['status']) triggers a refetch that hits the CDN →
  // returns STALE data for up to 60s → UI doesn't reflect the PIC update.
  //
  // Fix: after mutation, manually fetch fresh /api/status with:
  //   1. ?_t=<timestamp> — cache-buster (different URL = different CDN entry)
  //   2. cache: 'no-store' — bypass browser HTTP cache too
  // Then setQueryData to update TanStack Query cache immediately.
  async function invalidateAll() {
    // 1. Force-refresh status — bypass CDN s-maxage=60 + browser cache
    try {
      const freshRes = await fetch(`/api/status?_t=${Date.now()}`, { cache: 'no-store' });
      if (freshRes.ok) {
        const freshData = await freshRes.json();
        queryClient.setQueryData(['status'], freshData);
      } else {
        // Fallback: invalidate (might serve stale CDN cache)
        queryClient.invalidateQueries({ queryKey: ['status'] });
      }
    } catch {
      queryClient.invalidateQueries({ queryKey: ['status'] });
    }

    // 2. Invalidate ALL data-dependent queries — PIC change affects filters.
    //    These use DB-level AggregationCache (properly cleared by /api/pic POST
    //    via invalidateAnalysisCache), so invalidateQueries triggers a real refetch.
    //    FIX (H-14/T3): shared 18-key helper — the old 5-key subset left
    //    pareto/heatmap/trend/flip keys stale in keep-alive tabs.
    invalidateAllData(queryClient);
  }

  // ---------- Handlers ----------
  function startEdit(outlet: OutletRow) {
    setEditingCode(outlet.code);
    setEditValue(outlet.pic ?? '');
  }

  function cancelEdit() {
    setEditingCode(null);
    setEditValue('');
  }

  function saveEdit(outletCode: string) {
    const pic = editValue.trim();
    if (!pic) {
      toast({ title: '❌ PIC tidak boleh kosong', variant: 'destructive' });
      return;
    }
    savePicMutation.mutate({ outletCode, pic }, { onSettled: invalidateAll });
  }

  function removePic(outletCode: string) {
    if (!confirm(`Hapus PIC untuk outlet ${outletCode}?`)) return;
    deletePicMutation.mutate(outletCode, { onSettled: invalidateAll });
  }

  function handleImport() {
    if (!csvContent.trim()) {
      toast({ title: '❌ CSV kosong', description: 'Tempel konten CSV terlebih dahulu', variant: 'destructive' });
      return;
    }
    importMutation.mutate(csvContent, { onSettled: invalidateAll });
  }

  // ---------- Render ----------
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[820px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Kelola PIC
          </DialogTitle>
          <DialogDescription>
            Atur Person in Charge untuk setiap outlet. Klik kolom PIC untuk mengedit, atau import massal dari CSV.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Memuat data...</span>
          </div>
        ) : !status?.success ? (
          <div className="py-8 text-center text-sm text-red-600">
            Gagal memuat data: {status?.error || 'Error tidak diketahui'}
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col gap-3 min-h-0">
            {/* Stats + actions */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Badge variant="outline" className="text-[11px]">
                <Users className="h-3 w-3 mr-1" />
                {stats.total} outlet
              </Badge>
              <Badge variant="outline" className="text-[11px] text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800">
                {stats.withPic} ada PIC
              </Badge>
              <Badge variant="outline" className="text-[11px] text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800">
                {stats.without} belum ada PIC
              </Badge>
              {stats.without > 0 && (
                <Button
                  variant={filterNoPic ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setFilterNoPic((v) => !v)}
                >
                  {filterNoPic ? '✓ Tampilkan semua' : 'Lihat yang belum ada PIC'}
                </Button>
              )}
              <div className="flex-1" />
              <Button
                variant="secondary"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setImportOpen((v) => !v)}
              >
                <Upload className="h-3.5 w-3.5 mr-1" />
                {importOpen ? 'Tutup Import' : 'Import PIC.csv'}
              </Button>
            </div>

            {/* Import panel (collapsible) */}
            {importOpen && (
              <div className="rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-2 shrink-0">
                <Label htmlFor="csv-input" className="text-xs font-medium flex items-center gap-1.5">
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Tempel Konten CSV (format: <code>RESTO;PIC</code> atau <code>RESTO,PIC</code>)
                </Label>
                <Textarea
                  id="csv-input"
                  value={csvContent}
                  onChange={(e) => setCsvContent(e.target.value)}
                  placeholder={`RESTO;PIC\n1030.BDGSET;Budi Santoso\n1001.MLGPAR;Siti Aminah\n...`}
                  className="text-[11px] font-mono min-h-[120px] max-h-[180px]"
                  disabled={importMutation.isPending}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    Baris header &quot;RESTO;PIC&quot; akan dilewati otomatis. Mendukung delimiter <code>;</code> atau <code>,</code>.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setCsvContent('')}
                      disabled={importMutation.isPending || !csvContent}
                    >
                      <X className="h-3 w-3 mr-1" /> Bersihkan
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 text-xs"
                      onClick={handleImport}
                      disabled={importMutation.isPending || !csvContent.trim()}
                    >
                      {importMutation.isPending ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Mengimpor...</>
                      ) : (
                        <><Upload className="h-3 w-3 mr-1" /> Import Sekarang</>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Search bar */}
            <div className="relative shrink-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari outlet (kode, nama, area, PIC)..."
                className="h-9 pl-8 text-xs"
              />
            </div>

            {/* Outlet table */}
            <div className="flex-1 min-h-0 border rounded-md overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow>
                    <TableHead className="text-[11px] h-8">Kode</TableHead>
                    <TableHead className="text-[11px] h-8">Nama Outlet</TableHead>
                    <TableHead className="text-[11px] h-8">Area</TableHead>
                    <TableHead className="text-[11px] h-8 min-w-[220px]">PIC</TableHead>
                    <TableHead className="text-[11px] h-8 text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-8">
                        Tidak ada outlet sesuai filter.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((o) => {
                      const isEditing = editingCode === o.code;
                      return (
                        <TableRow key={o.code}>
                          <TableCell className="text-[11px] py-1.5 font-mono whitespace-nowrap">{o.code}</TableCell>
                          <TableCell className="text-[11px] py-1.5 max-w-[180px]">
                            <div className="truncate" title={o.name}>{o.name}</div>
                          </TableCell>
                          <TableCell className="text-[11px] py-1.5 whitespace-nowrap text-muted-foreground">{o.area}</TableCell>
                          <TableCell className="text-[11px] py-1.5">
                            {isEditing ? (
                              <div className="flex items-center gap-1">
                                <Input
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="h-7 text-xs flex-1"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveEdit(o.code);
                                    if (e.key === 'Escape') cancelEdit();
                                  }}
                                  placeholder="Nama PIC"
                                  maxLength={100}
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                                  disabled={savePicMutation.isPending}
                                  onClick={() => saveEdit(o.code)}
                                  title="Simpan"
                                >
                                  {savePicMutation.isPending && savePicMutation.variables?.outletCode === o.code ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Check className="h-3 w-3" />
                                  )}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-muted-foreground"
                                  disabled={savePicMutation.isPending}
                                  onClick={cancelEdit}
                                  title="Batal"
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => startEdit(o)}
                                className="group flex items-center gap-1.5 text-left max-w-full"
                                title="Klik untuk mengedit PIC"
                              >
                                <span className={`truncate ${o.pic ? 'text-foreground' : 'text-muted-foreground italic'}`}>
                                  {o.pic || '— belum diset —'}
                                </span>
                                <Pencil className="h-3 w-3 text-muted-foreground/60 opacity-0 group-hover:opacity-100 shrink-0" />
                              </button>
                            )}
                          </TableCell>
                          <TableCell className="text-[11px] py-1.5 text-right">
                            {o.pic && !isEditing && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
                                disabled={deletePicMutation.isPending}
                                onClick={() => removePic(o.code)}
                                title={`Hapus PIC untuk ${o.code}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
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
