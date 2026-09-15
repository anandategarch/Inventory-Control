'use client';

// ============================================================
//  lazy-dialogs — PERF-FASE1-FE01: Lazy-load modal dialogs via
//  next/dynamic. Moved verbatim from FilterBar.tsx (SPLIT-C pure
//  code motion).
//  These dialogs are modal-only (rendered when `open` is true), but
//  static imports pull their code + ALL transitive deps into the main
//  bundle even when the dialogs are never opened. Lazy-loading saves
//  ~80-120KB from the initial bundle (FileUploadDialog 841L,
//  DataManagementDialog 486L, PicManagementDialog 469L,
//  SettingsDialog 444L, DriveImportDialog 278L).
//  The dialog chunk loads on-demand when the user first opens the
//  dialog.
// ============================================================

import dynamic from 'next/dynamic';

// Lazy-loaded dialogs (code-split — only loaded when first opened)
export const SettingsDialog = dynamic(
  () => import('@/components/filters/SettingsDialog').then(m => ({ default: m.SettingsDialog })),
  { ssr: false, loading: () => null },
);
export const DataManagementDialog = dynamic(
  () => import('@/components/filters/DataManagementDialog').then(m => ({ default: m.DataManagementDialog })),
  { ssr: false, loading: () => null },
);
export const PicManagementDialog = dynamic(
  () => import('@/components/filters/PicManagementDialog').then(m => ({ default: m.PicManagementDialog })),
  { ssr: false, loading: () => null },
);
// FIX (H-14/T1): FileUploadDialog + DriveImportDialog moved to page.tsx.
// FilterBar is only mounted when hasData (DashboardHeader gates it) — exactly
// the INVERSE of when EmptyState (whose CTAs dispatch open-upload-dialog /
// open-drive-dialog) is visible, so on a fresh DB the CTAs were dead. The
// dialogs + their single event listener now live at page level; the buttons
// in FilterActions dispatch the same events so there is exactly ONE listener
// and ONE dialog mount app-wide (no double-open race from ErrorState's CTA).
