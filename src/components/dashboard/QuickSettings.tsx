'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Settings2, Loader2, RotateCcw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

// ============================================================
//  QuickSettings — inline Popover for per-chart settings
//  - Trigger: gear icon (Settings2)
//  - For each setting: Label + Slider + numeric Input + reset button
//  - Debounced (500ms) autosave to /api/settings
//  - On save: invalidate ['settings'] + ['analysis'] queries
//  - All UI text in Indonesian
// ============================================================

export interface QuickSettingItem {
  /** Setting key (must exist in SETTING_DEFINITIONS) */
  key: string;
  /** Short label shown in the popover */
  label: string;
  /** Value type — percent values are stored as 0-1, numbers as raw */
  dataType: 'number' | 'percent';
  /** Slider min (defaults 0) */
  min?: number;
  /** Slider max (defaults 100) */
  max?: number;
  /** Slider step (defaults 1) */
  step?: number;
}

interface QuickSettingsProps {
  settings: QuickSettingItem[];
  /** Optional custom trigger; defaults to gear icon */
  trigger?: React.ReactNode;
  /** Popover alignment */
  align?: 'start' | 'center' | 'end';
}

interface SettingsMap {
  values: Record<string, string>;
  defaults: Record<string, string>;
}

async function fetchSettingsMap(): Promise<SettingsMap> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const values: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  if (data?.success && Array.isArray(data.settings)) {
    for (const s of data.settings) {
      values[s.key] = s.value;
      defaults[s.key] = s.defaultValue;
    }
  }
  return { values, defaults };
}

export function QuickSettings({ settings, trigger, align = 'end' }: QuickSettingsProps) {
  const [open, setOpen] = useState(false);
  // Local edits — only contains keys the user has changed (dirty keys)
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: serverData, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettingsMap,
    enabled: open,
    staleTime: 10_000,
  });

  // Derive effective values from server data + local edits (no setState-in-effect)
  const serverValues = serverData?.values ?? {};
  const defaults = serverData?.defaults ?? {};

  const effectiveValues = useMemo<Record<string, string>>(() => {
    return { ...serverValues, ...localEdits };
  }, [serverValues, localEdits]);

  const dirtyKeys = useMemo<Set<string>>(() => {
    return new Set(Object.keys(localEdits));
  }, [localEdits]);

  const saveMutation = useMutation({
    mutationFn: async (input: { values: Record<string, string> }) => {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: input.values, updatedBy: 'user-quick' }),
      });
      const data = await res.json();
      return { data, savedValues: input.values };
    },
    onSuccess: ({ data, savedValues }) => {
      if (data.success) {
        const count = Object.keys(savedValues).length;
        toast({
          title: '✅ Pengaturan tersimpan',
          description: count > 0 ? `${count} pengaturan diperbarui` : 'Tidak ada perubahan',
        });
        // Only clear keys whose current local value matches what we just saved.
        // If the user edited a key again while a save was in-flight, keep that edit
        // so the next debounce cycle can save the newer value.
        setLocalEdits((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(savedValues)) {
            if (next[k] === v) delete next[k];
          }
          return next;
        });
        queryClient.invalidateQueries({ queryKey: ['settings'] });
        // Force refetch analysis (removes stale data even within staleTime window)
        queryClient.invalidateQueries({ queryKey: ['analysis'], refetchType: 'active' });
        // Also invalidate outlet-focus (thresholds affect anomaly detection there too)
        queryClient.invalidateQueries({ queryKey: ['outlet-focus'], refetchType: 'active' });
      } else {
        toast({
          title: '❌ Gagal menyimpan',
          description: data.error || 'Error tidak diketahui',
          variant: 'destructive',
        });
      }
    },
    onError: (e: unknown) => {
      toast({
        title: '❌ Gagal menyimpan',
        description: e instanceof Error ? e.message : 'Network error',
        variant: 'destructive',
      });
    },
  });

  // Debounced autosave: 500ms after last change
  useEffect(() => {
    if (dirtyKeys.size === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const values = { ...localEdits };
    debounceRef.current = setTimeout(() => {
      if (Object.keys(values).length > 0) {
        saveMutation.mutate({ values });
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [dirtyKeys, localEdits, saveMutation]);

  function handleChange(key: string, value: string) {
    setLocalEdits((prev) => ({ ...prev, [key]: value }));
  }

  function handleReset(key: string) {
    const def = defaults[key];
    if (def != null) {
      handleChange(key, def);
    }
  }

  function flushPending() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (Object.keys(localEdits).length === 0) return;
    saveMutation.mutate({ values: { ...localEdits } });
  }

  function handleOpenChange(next: boolean) {
    if (!next && open) {
      // Closing: flush any pending debounce immediately so user doesn't lose edits
      flushPending();
    }
    setOpen(next);
  }

  // Format display value
  function formatDisplay(s: QuickSettingItem, valStr: string | undefined): string {
    if (valStr == null || valStr === '') return '—';
    const n = Number(valStr);
    if (isNaN(n)) return valStr;
    if (s.dataType === 'percent') return `${(n * 100).toFixed(0)}%`;
    return String(n);
  }

  // Pending changes indicator (subtle dot on the trigger)
  const hasPending = dirtyKeys.size > 0;
  const triggerNode = useMemo(
    () =>
      trigger ?? (
        <button
          type="button"
          className="relative inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Atur pengaturan cepat"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {hasPending && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
          )}
        </button>
      ),
    [trigger, hasPending]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{triggerNode}</PopoverTrigger>
      <PopoverContent align={align} className="w-[280px] p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Pengaturan Cepat</p>
            {saveMutation.isPending && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </div>

          {isLoading && !serverData ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-[11px] text-muted-foreground">Memuat...</span>
            </div>
          ) : (
            <div className="space-y-3">
              {settings.map((s) => {
                const valStr = effectiveValues[s.key] ?? defaults[s.key] ?? '0';
                const valNum = Number(valStr);
                const isNum = !isNaN(valNum);
                const min = s.min ?? 0;
                const max = s.max ?? 100;
                const step = s.step ?? 1;
                const isPercent = s.dataType === 'percent';
                const isDirty = dirtyKeys.has(s.key);

                return (
                  <div key={s.key} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px] font-medium text-muted-foreground">
                        {s.label}
                      </Label>
                      <span
                        className={`text-[11px] font-semibold tabular-nums ${
                          isDirty ? 'text-amber-600' : ''
                        }`}
                      >
                        {formatDisplay(s, valStr)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Slider
                        value={[isNum ? valNum : min]}
                        min={min}
                        max={max}
                        step={step}
                        onValueChange={(v) => {
                          const n = v[0];
                          // For percent, store raw 0-1; for number, store raw
                          handleChange(s.key, String(n));
                        }}
                        className="flex-1"
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={valStr}
                        min={min}
                        max={max}
                        step={step}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '' || v === '-') return;
                          handleChange(s.key, v);
                        }}
                        className="h-7 w-16 text-xs"
                        aria-label={s.label}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0"
                        onClick={() => handleReset(s.key)}
                        title="Reset ke default"
                        aria-label={`Reset ${s.label} ke default`}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    </div>
                    {isPercent && (
                      <p className="text-[10px] text-muted-foreground/80">
                        Nilai 0–1 (mis. 0.5 = 50%)
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground pt-1.5 border-t leading-relaxed">
            Perubahan disimpan otomatis. Chart akan diperbarui otomatis setelah simpan.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
