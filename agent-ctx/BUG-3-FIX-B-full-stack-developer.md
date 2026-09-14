# Task ID: BUG-3-FIX-B — full-stack-developer (frontend fixes)

Repo: /home/z/audit-inventory · Basis: laporan hunt BUG-3-b (frontend sweep, READ-ONLY) + fix server-side cache Main (aggregation-cache). Scope eksklusif file frontend + tests. Aplikasi desktop-only.

## Ringkasan
Menerapkan seluruh fix prioritas dari laporan BUG-3-b (11 fix pada 12 file source + 2 file test baru). Semua teks UI bahasa Indonesia, marker `// FIX (BUG-3-b Xn): <alasan>`.

## Fix yang dikerjakan

### [1 — B1 TINGGI] src/lib/query-invalidation.ts
- Tambah `['change-analysis']` sebagai key ke-19 di ALL_DATA_QUERY_KEYS.
- Tanpa ini SEMUA mutasi (upload/delete/reset/drive/ingest/settings/PIC/refresh) meninggalkan lensa Perubahan CHANGE-1 (OutletPriorityPanel `['change-analysis', monthLabel, currentWeek, kelompok]` + ChangeItemTable `['change-analysis','items',...]`) stale hingga 5 menit staleTime. Prefix-match TanStack menutup kedua key dari satu entry. Server-side sudah mencantumkan (aggregation-cache/invalidate.ts:134) — klien kini paritas.

### [2 — A-utama] src/hooks/useDashboardActions.ts
- handleExport: toast in-progress saat mulai ("⏳ Menyiapkan laporan... — Laporan lengkap bisa memakan waktu hingga ±1 menit — jangan tutup halaman."), di-dismiss saat selesai (API toast() memang mengembalikan {dismiss,update} — dipakai dismiss, tidak perlu update).
- AbortController + `setTimeout(abort, 120_000)` dengan clearTimeout di finally.
- AbortError → toast ramah: "Server timeout (120 detik). Laporan terlalu berat — coba lagi atau kurangi pilihan section." (pola fetchAnalysis.ts).
- Validasi blob: `blob.size === 0` → "File kosong dari server — coba lagi"; content-type wajib mengandung 'wordprocessingml' → selain itu error eksplisit.
- `URL.revokeObjectURL(url)` ditunda `setTimeout(..., 60_000)` (race WebKit/Safari: revoke sinkron setelah click() bisa membatalkan download — toast sukses tapi file tak ada).
- [A6] handleRefresh: cek `res.ok`; gagal → toast jujur "Cache server gagal dibersihkan (HTTP X) — menampilkan data yang ada." (dulu 429/5xx tetap diklaim "cache dibersihkan").

### [3 — A1] src/components/drilldown/SourceDataModal.tsx
- handleExportCSV: revokeObjectURL ditunda 60s (race sama dengan fix #2).

### [4 — B2 SEDANG] src/components/drilldown/DrillDownDrawer.tsx
- Race-guard load-more lama (FE-06) membandingkan `filterSig` vs `currentSig` yang DUA-DUANYA dari closure render yang sama → selalu identik → no-op; record dua filter bisa tercampur.
- Fix: `filterSigRef` (ref) yang di-sync oleh effect khusus pada 7 nilai filter; handleLoadMore capture signature LIVE saat mulai, setelah fetch bandingkan dengan ref → mismatch = discard + `logger.debug('[drilldown] Load More discarded — filter changed mid-fetch')`. Effect post-commit berjalan jauh sebelum response jaringan → race benar-benar tertutup.

### [5 — B3 SEDANG] FileUploadDialog (use-upload-pipeline.ts + index.tsx)
- `fetchWithTimeout(url, init, timeoutMs)`: controller per-request + `Set<AbortController>` (3 chunk paralel semuanya bisa di-abort) + timer di-clear di finally.
- Budget per fase: chunk upload 120s (per request 4MB), detect 60s, import-all 300s.
- `cancel()`: set cancelRequestedRef → abort semua controller → reset uploading/importing langsung.
- Catch per fase: user-cancel → diam (tanpa toast error palsu); AbortError timeout → pesan ramah dengan angka fase yang benar (phaseTimeoutMs dilacak: 120s upload vs 60s detect); pesan import menyebut retry aman (week sudah masuk di-skip).
- index.tsx: tombol "Batalkan" (enabled saat busy) menggantikan Batal disabled — muncul di fase upload+detect ("Batalkan") dan fase import ("Batalkan Import"). handleClose tidak lagi mengunci dialog saat busy: cancel() → reset() → close.

### [6 — B4 RENDAH] src/components/filters/DriveImportDialog.tsx
- Effect `if (!open) setDriveImporting(false)` — dulu spinner "Importing..." + Batal disabled terbawa ke pembukaan berikutnya bila dialog ditutup paksa mid-request.
- Dead state `progressLog` dihapus (di-set [] tapi tidak pernah di-push; blok render "Progress log" ikut dihapus — pilihan lean sesuai instruksi).
- Cek content-type JSON sebelum res.json() (pola handleIngest FilterBar) — error HTML jadi pesan "Server error (HTTP X)..." bukan "Unexpected token '<'".

### [7 — A5 RENDAH] src/components/dashboard/ExportDialog.tsx
- Reset seleksi saat open→false SEMUA jalur (dulu hanya jalur user via handleOpenChange; handleExport parent menutup programatik via setExportDialogOpen(false) → seleksi "2/6 section" bocor ke buka berikutnya).
- Implementasi pattern "adjust state during render" (prevOpen, sama dengan SettingsDialog BUG FIX #005) — BUKAN useEffect+setState (rule eslint set-state-in-effect menolak; iterasi pertama pakai effect → error lint → refactor).

### [8 — A7 RENDAH] src/hooks/use-toast.ts
- Reducer ADD_TOAST: destructive tanpa duration eksplisit → `duration: 10_000` (TOAST_DESTRUCTIVE_DURATION); variant lain tetap undefined (default Radix 5s); duration eksplisit caller selalu menang. Nilai mengalir: reducer state → Toaster spread {...props} → Radix ToastPrimitives.Root auto-close.

### [9 — B7 RENDAH] src/components/dashboard/AreaItemHeatmap/index.tsx
- Cleanup unmount: `clearTimeout(hoverTimer.current)` (80ms hover-debounce dulu menembak setHoveredCell di komponen ter-unmount saat ganti tab).

### [10 — B8 RENDAH] src/components/filters/SettingsDialog.tsx
- resetMutation.onSuccess cek `data.success` (gagal → toast destructive "Reset gagal", tidak lagi toast sukses palsu + invalidasi).
- fetchSettings cek `res.ok` sebelum res.json() → "Gagal memuat pengaturan (HTTP X)".

### [11] src/components/filters/FilterBar.tsx handleIngest
- AbortController 120s (clearTimeout di finally) + AbortError → "Server timeout (120s) — server tidak merespons. Coba lagi nanti." (content-type check sudah ada, dipertahankan).

## Test baru (7)
- tests/lib/query-invalidation.test.ts (3): ['change-analysis'] ter-invalidasi (regression-proof B1); 18 key H-14/T3 tidak ada yang hilang; bentuk key valid (array non-kosong).
- tests/hooks/use-toast.test.ts (4): destructive → 10s; default → undefined; duration eksplisit menang; payload lain utuh.

## Gerbang
- `bunx tsc --noEmit` → 0 error.
- `bun run test` → 509/509 hijau (final; termasuk 7 test baru). Catatan proses: sempat 3 test gagal mid-session (validation/change-analysis/top-growth) — dibuktikan via isolation run (stash 12 file saya + pindahkan test baru keluar → 3 failure yang SAMA) bahwa itu WIP backend Main (validation.ts EXPORT_SECTION_KEYS + shared.ts merged SET LOCAL — file yang dilarang saya sentuh), bukan perubahan saya; Main kemudian menyelesaikan fix-nya → akhir session semua hijau.
- `bunx eslint <14 file diubah>` → 0 error, 30 warning semuanya pre-existing di baris yang tidak disentuh.

## Tidak dikerjakan (out of scope sesuai instruksi)
B5 (QuickSettings debounce refactor), B6 (OutletPriorityPanel defaultCount cross-lens), B9+ (komponen lain). Tidak commit/push. Tidak menjalankan dev server. DashboardHeader.tsx, QuickSettings.tsx dibaca tapi akhirnya tidak perlu diubah (fix terkaitnya tercakup di file lain).
