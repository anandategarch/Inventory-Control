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
// COMPCAP-1 (BUGHUNT-COMPARE P2): the picker must enforce the SAME caps
// the server's Zod gate applies — without this, a user can legally check
// 31+ restos (the picker lists the whole population) and the export then
// dies with a raw English 400. Single source: export-sections.ts.
import {
  MAX_COMPARE_OUTLETS,
  MAX_COMPARE_AREAS,
} from '@/lib/export-sections';

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
  /** VERSUS-2R — single-pick mode (mode "Versus — 1 Resto vs 1 Resto"):
   *  the list becomes a RADIO picker (clicking another row SWITCHES the
   *  pick), the area grid + cap hints are hidden, and the header copy
   *  says the whole report becomes the duel. */
  single?: boolean;
}

export function ExportComparatorPicker({
  outlets,
  areas,
  focusOutlet,
  focusOutletName,
  selectedOutlets,
  selectedAreas,
  onChange,
  single = false,
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

  // COMPCAP-1 — selections are capped to the server's limits: adding is
  // silently refused at the cap (removal always works); the checkbox list
  // disables unchecked rows and a hint explains why, so the limit is
  // discoverable instead of a surprise 400 at export time.
  // VERSUS-2R (`single`): the cap is ONE and clicking another row
  // SWITCHES the pick (radio semantics — the cap-block pattern would lock
  // the user into their first pick forever).
  const pickedOutletCount = selectedOutlets.filter(
    (c) => c !== focusOutlet,
  ).length;
  const atOutletCap = single ? pickedOutletCount >= 1 : pickedOutletCount >= MAX_COMPARE_OUTLETS;
  const atAreaCap = selectedAreas.length >= MAX_COMPARE_AREAS;

  const toggleOutlet = (code: string) => {
    if (single) {
      // Radio: pick the clicked row, or clear it when re-clicked.
      const next = selectedOutlets.includes(code) ? [] : [code];
      onChange(next, []);
      return;
    }
    if (
      !selectedOutlets.includes(code) &&
      selectedOutlets.length >= MAX_COMPARE_OUTLETS
    )
      return;
    const next = selectedOutlets.includes(code)
      ? selectedOutlets.filter((c) => c !== code)
      : [...selectedOutlets, code];
    onChange(next, selectedAreas);
  };

  const toggleArea = (area: string) => {
    if (!selectedAreas.includes(area) && selectedAreas.length >= MAX_COMPARE_AREAS)
      return;
    const next = selectedAreas.includes(area)
      ? selectedAreas.filter((a) => a !== area)
      : [...selectedAreas, area];
    onChange(selectedOutlets, next);
  };

  const focusLabel = focusOutlet
    ? `${focusOutletName ? `${focusOutletName} · ` : ''}${focusOutlet}`
    : null;

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${single ? 'border-teal-200 bg-teal-50/40 dark:border-teal-500/30 dark:bg-teal-500/[0.05]' : 'border-amber-200 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-500/[0.06]'}`}>
      {/* Header — what this panel feeds + the focus provenance */}
      <div className="space-y-1">
        <p className={`text-xs font-medium flex items-center gap-1.5 ${single ? 'text-teal-800 dark:text-teal-300' : 'text-amber-800 dark:text-amber-300'}`}>
          <Building2 className="h-3.5 w-3.5" />
          {single
            ? 'Resto pembanding — Mode Versus (seluruh laporan)'
            : 'Pembanding — Section 13. Komparasi Pilihan'}
        </p>
        <p className="text-[11px] leading-tight text-muted-foreground">
          {single
 ? (
            <>
              Pilih SATU resto pembanding — seluruh section 1–12 menjadi laporan
              versus (resto fokus vs resto ini). Resto fokus:{' '}
              {focusLabel ? (
                <Badge variant="outline" className="font-mono text-[10px] mx-0.5 py-0">
                  {focusLabel}
                </Badge>
              ) : (
                <span className="text-teal-700 dark:text-teal-400">
                  belum dipilih (pilih Filter Resto di tab Resto Analysis dulu)
                </span>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
        </p>
      </div>

      {/* Resto pembanding — searchable list (radio in single mode) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={outletQuery}
              onChange={(e) => setOutletQuery(e.target.value)}
              placeholder={single ? 'Cari resto pembanding versus (kode / nama / area)...' : 'Cari resto pembanding (kode / nama / area)...'}
              className="h-8 text-xs pl-7"
              aria-label="Cari resto pembanding"
            />
          </div>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {single ? '1 resto' : `${pickedOutletCount}/${MAX_COMPARE_OUTLETS} resto`}
          </Badge>
        </div>
        {!single && atOutletCap && (
          <p className="text-[10px] leading-tight text-amber-700 dark:text-amber-400">
            Maksimal {MAX_COMPARE_OUTLETS} resto pembanding — untuk cakupan lebih
            luas, gunakan pilihan area di bawah (satu area membawa seluruh resto di dalamnya).
          </p>
        )}
        <div className="max-h-40 overflow-y-auto rounded-md border bg-background divide-y divide-border/50 pr-1">
          {filteredOutlets.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2.5 py-2">
              Resto tidak ditemukan.
            </p>
          ) : (
            filteredOutlets.map((o) => {
              const on = selectedOutlets.includes(o.code);
              // COMPCAP-1: unchecked rows go inert at the cap (removal stays
              // possible; the hint above explains why). Never in single mode
              // — radio rows are always clickable (click = SWITCH).
              const blocked = !single && !on && atOutletCap;
              return (
                <label
                  key={o.code}
                  className={`flex items-center gap-2 px-2.5 py-1.5 transition-colors ${
                    blocked
                      ? 'cursor-not-allowed opacity-45'
                      : on
                        ? 'bg-primary/[0.05] cursor-pointer'
                        : 'hover:bg-muted/50 cursor-pointer'
                  }`}
                >
                  <Checkbox
                    checked={on}
                    disabled={blocked}
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

      {/* Area pembanding — checkbox grid (NOT in single mode: mode versus
          compares ONE resto — an area pick has no meaning there). */}
      {!single && (
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
          Area pembanding (semua resto di area ikut dibandingkan)
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
          {areas.map((a) => {
            const on = selectedAreas.includes(a);
            // COMPCAP-1: unchecked areas go inert at the cap.
            const blocked = !on && atAreaCap;
            return (
              <label
                key={a}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors text-[11px] ${
                  blocked
                    ? 'border-border opacity-45 cursor-not-allowed'
                    : on
                      ? 'border-primary/25 bg-primary/[0.05] cursor-pointer'
                      : 'border-border hover:bg-muted/40 cursor-pointer'
                }`}
              >
                <Checkbox
                  checked={on}
                  disabled={blocked}
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
      )}

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
