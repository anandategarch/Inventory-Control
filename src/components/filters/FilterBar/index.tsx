'use client';

// ============================================================
//  FilterBar — the dashboard filter toolbar (3 period Selects +
//  4 org SearchableComboBoxes + action cluster + the hosted
//  Settings/Data/PIC management dialogs). Split from the former
//  617-line FilterBar.tsx (SPLIT-C pure code motion — zero
//  behavior change). Public surface unchanged: named export
//  `FilterBar` (no props) and the module path
//  `@/components/filters/FilterBar` now resolves to this folder's
//  index.tsx — the sole caller (DashboardHeader) imports exactly
//  as before.
//  Module map:
//    use-filter-bar-state.ts — store subscription + status query +
//                              stale-filter cleanup + derived options +
//                              atomic period handlers
//    use-ingest.ts           — "Sinkron File" action state
//    PeriodSelects.tsx       — 3 period dropdowns (hover-prefetch)
//    OrgSelects.tsx          — 4 org dropdowns
//    FilterActions.tsx       — action buttons cluster
//    lazy-dialogs.tsx        — dynamic() management dialogs
//                              (PERF-FASE1-FE01)
// ============================================================

import { useState } from 'react';
import { RotateCcw, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useFilterBarState } from './use-filter-bar-state';
import { useIngest } from './use-ingest';
import { PeriodSelects } from './PeriodSelects';
import { OrgSelects } from './OrgSelects';
import { FilterActions } from './FilterActions';
import { SettingsDialog, DataManagementDialog, PicManagementDialog } from './lazy-dialogs';

export function FilterBar() {
  const {
    monthLabel,
    currentWeek,
    area,
    kelompok,
    outletCode,
    itemName,
    pic,
    setCompareWeek,
    setPic,
    setArea,
    setKelompok,
    setOutlet,
    reset,
    status,
    isLoading,
    months,
    weeks,
    pics,
    outlets,
    areas,
    kelompokOptions,
    allComparePeriods,
    compareValue,
    activeFilterCount,
    hasActiveFilter,
    handleMonthChange,
    handleWeekChange,
  } = useFilterBarState();

  const { ingesting, ingestMsg, handleIngest } = useIngest();

  // Settings dialog state
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Data management & PIC management dialog state
  const [dataMgmtOpen, setDataMgmtOpen] = useState(false);
  const [picMgmtOpen, setPicMgmtOpen] = useState(false);

  return (
    <>
      {/* REDesign-HEADER: FilterBar now renders BARE content (no Card wrapper).
          The parent in page.tsx wraps this in a single sticky container with
          the header — saves ~100px vertical (no double padding, no labels, no stats row). */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
          <span>Memuat filter...</span>
        </div>
      )}
      {/* Filters row — left side: dropdowns, right side: actions.
          DESKTOP-ONLY (mobile drawer removed): single row layout. */}
      <div className="flex flex-row items-center gap-3">
        {/* Filter dropdowns (no labels; placeholder in dropdown is clear enough) */}
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          {/* D7: active-filter count badge — at-a-glance signal of how many
              of the 5 filters are constraining the data (amber = watch). */}
          {activeFilterCount > 0 && (
            <Badge
              variant="outline"
              className="h-8 shrink-0 rounded-lg border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30 text-xs font-medium"
              aria-label={`${activeFilterCount} filter aktif`}
              title={`${activeFilterCount} filter aktif — klik Reset untuk membersihkan`}
            >
              Filter ({activeFilterCount})
            </Badge>
          )}
          {/* SPEC-1 (§16.1): fields rendered via the shared PeriodSelects /
              OrgSelects subcomponents (single desktop layout). */}
          <PeriodSelects
            isLoading={isLoading}
            status={status}
            months={months}
            weeks={weeks}
            monthLabel={monthLabel}
            currentWeek={currentWeek}
            compareValue={compareValue}
            allComparePeriods={allComparePeriods}
            area={area}
            kelompok={kelompok}
            outletCode={outletCode}
            itemName={itemName}
            pic={pic}
            handleMonthChange={handleMonthChange}
            handleWeekChange={handleWeekChange}
            setCompareWeek={setCompareWeek}
          />

          <OrgSelects
            pics={pics}
            areas={areas}
            kelompokOptions={kelompokOptions}
            outlets={outlets}
            pic={pic}
            area={area}
            kelompok={kelompok}
            outletCode={outletCode}
            setPic={setPic}
            setArea={setArea}
            setKelompok={setKelompok}
            setOutlet={setOutlet}
          />

          {hasActiveFilter && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors active:scale-95"
                  onClick={reset}
                  aria-label="Reset filter aktif"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="ml-1 inline">Reset</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reset filter aktif</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Vertical divider */}
        <div className="w-px self-stretch bg-border/60 my-0.5" aria-hidden />

        {/* Actions — secondary icon-only (with tooltips) + primary actions */}
        <FilterActions
          ingesting={ingesting}
          onIngest={handleIngest}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDataMgmt={() => setDataMgmtOpen(true)}
          onOpenPicMgmt={() => setPicMgmtOpen(true)}
        />
      </div>

      {/* Ingest message (inline, no separate stats row — stats already in footer) */}
      {ingestMsg && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="text-[11px] gap-1 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30 font-medium">
            <AlertTriangle className="h-3 w-3" />
            {ingestMsg}
          </Badge>
        </div>
      )}

      {/* Google Drive Import Dialog — with Folder/File/Sheets tabs */}
      {/* Drive Import Dialog — extracted to separate component */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Data Management Dialog */}
      <DataManagementDialog open={dataMgmtOpen} onOpenChange={setDataMgmtOpen} />

      {/* PIC Management Dialog */}
      <PicManagementDialog open={picMgmtOpen} onOpenChange={setPicMgmtOpen} />

      {/* Local File Upload + Drive Import dialogs: hosted at PAGE level
          since H-14/T1 (see note in lazy-dialogs.tsx). */}
    </>
  );
}
