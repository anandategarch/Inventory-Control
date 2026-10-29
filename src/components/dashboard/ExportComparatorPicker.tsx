'use client';

// ============================================================
//  ExportComparatorPicker — CUSTOM-COMPARE (section 13) comparator UI
//  --------------------------------------------------------
//  User request: "misal aku pilih resto mlgpar terus sebagai pembanding
//  nya aku pilih resto lain lagi yaitu bdgsek nah ini bisa export laporan
//  pdf. atau aku juga bisa filter beberapa resto atau filer pakai area
//  gitu maksud nya" — rendered inside ExportDialog whenever section 13
//  "Komparasi Pilihan" is active: pick the comparator restos (searchable
//  checkbox list over the status cache's outlets — no extra request) and
//  / or whole areas (checkbox grid). The focus resto is NOT picked here —
//  it follows the Resto tab's Filter Resto (the outlet= param, same
//  convention as sections 9/11) and is shown as a read-only chip.
// ============================================================

import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Building2, MapPin, Search, X } from 'lucide-react';

export interface ComparatorOutlet {
  code: string;
  name: string;
  area: string;
}

interface ExportComparatorPickerProps {
  /** Every outlet (the /api/status cache — no extra fetch). */
  outlets: ComparatorOutlet[];
  /** Every area name. */
  areas: string[];
  /** The Resto tab's Filter Resto code (the export's focus resto). */
  focusOutlet: string | null;
  /** The focus outlet's display name (resolved by the caller). */
  focusOutletName: string | null;
  selectedOutlets: string[];
  selectedAreas: string[];
  onChange: (outlets: string[], areas: string[]) => void;
}

export function ExportComparatorPicker({
  outlets,
  areas,
  focusOutlet,
  focusOutletName,
  selectedOutlets,
  selectedAreas,
  onChange,
}: ExportComparatorPickerProps) {
  const [outletQuery, setOutletQuery] = useState('');

  // The focus resto is never a comparator (the server dedupes too — one
  // amber row, not two); it is hidden from the picker list entirely so
  // the count the user sees matches the PDF's comparator rows.
  const outletOptions = useMemo(
    () => outlets.filter((o) => o.code !== focusOutlet),
    [outlets, focusOutlet],
  );

  const filteredOutlets = useMemo(() => {
    const q = outletQuery.trim().toLowerCase();
    if (!q) return outletOptions;
    return outletOptions.filter(
      (o) =>
        o.code.toLowerCase().includes(q) ||
        o.name.toLowerCase().includes(q) ||
        o.area.toLowerCase().includes(q),
    );
  }, [outletOptions, outletQuery]);

  const toggleOutlet = (code: string) => {
    const next = selectedOutlets.includes(code)
      ? selectedOutlets.filter((c) => c !== code)
      : [...selectedOutlets, code];
    onChange(next, selectedAreas);
  };

  const toggleArea = (area: string) => {
    const next = selectedAreas.includes(area)
      ? selectedAreas.filter((a) => a !== area)
      : [...selectedAreas, area];
    onChange(selectedOutlets, next);
  };

  const focusLabel = focusOutlet
    ? `${focusOutletName ? `${focusOutletName} · ` : ''}${focusOutlet}`
    : null;
  const pickedOutletCount = selectedOutlets.filter(
    (c) => c !== focusOutlet,
  ).length;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-500/[0.06] p-3 space-y-3">
      {/* Header — what this panel feeds + the focus provenance */}
      <div className="space-y-1">
        <p className="text-xs font-medium flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
          <Building2 className="h-3.5 w-3.5" />
          Pembanding — Section 13. Komparasi Pilihan
        </p>
        <p className="text-[11px] leading-tight text-muted-foreground">
          Pilih resto dan/atau area pembanding. Resto fokus:{' '}
          {focusLabel ? (
            <Badge variant="outline" className="font-mono text-[10px] mx-0.5 py-0">
              {focusLabel}
            </Badge>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              belum dipilih (mengikuti Filter Resto di tab Resto Analysis)
            </span>
          )}
        </p>
      </div>

      {/* Resto pembanding — searchable checkbox list */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={outletQuery}
              onChange={(e) => setOutletQuery(e.target.value)}
              placeholder="Cari resto pembanding (kode / nama / area)..."
              className="h-8 text-xs pl-7"
              aria-label="Cari resto pembanding"
            />
          </div>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {pickedOutletCount} resto
          </Badge>
        </div>
        <div className="max-h-40 overflow-y-auto rounded-md border bg-background divide-y divide-border/50 pr-1">
          {filteredOutlets.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2.5 py-2">
              Resto tidak ditemukan.
            </p>
          ) : (
            filteredOutlets.map((o) => {
              const on = selectedOutlets.includes(o.code);
              return (
                <label
                  key={o.code}
                  className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer transition-colors ${
                    on ? 'bg-primary/[0.05]' : 'hover:bg-muted/50'
                  }`}
                >
                  <Checkbox
                    checked={on}
                    onCheckedChange={() => toggleOutlet(o.code)}
                    className="h-3.5 w-3.5"
                    aria-label={`${o.code} ${o.name}`}
                  />
                  <span className="text-[11px] font-mono leading-tight text-muted-foreground shrink-0">
                    {o.code}
                  </span>
                  <span className="text-[11px] leading-tight truncate flex-1">
                    {o.name}
                  </span>
                  <span className="text-[10px] leading-tight text-muted-foreground shrink-0">
                    {o.area}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>

      {/* Area pembanding — checkbox grid */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
          Area pembanding (semua resto di area ikut dibandingkan)
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
          {areas.map((a) => {
            const on = selectedAreas.includes(a);
            return (
              <label
                key={a}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 cursor-pointer transition-colors text-[11px] ${
                  on
                    ? 'border-primary/25 bg-primary/[0.05]'
                    : 'border-border hover:bg-muted/40'
                }`}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={() => toggleArea(a)}
                  className="h-3.5 w-3.5"
                  aria-label={`Area ${a}`}
                />
                <span className="leading-tight truncate" title={a}>
                  {a}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Active picks — chips with remove buttons */}
      {(selectedOutlets.length > 0 || selectedAreas.length > 0) && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {selectedOutlets
            .filter((c) => c !== focusOutlet)
            .map((c) => {
              const o = outlets.find((x) => x.code === c);
              return (
                <Badge
                  key={`o-${c}`}
                  variant="secondary"
                  className="text-[10px] gap-1 py-0.5 font-mono"
                >
                  {o ? `${o.name} · ${c}` : c}
                  <button
                    type="button"
                    onClick={() => toggleOutlet(c)}
                    className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                    aria-label={`Hapus pembanding ${c}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              );
            })}
          {selectedAreas.map((a) => (
            <Badge
              key={`a-${a}`}
              variant="outline"
              className="text-[10px] gap-1 py-0.5"
            >
              {a}
              <button
                type="button"
                onClick={() => toggleArea(a)}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label={`Hapus area ${a}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
