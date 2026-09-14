// ============================================================
//  query-invalidation — single source of truth for the client-side
//  "all dashboard data" invalidation list.
//  --------------------------------------------------------
//  FIX (H-14 / UIUX-REVIEW T3): this list (19 keys — BUG-3-b B1 added
//  ['change-analysis']) used to live ONLY
//  inside handleRefresh (useDashboardActions). The six other mutation
//  handlers (FileUploadDialog, DataManagementDialog, DriveImportDialog,
//  FilterBar ingest, SettingsDialog save/reset/migrate, PicManagementDialog)
//  each carried an older 5-6-key subset — every key they missed stayed
//  stale in the browser: keep-alive tabs (forceMount) keep TanStack
//  observers mounted, `refetchOnWindowFocus:false` is set globally, so
//  nothing ever re-asked the server. User-visible consequences:
//    - delete a non-current month → Trend tab still shows the deleted
//      period (item-trend / item-trend-rank / flip-* keys missed);
//    - delete + re-upload a corrected file → Dashboard tab refreshes
//      but Pareto / heatmap / price-effect / drilldown keep showing
//      pre-correction numbers — two tabs, two truths.
//  The SERVER-side AggregationCache is properly cleared by every
//  mutation route — the browser just never refetched.
//
//  Dialog-local keys (['settings'], ['data-mgmt'], ['dq-issues']) are
//  NOT part of this list — they are invalidated by their owning dialog.
// ============================================================
import type { QueryClient } from '@tanstack/react-query';

const ALL_DATA_QUERY_KEYS: readonly (readonly unknown[])[] = [
  // Core dashboard payload + setup queries
  ['analysis'],
  ['status'],
  ['outlet-items'],
  ['item-history'],
  ['peer-comparison'],
  ['recommendations'],
  // Heatmap (['area-item-heatmap'] does NOT prefix-match ['heatmap-cell-detail'])
  ['area-item-heatmap'],
  ['heatmap-cell-detail'],
  // Trend tab
  ['item-trend'],
  ['item-trend-rank'],
  ['item-search'],
  ['item-peer-comparison'],
  ['flip-ranking'],
  ['flip-drilldown'],
  // Pareto + shared widgets
  ['pareto'],
  ['drilldown'],
  ['price-effect'],
  ['item-anomali-outlets'],
  // NOTE: no ['resto-bahan-matrix'] — the orphaned route was deleted in H-10.
  // FIX (BUG-3-b B1): CHANGE-1's "lensa Perubahan" (Prioritas Outlet +
  // ChangeItemTable) queries /api/change-analysis and /api/change-analysis/items
  // under the ['change-analysis'] / ['change-analysis','items',...] keys. They
  // were missing here, so EVERY mutation (upload/delete/reset/drive/ingest/
  // settings/PIC/refresh) left the change lens stale for up to its 5-min
  // staleTime — the exact H-14/T3 class fixed for the 18 keys above. TanStack
  // prefix-matching invalidates both keys from this single entry (the server
  // side already lists 'change-analysis' in aggregation-cache/invalidate.ts).
  ['change-analysis'],
];

/**
 * Invalidate every dashboard data query after ANY mutation that changes
 * server-side data or analysis-affecting settings (upload / delete / reset /
 * ingest / drive import / settings save / direction migration / PIC change).
 * Fire-and-forget by design — mirrors the previous inline calls exactly.
 */
export function invalidateAllData(queryClient: QueryClient): void {
  for (const queryKey of ALL_DATA_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey: [...queryKey] });
  }
}
