'use client';

// ============================================================
//  ItemTrendSearchBar — Autocomplete Search Bar
//  --------------------------------------------------------
//  Debounced autocomplete input (uses /api/item-search?mode=autocomplete
//  via useQuery in parent). Renders the input + clear button + dropdown
//  of results. The parent owns state + TanStack Query; this component
//  is purely presentational (state flows in via props).
//
//  Pattern reused: GlobalItemSearchModal (debounced autocomplete +
//  outside-click close handled in parent via useEffect).
// ============================================================

import type { RefObject } from 'react';
import { Input } from '@/components/ui/input';
import { Loader2, Package, Search, X } from 'lucide-react';
import { fmtIDR } from '@/lib/format';
import type { AutocompleteResult } from './types';

export interface ItemTrendSearchBarProps {
  query: string;
  setQuery: (q: string) => void;
  showDropdown: boolean;
  setShowDropdown: (b: boolean) => void;
  debouncedQuery: string;
  // ^ PERF-FE (PAKET A): 300ms-debounced value of `query` — replaced the old
  // `deferredQuery` (useDeferredValue) which changed on every keystroke.
  selectedItem: string | null;
  setSelectedItem: (item: string | null) => void;
  acResults: AutocompleteResult[];
  acLoading: boolean;
  monthLabel: string | null;
  currentWeek: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  dropdownRef: RefObject<HTMLDivElement | null>;
}

export function ItemTrendSearchBar({
  query,
  setQuery,
  showDropdown,
  setShowDropdown,
  debouncedQuery,
  // ^ PERF-FE (PAKET A): 300ms-debounced value of `query` (see parent).
  selectedItem,
  setSelectedItem,
  acResults,
  acLoading,
  monthLabel,
  currentWeek,
  inputRef,
  dropdownRef,
}: ItemTrendSearchBarProps) {
  return (
    <div className="relative flex-1" ref={dropdownRef}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => setShowDropdown(true)}
        placeholder={selectedItem ? selectedItem : "Cari item (mis: CABAI, MINYAK MIE, BAWANG)..."}
        className="pl-9 pr-9 h-9"
        aria-label="Cari item untuk trend"
      />
      {acLoading && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {selectedItem && (
        <button
          onClick={() => {
            setSelectedItem(null);
            setQuery('');
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted/60 transition-colors"
          aria-label="Hapus pilihan item"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Autocomplete dropdown */}
      {showDropdown && debouncedQuery.length >= 2 && (
        <div className="absolute z-30 left-0 right-0 mt-1 max-h-72 overflow-auto rounded-md border bg-background shadow-lg">
          {(!monthLabel || !currentWeek) ? (
            <div className="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground">
              <Package className="h-6 w-6 mb-1 opacity-30" />
              Pilih bulan dan minggu di header terlebih dahulu
            </div>
          ) : acLoading ? (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> Mencari...
            </div>
          ) : acResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground">
              <Package className="h-6 w-6 mb-1 opacity-30" />
              Tidak ada item ditemukan untuk &ldquo;{debouncedQuery}&rdquo;
            </div>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground px-3 pt-2 pb-1 border-b">
                {acResults.length} item — klik untuk lihat tren
              </p>
              {acResults.map((r) => (
                <button
                  key={r.itemName}
                  onClick={() => {
                    setSelectedItem(r.itemName);
                    setQuery('');
                    setShowDropdown(false);
                  }}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium truncate" title={r.itemName}>{r.itemName}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {r.outletCount} outlet · {fmtIDR(r.totalAbsNominal)}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
