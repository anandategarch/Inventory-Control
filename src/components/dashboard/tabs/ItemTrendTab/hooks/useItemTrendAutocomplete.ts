'use client';

// ============================================================
//  useItemTrendAutocomplete — Stage-1 autocomplete state + query
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemTrendTab/index.tsx — no behavior
//  change). Owns:
//    - search input state (`query`) + the 300ms timer debounce
//      (`debouncedQuery`) — PERF-FE (PAKET A)
//    - dropdown open/close state + the outside-click closer effect
//    - the Stage-1 autocomplete useQuery (debounced 300ms — fires
//      only when input is ≥2 chars AND no item is currently
//      selected AND month/week are set)
//
//  Returns everything ItemTrendSearchBar needs (spread-ready),
//  plus `acResults`/`acLoading` for the header wiring.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { AutocompleteResult } from '../types';

export interface UseItemTrendAutocompleteParams {
  monthLabel: string | null;
  currentWeek: string | null;
  selectedItem: string | null;
}

export interface ItemTrendAutocompleteState {
  query: string;
  setQuery: (q: string) => void;
  /** PERF-FE (PAKET A): 300ms-debounced value of `query` — replaced the old
   *  `deferredQuery` (useDeferredValue) which changed on every keystroke. */
  debouncedQuery: string;
  showDropdown: boolean;
  setShowDropdown: (b: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  dropdownRef: RefObject<HTMLDivElement | null>;
  acResults: AutocompleteResult[];
  acLoading: boolean;
}

export function useItemTrendAutocomplete({
  monthLabel,
  currentWeek,
  selectedItem,
}: UseItemTrendAutocompleteParams): ItemTrendAutocompleteState {
  // Local UI state (not in Zustand — only the Trend Item tab cares about these).
  const [query, setQuery] = useState('');
  // PERF-FE (PAKET A): real 300ms debounce. `useDeferredValue` only defers
  // RENDERING — the deferred value still changed on every keystroke, so the
  // autocomplete queryKey below produced a new cache entry (and an HTTP
  // request) per character typed ("ayam goreng" = 9 requests). A timer-based
  // debounce collapses a burst of keystrokes into a single request.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    // Clearing the input propagates instantly (delay 0); typing debounces at
    // 300ms. setState only ever runs inside the timer callback (async), never
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => setDebouncedQuery(query), query === '' ? 0 : 300);
    return () => clearTimeout(t);
  }, [query]);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close autocomplete dropdown when clicking outside.
  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDropdown]);

  // Stage 1: autocomplete (debounced 300ms — see the debounce effect above).
  // Fires only when input is ≥2 chars AND no item is currently selected.
  const { data: acData, isLoading: acLoading } = useQuery<{ results: AutocompleteResult[] }>({
    queryKey: ['item-search', 'autocomplete', 'trend-tab', monthLabel, currentWeek, debouncedQuery],
    queryFn: async () => {
      const p = new URLSearchParams({
        mode: 'autocomplete',
        q: debouncedQuery,
        month: monthLabel || '',
        week: currentWeek || '',
      });
      const res = await fetch(`/api/item-search?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(debouncedQuery.length >= 2 && monthLabel && currentWeek && !selectedItem),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const acResults = acData?.results ?? [];

  return {
    query,
    setQuery,
    debouncedQuery,
    showDropdown,
    setShowDropdown,
    inputRef,
    dropdownRef,
    acResults,
    acLoading,
  };
}
