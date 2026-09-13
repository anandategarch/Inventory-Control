# REFACTOR-1-b — Split god files: ItemTrendTab (pure move)

Task ID: REFACTOR-1-b
Agent: fullstack (Z.ai Code)
Scope: `src/components/dashboard/tabs/ItemTrendTab/` — SPLIT god files, PURE MOVE, zero behavior change.
Baseline saat mulai: HEAD f23e655, working tree bersih, tsc 0 error · vitest 473/473 · eslint 0 error.

## Peta konsumen (dipetakan SEBELUM split)
- Barrel publik `@/components/dashboard/tabs/ItemTrendTab` dikonsumsi `ItemTab.tsx:25` (import `ItemTrendTab`) — named import.
- `ItemTrendLineChart.tsx` import dari `./ItemTrendTab/flipHelpers` (file itu TIDAK diubah — di luar scope).
- `FlipRanking` hanya dikonsumsi index.tsx (import + re-export). `FlipDrillPanel` TIDAK pernah di-export (privat di FlipRanking.tsx) → aman jadi file privat baru.
- Test tidak ada yang import langsung dari folder komponen ini (hanya `tests/lib/flip-metrics.test.ts` yang mengunci kontrak formula di `src/lib/flip-metrics` — file lib tidak disentuh).

## Split yang dilakukan

### File 1 — index.tsx (927 → 761 baris)
- `RankBadgeRow.tsx` (BARU, 77 baris): `rankBadgeClass` + `RankBadgeRow` + `RankBadgeRowProps` (Phase 1).
- `FlipSummaryCard.tsx` (BARU, 107 baris): `flipRiskClass` + `flipRiskBadgeClass` + `FlipSummaryCard` + `FlipSummaryCardProps` (Phase A+B). `data-testid="flip-summary-card"` ikut pindah.
- `index.tsx` menyisakan orchestrator `ItemTrendTabImpl` + export memo + SELURUH barrel re-export.
- Import fix di index: hapus `Award` + `DeviasiRankItem` (jadi tak terpakai), tambah 2 import baru.
- KEPUTUSAN render-section (~627+ "Render"): TIDAK diekstrak — search row/metric selector/empty/error/loading/chart/table branches semua terikat state lokal orchestrator (query, setQuery, metric, sortKey, sortDir, drillPeriod, trend, periods, flips, flipScore — 15+ binding); bukan "props masuk-jelas". Sesuai instruksi "jika ragu BIARKAN di index".

### File 2 — FlipRanking.tsx (898 → 492 baris)
- `flip-badges.ts` (BARU, 95 baris, pure .ts tanpa 'use client'): `riskBadge`, `categoryBadge`, `directionBadgeClass`, `drillKey`, `monthPrefix` + `FlipPair` interface (diekspor — dipakai bersama ranking table + drill panel props; mencegah cycle FlipRanking↔FlipDrillPanel).
- `FlipDrillPanel.tsx` (BARU, 351 baris): komponen + `FlipDrillPanelProps` + tipe response drill (`FlipDrillOutlet`, `FlipDrillPeriod`, `FlipDrilldownResponse`). Import `isFlipPair`/`flipDisparityPct` pindah ke sini dari FlipRanking (satu-satunya konsumen).
- `FlipRanking.tsx` menyisakan tabel + sorting + `SortIcon` (JSX → tetap di .tsx; flip-badges dilarang JSX) + `FlipRankItem`/`FlipRankingResponse`/`SortKey`/`SortDir`.
- Catatan: `directionBadgeClass` memang DEAD CODE di HEAD (defined, never called — 2 warning eslint baseline). Dipindahkan apa adanya ke flip-badges sesuai spesifikasi task (pure move — tidak menghapus); karena kini `export`, 2 warning no-unused-vars HILANG (6 → 4 warning di file-file tersebut; tidak ada warning baru).

### File 3 — ItemPeerComparison.tsx (610 → 579 baris)
- `item-peer-compute.ts` (BARU, 50 baris, pure .ts): `computeEfficiencyScore` + `rankColor` — dua-satunya blok helper/compute top-level murni yang jelas terpisah dari JSX.
- TIDAK diekstrak: (a) tipe publik `ItemPeerRow`/`ItemPeerAverages`/`ItemPeerComparisonResponse`/`ItemPeerComparisonProps` — terikat re-export barrel index (publik, harus stabil); (b) blok pre-compute di dalam Impl (gapRows/scatterPoints/rankItems ~100 baris) — bukan seam top-level, mengekstraknya = membungkus kode dalam fungsi baru (bukan pure move); (c) `PeerTableRow` (memo sub-komponen ~86 baris) — di luar opsi yang disanksi spesifikasi File 3 (hanya item-peer-compute.ts) + file 579 baris post-split tidak lagi god-file.

## Bukti pure move (verifikasi mekanis, bukan sekadar review)
- Barrel re-export index.tsx di-diff vs HEAD via sed-range → BYTE-IDENTIK (`RE-EXPORT IDENTIK ✓`).
- 12 body fungsi yang dipindah di-diff vs HEAD (sed-range + normalisasi prefix `export `) → semua IDENTIK: RankBadgeRow, flipRiskClass, flipRiskBadgeClass, FlipSummaryCard, riskBadge, categoryBadge, drillKey, monthPrefix, directionBadgeClass, FlipDrillPanel, computeEfficiencyScore, rankColor.
- 8 interface di-diff vs HEAD → IDENTIK: RankBadgeRowProps, FlipSummaryCardProps, FlipPair, FlipDrillOutlet, FlipDrillPeriod, FlipDrilldownResponse, FlipDrillPanelProps, FlipRankItem.
- Insertion diff 3 file modified → HANYA: import statements + komentar banner REFACTOR-1-b (index: 2 import-fix + 2 import baru; FlipRanking: 2 import baru; ItemPeerComparison: 1 import baru). 623 deletions / 20 insertions total.
- Satu-satunya perubahan semantik: penambahan keyword `export` pada simbol yang pindah ke file baru (wajib agar bisa di-import lintas file) — tidak mengubah surface publik barrel.

## Gerbang (semua hijau, dijalankan ulang setelah SEMUA edit)
1. `bunx tsc --noEmit` → 0 error ✓
2. `bun run test` → 473/473 PASS (27 file) — tests/lib/flip-metrics.test.ts tetap hijau ✓
3. `bunx eslint` pada 8 file yang dibuat/ubah → 0 error, 4 warning — SEMUA pre-existing (2× exhaustive-deps `items` di FlipRanking, 2× no-unused-vars `_outletCode` di ItemPeerComparison; baseline HEAD file-file yang sama = 6 warning → turun 2 karena directionBadgeClass kini exported) ✓
4. `git status` → perubahan saya HANYA di folder ItemTrendTab: 3 modified (index.tsx, FlipRanking.tsx, ItemPeerComparison.tsx) + 5 file baru. TIDAK ada file test yang berubah ✓

## Catatan untuk Main / agent paralel
- Muncul untracked folder dari agent PARALEL selama sesi saya (bukan milik saya, tidak saya sentuh): `src/components/dashboard/advanced-analysis/` (kemungkinan REFACTOR-1-a split AdvancedAnalysis.tsx) + `src/app/api/ingest-process/services/{detect-mode,file-reassembly,shared}.ts` (agent lain). Saat git status pertama saya (awal sesi) tree bersih — semua itu muncul belakangan.
- File baru saya SEMUA folder-internal (tidak ditambahkan ke barrel — daftar re-export barrel harus tetap utuh): RankBadgeRow.tsx, FlipSummaryCard.tsx, FlipDrillPanel.tsx, flip-badges.ts, item-peer-compute.ts.
- TIDAK commit/push (sesuai instruksi).
