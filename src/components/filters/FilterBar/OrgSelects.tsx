'use client';

// ============================================================
//  OrgSelects — the 4 org-filter SearchableComboBoxes (PIC, Area,
//  Kelompok, Outlet). Moved verbatim from FilterBar.tsx's
//  `orgSelects()` render helper (SPLIT-C pure code motion — zero
//  behavior change). Props are typed with Pick<FilterBarState, ...>
//  so the value/setter signatures cannot drift from the store.
//  SPEC-1 (§16.1): shared filter fields — the 4 org comboboxes bind
//  to the SAME zustand state + handlers as the pre-split helper.
// ============================================================

import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import type { FilterBarState } from './use-filter-bar-state';

export type OrgSelectsProps = Pick<
  FilterBarState,
  | 'pics'
  | 'areas'
  | 'kelompokOptions'
  | 'outlets'
  | 'pic'
  | 'area'
  | 'kelompok'
  | 'outletCode'
  | 'setPic'
  | 'setArea'
  | 'setKelompok'
  | 'setOutlet'
>;

export function OrgSelects(props: OrgSelectsProps) {
  const {
    pics,
    areas,
    kelompokOptions,
    outlets,
    pic,
    area,
    kelompok,
    outletCode,
    setPic,
    setArea,
    setKelompok,
    setOutlet,
  } = props;

  return (
    <>
      <SearchableComboBox
        options={pics.map((p) => ({ value: p, label: p }))}
        value={pic}
        onValueChange={setPic}
        placeholder="Semua PIC"
        searchPlaceholder="Cari PIC..."
        emptyText="PIC tidak ditemukan."
        allOptionLabel={`Semua PIC (${pics.length})`}
        buttonClassName="min-w-[120px]"
        ariaLabel="Filter PIC"
      />

      <SearchableComboBox
        options={areas.map((a) => ({ value: a, label: a }))}
        value={area}
        onValueChange={setArea}
        placeholder="Semua Area"
        searchPlaceholder="Cari area..."
        emptyText="Area tidak ditemukan."
        allOptionLabel={`Semua Area (${areas.length})`}
        buttonClassName="min-w-[120px]"
        ariaLabel="Filter Area"
      />

      <SearchableComboBox
        options={kelompokOptions.map((k) => ({
          value: k.kelompok,
          label: k.kelompok,
          description: `${k.area} · ${k.outletCount} outlet`,
        }))}
        value={kelompok}
        onValueChange={setKelompok}
        placeholder="Semua Kelompok"
        searchPlaceholder="Cari kelompok..."
        emptyText="Kelompok tidak ditemukan."
        allOptionLabel={`Semua Kelompok (${kelompokOptions.length})`}
        buttonClassName="min-w-[120px]"
        ariaLabel="Filter Kelompok"
      />

      <SearchableComboBox
        options={outlets.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}`, description: o.area }))}
        value={outletCode}
        onValueChange={setOutlet}
        placeholder="Semua Outlet"
        searchPlaceholder="Cari outlet (kode/nama)..."
        emptyText="Outlet tidak ditemukan."
        allOptionLabel={`Semua Outlet (${outlets.length})`}
        buttonClassName="min-w-[150px]"
        ariaLabel="Filter Outlet"
      />
    </>
  );
}
