---
Task ID: SPLIT-C
Agent: full-stack-developer
Task: Refactor murni (TIDAK menulis fitur baru) — pecah 2 god-file menjadi modul kecil (<250 baris/file) dengan public import path yang tidak berubah: (1) `src/components/filters/FileUploadDialog/use-upload-pipeline.ts` (662 baris, hook state-machine upload 3-phase) → entry tipis + folder `pipeline/`; (2) `src/components/filters/FilterBar.tsx` (617 baris, bar filter dashboard) → folder `FilterBar/` dengan `index.tsx` + subkomponen + hook, file lama DIHAPUS.

Work Log:
- Baca konteks: `tail -n 150 worklog.md` (pola sukses SPLIT-GOD-FILE commit b4b37d2: orkestrator tipis + modul per section) + `agent-ctx/SPLIT-COMPONENTS-component-splitter.md` (konvensi: subfolder modul + thin wrapper re-export untuk backward-compat).
- Baca penuh kedua file target + verifikasi caller SEBELUM coding:
  - `use-upload-pipeline` dipakai 3 file di dalam folder FileUploadDialog saja: `index.tsx` (`import { useUploadPipeline } from './use-upload-pipeline'`), `ConfirmPanel.tsx` (`import type { DetectResult }`), `ImportResultSummary.tsx` (`import type { UploadResult }`).
  - `FilterBar` dipakai 1 file luar domain: `src/components/dashboard/DashboardHeader.tsx:18` (`import { FilterBar } from '@/components/filters/FilterBar'`, named export tanpa props). Tidak ada import relative `./FilterBar` lain; `rg -l ... tests/` → TIDAK ada test yang menyentuh kedua modul (exit 1).
  - Simpan baseline verifikasi SEBELUM split: `bunx tsc --noEmit` = 0 error; `bunx eslint` pada 2 file domain = 0 error, 6 warning (3 di use-upload-pipeline: `'open'` unused-param-name + 2× `any`; 3 di FilterBar: 3× `any` di handleIngest).
- SPLIT use-upload-pipeline.ts (662 → 6 file, pola "orkestrator tipis + modul stages" ala b4b37d2):
  - `pipeline/types.ts` (147): WeekResult/UploadResult/DetectResult/UploadPipeline (public, dipindah verbatim) + FileMeta/ManualValidation/PipelineDeps (internal — semua input state, refs, fetchWithTimeout, toast, queryClient, dan 9 setter yang dibutuhkan stage).
  - `pipeline/abort.ts` (62, 'use client'): konstanta UPLOAD_CHUNK_TIMEOUT_MS/DETECT_TIMEOUT_MS/IMPORT_TIMEOUT_MS + `isAbortError` + `usePipelineAbort({ onUnlock })` — pemilik abortControllersRef/cancelRequestedRef/fetchWithTimeout/cancel (semua komentar FIX BUG-3-b B3 dipindah verbatim). `onUnlock` = unlockBusy di host (setUploading(false)+setImporting(false)) dipanggil di AKHIR cancel() persis di posisi setter asli → urutan cancel identik; identitas cancel tetap stabil antar-render (useCallback deps [onUnlock], onUnlock stabil karena deps [] pada setter stabil).
  - `pipeline/file-selection.ts` (52): `onFileSelect`/`onFileDrop` → `applySelectedFile` — dua handler asli punya urutan validasi+setState byte-identik; pesan error verbatim (`Format file tidak didukung: .${ext}...`, `File terlalu besar: ...Maksimal 50MB.`).
  - `pipeline/upload-detect-stage.ts` (250): PHASE 1+2 verbatim (hash SHA-256 → chunk paralel 3-concurrency dengan last-chunk ditahan → detect → short-circuit "semua week sudah ada" → set detectData + berhenti di panel konfirmasi). Closure variable jadi destructured PipelineDeps; semua statusLog/progress/toast/error/catch-cancel branch tidak berubah.
  - `pipeline/import-stage.ts` (161): PHASE 3 verbatim (mode import-all → loop importedWeeks → cleanup DELETE temp → result → invalidateAllData 18-key → toast).
  - `use-upload-pipeline.ts` (211, tetap 'use client' di path SAMA): deklarasi state verbatim + `export type { WeekResult, UploadResult, DetectResult, UploadPipeline } from './pipeline/types'` (barrel — keempat simbol tetap bisa diimport dari path lama) + `useUploadPipeline({ onOpenChange })` signature sama; deps object dibangun ULANG SETIAP render (closure asli juga re-created tiap render) lalu di-pass ke stage plain-function; reset/handleClose/handleEditName/clearFile/isBusy/showConfirm/return-object verbatim.
- SPLIT FilterBar.tsx (617 → folder `FilterBar/` 7 file) lalu HAPUS `FilterBar.tsx` (tidak dibiarkan ko-eksist — resolusi modul tunggal via `FilterBar/index.tsx`; caller `@/components/filters/FilterBar` resolve otomatis ke index folder):
  - `use-filter-bar-state.ts` (225, 'use client'): subscription `useDashboard(useShallow(...))` selector verbatim + `useStatus()` + effect pembersih filter basi (BUG-FE-9) + derived (months/weeks/pics/kelompokOptions/outlets memo PERF-05/areas/allComparePeriods BUG-2-b/compareValue/activeFilterCount VH-3) + handler atomik handleMonthChange/handleWeekChange (PERF-1/AUDIT-FE) — semua komentar FIX verbatim. Return type di-infer lalu di-export sebagai `FilterBarState` (menghindari penulisan ulang signature setter — lihat catatan warning di bawah).
  - `use-ingest.ts` (73, 'use client'): state ingesting/ingestMsg + handleIngest verbatim (AbortController 120s BUG-3-b B11, content-type guard, invalidasi 19-key H-14/T3, auto-dismiss 8s).
  - `PeriodSelects.tsx` (177, 'use client'): 3 Select (Bulan/Minggu/Perbandingan) + hover-prefetch (BUG-FE-1 kelompok + compare resolved PERF-1) — JSX verbatim dari helper `periodSelects()`; `usePrefetchAnalysis()` dipanggil di sini (tetap 1 call). Props = `Pick<FilterBarState, ...>`.
  - `OrgSelects.tsx` (103, 'use client'): 4 SearchableComboBox verbatim dari helper `orgSelects()`; normalisasi `kelompokOptions = status?.kelompokOptions || []` (nilai `.length` identik dengan `status?.kelompokOptions?.length || 0`).
  - `FilterActions.tsx` (126, 'use client'): kluster tombol aksi verbatim (3 tombol ikon sekunder + Import Drive/Upload File via CustomEvent document + Sinkron File dengan komentar VH-6/BUG-HUNT C1/B1).
  - `lazy-dialogs.tsx` (38, 'use client'): 3 `dynamic()` dialog (PERF-FASE1-FE01) + komentar H-14/T1.
  - `index.tsx` (197, 'use client'): `export function FilterBar()` (props sama: tanpa props) — loading row, badge Filter(n), Reset, divider, ingestMsg badge, mount 3 dialog; urutan hook state dialog (settingsOpen/dataMgmtOpen/picMgmtOpen) sama.
- JANGAN circular import — diverifikasi: pipeline/* hanya import react/@-libs/sibling-types; FilterBar/* hanya import ui/@-libs/sibling; `tsc --noEmit` clean membuktikan graf modul sehat.
- VERIFIKASI (best-effort, agent lain berjalan paralel — `git status` menunjukkan domain SPLIT-D/E/F sedang diedit):
  - `bunx tsc --noEmit --incremental false` → **0 error** (seluruh repo, termasuk file domain agent lain).
  - `bunx eslint src/components/filters/FilterBar/ src/components/filters/FileUploadDialog/` → **0 error**; warning di file domain saya = 6 (upload-detect-stage 2× `any` + use-upload-pipeline `'open'` + use-ingest 3× `any`) = SAMA dengan baseline 6 (semua warning adalah kode `any`/param-name yang berpindah bersama kodenya; TIDAK ada warning baru — signature function bertype param-name di interface dihindari via derived type `ReturnType<typeof ...>` agar rule `no-unused-vars` (repo ini mengaktifkan base rule TS-blind) tidak menghasilkan warning baru).
  - `bun run lint` repo-wide → 0 error, 389 warning (baseline pre-existing seluruh repo + domain agent lain; kontribusi file saya tetap 6).
  - Bukti caller tidak berubah (rg sesudah split): `src/components/dashboard/DashboardHeader.tsx:18: import { FilterBar } from '@/components/filters/FilterBar'`; `FileUploadDialog/index.tsx:23: import { useUploadPipeline } from './use-upload-pipeline'`; `ConfirmPanel.tsx:10: import type { DetectResult } from './use-upload-pipeline'`; `ImportResultSummary.tsx:8: import type { UploadResult } from './use-upload-pipeline'` — semua path & simbol IDENTIK dengan sebelum split. `rg -l "use-upload-pipeline|FilterBar|FileUploadDialog" tests/` → tidak ada match (tidak ada test yang perlu dijalankan).
  - Verifikasi "pure code motion" mekanis (python diff terhadap `git show HEAD:`): (a) multiset semua string literal (className/pesan/template) identik — satu-satunya delta semantik adalah 2 pesan error validasi file yang di-dedup (teks identik, urutan setState identik) dan `Semua Kelompok (${kelompokOptions.length})` ≡ `(${status?.kelompokOptions?.length || 0})`; (b) sekuens call terurut `setX(...)/fetch/toast/invalidate` SAMA persis untuk handleUploadAndDetect (33 call), handleRunImport (21 call), fileSelect+drop (9 call), reset (11 call), effect BUG-FE-9 ([setKelompok,setArea,setPic,setOutlet]), handleIngest (13 call); (c) sekuens tag JSX render FilterBar identik per-posisi (Select×3+SelectItem, SearchableComboBox×4, Badge, Tooltip/Button reset, kluster aksi, Badge ingestMsg, 3 dialog).

Stage Summary:
- Kedua god file terpecah tanpa perubahan perilaku/state-flow/urutan langkah pipeline/UI; SEMUA simbol export tetap bisa diimport dari path yang SAMA oleh caller (hook + 4 type dari `./use-upload-pipeline`; komponen `FilterBar` dari `@/components/filters/FilterBar`).
- Peta file baru (baris):
  - `FileUploadDialog/use-upload-pipeline.ts` → **211** (entry/barrel, status: DITULIS ULANG jadi tipis — path tetap)
  - `FileUploadDialog/pipeline/types.ts` → 147
  - `FileUploadDialog/pipeline/abort.ts` → 62
  - `FileUploadDialog/pipeline/file-selection.ts` → 52
  - `FileUploadDialog/pipeline/upload-detect-stage.ts` → 250
  - `FileUploadDialog/pipeline/import-stage.ts` → 161
  - `FilterBar/index.tsx` → 197 (status file lama `FilterBar.tsx`: **DIHAPUS**, digantikan folder)
  - `FilterBar/use-filter-bar-state.ts` → 225
  - `FilterBar/use-ingest.ts` → 73
  - `FilterBar/PeriodSelects.tsx` → 177
  - `FilterBar/OrgSelects.tsx` → 103
  - `FilterBar/FilterActions.tsx` → 126
  - `FilterBar/lazy-dialogs.tsx` → 38
- Total baris domain: 1.279 (2 file, 662+617) → 1.922 (13 file; semua ≤250; file terbesar upload-detect-stage.ts tepat 250). Kenaikan total = biaya header modul + plumbing props/types (Pick<FilterBarState>, PipelineDeps) — trade-off standar split komponen; target utama "modul kecil per file" tercapai.
- Verifikasi domain: tsc **0 error**; eslint **0 error**, warning domain 6 → 6 (nol warning baru); test tidak ada yang menyentuh domain; error luar domain: TIDAK ADA yang terlihat (tsc repo-wide 0 error saat verifikasi; perubahan agent paralel SPLIT-D/E/F di dashboard/lib tidak saya sentuh dan tidak saya perbaiki).
- Catatan risiko/bug (DIPERBAIKI? TIDAK — hanya dicatat, sesuai batasan):
  1. Pre-existing: `FileUploadDialog/index.tsx:32` warning `'open'` unused (param name di type `(open: boolean) => void`) — file bukan milik domain saya, tidak disentuh.
  2. Pre-existing `any` yang berpindah bersama kode (tidak ditambah/dikurangi): `uploadResult: any` + `Promise<any | null>` di upload-detect-stage; `(r: any)` ×3 di use-ingest — kandidat cleanup type di masa depan.
  3. Repo ini mengaktifkan base rule `no-unused-vars` yang buta-terhadap-TS (men-flag nama param di type position — lihat useDashboard.ts yang penuh warning serupa). Agent berikutnya yang menulis interface dengan function-type property bernama param akan menambah warning — pertimbangkan mematikan base rule atau prefix `_`.
  4. `handleFileSelect`/`handleDrop` kini berbagi `applySelectedFile` (dedup kode identik) — bukan bug, tapi satu-satunya "bukan byte-for-byte copy" di split ini (sekuens setState diverifikasi identik).
  5. Sesaat `FilterBar.tsx` dan folder `FilterBar/` hidup bersamaan selama penulisan file (urutan tulis-lalu-hapus); status akhir hanya folder — resolusi modul tidak ambigu.
  6. Tidak ada run dev server/build untuk repo ini (sesuai batasan task) — verifikasi via tsc + eslint + diff struktural terhadap `git show HEAD:` (pola verifikasi SPLIT-GOD-FILE diadaptasi ke komponen).
