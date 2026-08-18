'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, RotateCcw, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useToast } from '@/hooks/use-toast';

interface SettingItem {
  key: string;
  label: string;
  description: string;
  category: 'TOLERANCE' | 'GROWTH' | 'PRIORITY' | 'BENCHMARK' | 'GENERAL';
  dataType: 'number' | 'percent' | 'boolean' | 'text';
  defaultValue: string;
  value: string;
  updatedAt: string | null;
}

interface SettingsData {
  success: boolean;
  settings: SettingItem[];
  byCategory: Record<string, SettingItem[]>;
  categories: string[];
  error?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  TOLERANCE: 'Standar Toleransi',
  GROWTH: 'Deteksi Pertumbuhan',
  BENCHMARK: 'Benchmarking',
  PRIORITY: 'Bobot Priority Score',
  GENERAL: 'Umum',
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  TOLERANCE: 'Standar maksimal deviasi yang dianggap wajar. Melebihi ini akan ditandai sebagai WARNING/ABNORMAL.',
  GROWTH: 'Faktor untuk mendeteksi mismatch pertumbuhan (mis. deviasi naik 2x lebih cepat dari sales).',
  BENCHMARK: 'Perbandingan performa outlet terhadap rata-rata area/network/historical.',
  PRIORITY: 'Bobot untuk menghitung operational priority score (semakin tinggi bobot, semakin berpengaruh).',
  GENERAL: 'Pengaturan umum aplikasi.',
};

async function fetchSettings(): Promise<SettingsData> {
  const res = await fetch('/api/settings');
  return res.json();
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    enabled: open,
  });

  // Build initial edit values from server data (memoized — only re-init when settings data changes)
  const initialValues = useMemo(() => {
    if (!data?.settings) return {};
    const map: Record<string, string> = {};
    for (const s of data.settings) {
      map[s.key] = s.value;
    }
    return map;
  }, [data]);

  // Track if user has started editing (controls whether we use initial or edit values)
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [hasEdits, setHasEdits] = useState(false);

  // BUG FIX #005: Reset unsaved edits when dialog closes
  // Using React-recommended pattern (adjust state during render, not in effect)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setHasEdits(false);
      setEditValues({});
    }
  }

  // Get effective values: user edits if any, otherwise initial from server
  const effectiveValues = hasEdits ? editValues : initialValues;

  const dirty = useMemo(() => {
    if (!data?.settings || !hasEdits) return false;
    return data.settings.some((s) => editValues[s.key] !== s.value);
  }, [data, editValues, hasEdits]);

  const changedCount = useMemo(() => {
    if (!data?.settings || !hasEdits) return 0;
    return data.settings.filter((s) => editValues[s.key] !== s.value).length;
  }, [data, editValues, hasEdits]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Only send changed values
      const changed: Record<string, string> = {};
      if (data?.settings) {
        for (const s of data.settings) {
          if (effectiveValues[s.key] !== s.value) {
            changed[s.key] = effectiveValues[s.key];
          }
        }
      }
      if (Object.keys(changed).length === 0) {
        return { success: true, updated: 0 };
      }
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: changed, updatedBy: 'user' }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast({
          title: '✅ Pengaturan tersimpan',
          description: data.updated > 0 ? `${data.updated} pengaturan diperbarui` : 'Tidak ada perubahan',
        });
        setHasEdits(false);
        setEditValues({});
        queryClient.invalidateQueries({ queryKey: ['settings'] });
        // FIX (BUG 3): Invalidate ALL threshold-dependent queries, not just analysis
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
        queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
        queryClient.invalidateQueries({ queryKey: ['item-history'] });
      } else {
        toast({
          title: '❌ Gagal menyimpan',
          description: data.error || 'Error tidak diketahui',
          variant: 'destructive',
        });
      }
    },
    onError: (e: any) => {
      toast({
        title: '❌ Gagal menyimpan',
        description: e?.message || 'Network error',
        variant: 'destructive',
      });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async (key?: string) => {
      const url = key ? `/api/settings?key=${key}` : '/api/settings';
      const res = await fetch(url, { method: 'DELETE' });
      return res.json();
    },
    onSuccess: (data, key) => {
      toast({
        title: '↺ Reset ke default',
        description: key ? `Reset ${key}` : 'Semua pengaturan direset ke default',
      });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      // FIX (BUG 3): Invalidate ALL threshold-dependent queries
      queryClient.invalidateQueries({ queryKey: ['analysis'] });
      queryClient.invalidateQueries({ queryKey: ['outlet-items'] });
      queryClient.invalidateQueries({ queryKey: ['item-history'] });
    },
  });

  function handleChange(key: string, value: string) {
    setEditValues((prev) => {
      // On first edit, seed with current effectiveValues
      const base = hasEdits ? prev : { ...initialValues };
      return { ...base, [key]: value };
    });
    setHasEdits(true);
  }

  function handleSave() {
    saveMutation.mutate();
  }

  function handleResetAll() {
    if (confirm('Reset SEMUA pengaturan ke default? Ini tidak dapat dibatalkan.')) {
      resetMutation.mutate(undefined);
      setHasEdits(false);
      setEditValues({});
    }
  }

  function handleResetOne(key: string, defaultValue: string) {
    // Just reset the edit value locally to default
    setEditValues((prev) => {
      const base = hasEdits ? prev : { ...initialValues };
      return { ...base, [key]: defaultValue };
    });
    setHasEdits(true);
  }

  function formatValueDisplay(value: string, dataType: string): string {
    if (dataType === 'percent') {
      const n = Number(value);
      if (!isNaN(n)) {
        return `${(n * 100).toFixed(2)}%`;
      }
    }
    if (dataType === 'number') {
      const n = Number(value);
      if (!isNaN(n) && n >= 1000) {
        return n.toLocaleString('id-ID');
      }
    }
    return value;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span>⚙️ Pengaturan Standar</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={handleResetAll}
              disabled={resetMutation.isPending}
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset Semua
            </Button>
          </DialogTitle>
          <DialogDescription>
            Atur standar & threshold untuk analisis inventory. Perubahan langsung berlaku di dashboard berikutnya (klik Refresh atau ganti periode).
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Memuat pengaturan...</span>
          </div>
        ) : data?.success ? (
          <>
            <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900 p-2.5 flex items-start gap-2">
              <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-xs text-blue-700 dark:text-blue-300">
                <strong>Tip:</strong> Untuk persen, masukkan nilai 0-1 (mis. 10% = 0.10). Untuk Rupiah, masukkan angka penuh (mis. 1,000,000).
              </div>
            </div>

            <ScrollArea className="h-[50vh] pr-3">
              <div className="space-y-5">
                {data.categories.map((cat) => {
                  const items = data.byCategory[cat] || [];
                  return (
                    <div key={cat} className="space-y-2">
                      <div>
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                          {CATEGORY_LABELS[cat] || cat}
                          <Badge variant="outline" className="text-[11px]">{items.length}</Badge>
                        </h3>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {CATEGORY_DESCRIPTIONS[cat] || ''}
                        </p>
                      </div>
                      <div className="space-y-2">
                        {items.map((s) => {
                          const currentVal = effectiveValues[s.key] ?? s.value;
                          const isChanged = currentVal !== s.value;
                          const isDefault = currentVal === s.defaultValue;
                          return (
                            <div
                              key={s.key}
                              className={`rounded-md border p-2.5 ${isChanged ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800' : 'border-border'}`}
                            >
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="flex-1 min-w-0">
                                  <Label htmlFor={s.key} className="text-xs font-medium">
                                    {s.label}
                                  </Label>
                                  <p className="text-[11px] text-muted-foreground mt-0.5">
                                    {s.description}
                                  </p>
                                </div>
                                <Badge variant="outline" className="text-[9px] shrink-0">
                                  {s.dataType === 'percent' ? '%' : s.dataType}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-2 mt-2">
                                <Input
                                  id={s.key}
                                  type="text"
                                  inputMode={s.dataType === 'number' || s.dataType === 'percent' ? 'decimal' : 'text'}
                                  value={currentVal}
                                  onChange={(e) => handleChange(s.key, e.target.value)}
                                  className="h-8 text-xs flex-1"
                                  placeholder={s.defaultValue}
                                />
                                <div className="text-[11px] text-muted-foreground shrink-0 min-w-[80px] text-right">
                                  {isChanged ? (
                                    <span className="text-amber-600">
                                      sebelumnya: {formatValueDisplay(s.value, s.dataType)}
                                    </span>
                                  ) : isDefault ? (
                                    <span className="text-muted-foreground/60">default</span>
                                  ) : (
                                    <span className="text-emerald-600">kustom</span>
                                  )}
                                </div>
                                {!isDefault && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 px-2 text-xs shrink-0"
                                    onClick={() => handleResetOne(s.key, s.defaultValue)}
                                    title="Reset ke default"
                                  >
                                    <RotateCcw className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>

            <DialogFooter className="border-t pt-3">
              <div className="flex items-center justify-between w-full">
                <div className="text-xs text-muted-foreground">
                  {dirty ? (
                    <span className="text-amber-600 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {changedCount} perubahan belum disimpan
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 className="h-3 w-3" />
                      Semua perubahan tersimpan
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Tutup
                  </Button>
                  <Button onClick={handleSave} disabled={!dirty || saveMutation.isPending}>
                    {saveMutation.isPending ? (
                      <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Menyimpan...</>
                    ) : (
                      <><Save className="h-3.5 w-3.5 mr-1" /> Simpan Perubahan</>
                    )}
                  </Button>
                </div>
              </div>
            </DialogFooter>
          </>
        ) : (
          <div className="py-8 text-center text-sm text-red-600">
            Gagal memuat pengaturan: {data?.error || 'Error tidak diketahui'}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
