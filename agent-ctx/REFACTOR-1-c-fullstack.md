# REFACTOR-1-c — Split god files: AdvancedAnalysis, PeerComparison, FileUploadDialog (pure move)

Task ID: REFACTOR-1-c
Agent: fullstack (Z.ai Code)
Repo: /home/z/audit-inventory (working tree, NOT committed — user will commit)
Baseline saat mulai: HEAD f23e655, tsc 0 error · vitest 473/473 · eslint 0 error. Working tree TIDAK bersih — agent paralel REFACTOR-1-a (backend: ingest-process route, growth-drivers, aggregation-cache) & REFACTOR-1-b (ItemTrendTab) sedang jalan; file mereka tidak disentuh.

## Peta konsumen (dipetakan SEBELUM split, via rg)
- `@/components/dashboard/AdvancedAnalysis` → AreaTab.tsx:24 (`AreaComparison, OutletHealthRanking`), ItemTab.tsx:24 (`ItemConsistencyAnalysis`). TopItems.tsx/useDashboard/page.tsx hanya MENYEBUT nama di komentar (bukan import). Test: TIDAK ADA.
- `@/components/dashboard/PeerComparison` → tabs/PeerTab.tsx:24 dynamic import `.then(m => m.PeerComparison)`. Test: TIDAK ADA.
- `@/components/filters/FileUploadDialog` → app/page.tsx:72 dynamic import `.then(m => ({ default: m.FileUploadDialog }))`. upload-utils.ts adalah sibling (dipakai via relatif). Test: TIDAK ADA.
- `AnomaliOutletExpansion` (task minta dicek pemakainya): HANYA ItemConsistencyAnalysis (AdvancedAnalysis.tsx:501). OutletHealthRanking TIDAK memakainya.

## File 1 — src/components/dashboard/AdvancedAnalysis.tsx (604 → shim 27 + 6 file)
Direktori baru `advanced-analysis/`:
- `health-badges.ts` (53): 5 helper murni (healthScoreColor, healthScoreBg, lossToSalesColor, consistencyLabel, consistencyBadge) — byte-identik + `export`.
- `OutletHealthRanking.tsx` (111): banner "1.2" ikut pindah. Body IDENTICAL (diff terverifikasi).
- `AnomaliOutletExpansion.tsx` (167): internal — 3 interface + komponen IDENTICAL; hanya +`export` (diperlukan import lintas file; TIDAK di-re-export barrel → API publik tetap 3).
- `ItemConsistencyAnalysis.tsx` (229): banner "1.3" + komentar SHADCN-PATTERNS EmptyState ikut pindah. Body IDENTICAL.
- `AreaComparison.tsx` (99): banner "1.4". Body IDENTICAL.
- `index.ts` (12): barrel re-export PERSIS 3 export lama.
- `AdvancedAnalysis.tsx` (27): **KEPUTUSAN penting** — file TIDAK dihapus literal, dijadikan pure re-export shim. Alasan: ATURAN MUTLAK #1 (path publik stabil + konsumen tidak boleh diedit) mustahil dipenuhi jika file dihapus, karena direktori `advanced-analysis/` (kebab-case, sesuai spec task) tidak case-fold ke specifier `AdvancedAnalysis` di FS Linux case-sensitive → AreaTab/ItemTab akan error. God file 604 baris hilang (0 logika tersisa), path `@/components/dashboard/AdvancedAnalysis` tetap hidup.

## File 2 — src/components/dashboard/PeerComparison.tsx (665 → 525 + sibling 151)
- `peer-computation.ts` (151): 5 fungsi compute (computePeerEfficiencyScore, computePeerGapRows, computePeerScatterPoints, computePeerRankItems, computePeerAnomalyFlags) + banner "Pre-compute helpers" + semua doc-comment/FIX marker — byte-identik + `export`. Tipe yang dipakai: PeerRow/PeerAverages (dari ./peer-comparison/types), GapRow/RankItem/ScatterPoint/AnomalyFlag (dari shared/peer-comparison-cards — diverifikasi asalnya, BUKAN dari peer-comparison/types).
- `PeerComparison.tsx` (525): komponen + re-export 5 tipe lama (`export type { PeerRow, MetricDef, ItemComparisonResponse, TrendResponse, PeerAverages }`) tetap verbatim; body komponen IDENTICAL (diff full-block verifikasi); import berubah hanya: +5 compute dari './peer-computation', −fmtNum/fmtPctAbs/4 tipe kartu (jadi tak terpakai). Path file tidak berubah → konsumen PeerTab stabil.

## File 3 — src/components/filters/FileUploadDialog.tsx (873 → dihapus, direktori 7 file, total 1159)
Direktori `FileUploadDialog/` (nama == path lama → `@/components/filters/FileUploadDialog` tetap hidup via index; page.tsx TIDAK diedit):
- `use-upload-pipeline.ts` (581): SEMUA logika pipeline — state (file/uploading/importing/progress/statusLog/result/error/renameMode/manualFileName/numberLocale/detectData) + fileMetaRef/fileInputRef + manualValidation memo + reset(useCallback [] verbatim) + handleClose + handleFileSelect + handleDrop + PHASE 1+2 (upload chunks paralel 3-concurrent + detect, banner + komentar PERF-UPLOAD-4 utuh) + PHASE 3 (import-all + cleanup + invalidateAllData + toast, banner + FIX H-14/T3 utuh) + handleEditName + clearFile (wrapper 2 setState inline "Ganti file" lama: setFile(null)+setManualFileName('') — batch identik) + isBusy/showConfirm. Interface hasil hook eksplisit `UploadPipeline`. Semua fetch VERBATIM: /api/ingest-upload FormData + /api/ingest-process POST detect {mode, fileName, fileHash, fileSize, ext, numberLocale, ...manualPayload} + POST import-all {mode, fileName, fileHash, fileSize, ext, weeksToImport, numberLocale, manualFileName-if-manualMode} + DELETE {fileHash} ×2 + queryClient.invalidateQueries(['status']) — KONTRAK /api/ingest-process TIDAK berubah (scope agent REFACTOR-1-a yang mengubah internals route — aman, keduanya murni pindah masing-masing). upload-utils.ts TIDAK disentuh; import relatif jadi `../upload-utils` (+penyesuaian path di komentar).
- Sub-UI dipotong SESUAI seam yang benar-benar ada (verifikasi diff: identik modulo dedent 1 level + plumbing nama prop):
  - `FileDropZone.tsx` (69): area drop + display file terpilih + tombol Ganti file. Baca file/isBusy/ref + 3 callback.
  - `RenameModeSection.tsx` (134): toggle Auto-Detect/Manual + input manual + selector Format Angka CSV — section ber-border yang jelas di JSX asli.
  - `ConfirmPanel.tsx` (73): panel konfirmasi post-detect + tombol Edit Nama / Lanjut Import (gerbang PHASE 2→3).
  - `ProcessingFeedback.tsx` (47): progress bar + status log — 2 blok feedback yang bersebelahan di JSX asli, digabung dalam 1 fragment agar urutan DOM identik.
  - `ImportResultSummary.tsx` (56): hasil import (total rows + breakdown per week + skipped).
  - `index.tsx` (199): shell Dialog + header + komponen utama + error strip + blok info "Cara kerja" + DialogFooter (3-branch state machine) — footer & error & info SENGAJA tetap inline: terikat langsung ke state machine pipeline (bukan seam mandiri), memaksakan potong = prop plumbing tanpa nilai.
- Tipe: interface `UploadPipeline` memakai tipe React yang sudah ada (Dispatch<SetStateAction<T>>, ChangeEventHandler, DragEventHandler) supaya tidak menambah warning false-positive `no-unused-vars` base rule pada nama parameter type-position — tipe identik/lebih presisi, 0 dampak runtime.

## Bukti pure move (diff mekanis, semua via git show HEAD vs file baru)
- OutletHealthRanking / AreaComparison / ItemConsistencyAnalysis / PeerComparison-component: `diff` full-block → IDENTICAL (0 baris beda).
- AnomaliOutletExpansion + interfaces: IDENTICAL kecuali 1 kata `export`.
- 5 helper + 5 fungsi compute: IDENTICAL kecuali kata `export`.
- FileUploadDialog handler (reset/handleClose/handleFileSelect/handleDrop/PHASE 1+2/PHASE 3/handleEditName): IDENTICAL per segmen.
- Sub-UI JSX: IDENTICAL modulo dedent + rename prop (onDrop, onFileSelect, onClearFile, onRenameModeChange, onManualFileNameChange, onNumberLocaleChange, onEditName, onRunImport).
- Dialog header/error/info/footer block: IDENTICAL modulo indentasi.

## Gerbang (semua hijau)
- `bunx tsc --noEmit` → **0 error**
- `bun run test` → **473/473 passed** (27 file test, 0 test diubah — `git status -- tests/` kosong)
- `bunx eslint` scope saya (8 file + 3 direktori) → **0 error**, 12 warning: 11 pindahan 1:1 dari file lama (AdvancedAnalysis 'code'×1; PeerComparison 'v'×1 + non-null×6; FileUploadDialog 'open'×1 + any×2) + 1 warning baru kelas identik (use-upload-pipeline.ts:104 'open' — param type-position onOpenChange, false-positive base no-unused-vars yang file asli pun bawa di baris 46).
- `git status` → hanya scope saya: M AdvancedAnalysis.tsx, M PeerComparison.tsx, D FileUploadDialog.tsx, + advanced-analysis/ (6 file), peer-computation.ts, FileUploadDialog/ (7 file). File lain yang tampai berubah (ItemTrendTab/*, ingest-process route, aggregation-cache/, growth-drivers/) = kerja agent paralel REFACTOR-1-a/b, tidak disentuh.

## Catatan
- TIDAK commit / TIDAK push (sesuai instruksi).
- `git stash` sekali terpakai untuk baseline-check eslint file lama — sudah di-pop sempurna (verifikasi: semua perubahan agent paralel utuh setelah pop); tidak akan diulang di working tree bersama.
