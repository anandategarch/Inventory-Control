---
Task ID: BUG-B
Agent: full-stack-developer
Task: Audit diferensial perilaku pasca-SPLIT-B (commit 1be2a3f) atas 4 file besar folder `src/components/dashboard/tabs/ItemTrendTab/` yang dipecah menjadi 25+ modul (diverifikasi statis saja saat split) + bug-hunt umum di folder tersebut (periodHelpers / z-score / flipHelpers / item-peer-compute). Temukan bug nyata dan perbaiki dengan diff minimal.

Work Log:

## 1. Metode audit

- Baseline pre-split diekstrak: `git show 28d7930:src/components/dashboard/tabs/ItemTrendTab/{index.tsx,ItemPeerComparison.tsx,FlipRanking.tsx,ItemTrendTable.tsx}` (761 + 579 + 492 + 407 = 2.239 baris) → `/tmp/bug-b-baseline/`.
- Diverifikasi bahwa commit `1be2a3f` HANYA menyentuh folder domain + laporan SPLIT-B (`git show --name-only`): 12 file kecil lain di folder (FlipDrillPanel, FlipMatrix, FlipSummaryCard, flipHelpers, item-peer-compute, periodHelpers, types, zScoreHelpers, ItemTrendRankChart, ItemTrendSearchBar, RankBadgeRow, flip-badges) TIDAK tersentuh — konsisten dengan klaim laporan SPLIT-B.
- Audit dua lapis:
  1. **Manual penuh**: membaca ke-4 file lama dan ke-25 modul baru baris-per-logika (semua file di folder domain dibaca, termasuk yang tidak tersentuh split — untuk bug-hunt umum).
  2. **Diff mekanis 2 arah** (script normalisasi: strip komentar + whitespace + collap baris; relatif-kan import):
     - **Arah maju** (baris logika LAMA yang hilang di union modul BARU): index.tsx 519 baris logika → 38 "hilang", SEMUA terjelaskan (import path, `'use client'`, rename tipe SortKey→FlipSortKey/DrillPeriod/ItemTrendRankResponse, prop drilling `trend.data→trendData`, `items.length→itemCount`, `error.message→message`, `refetch()→onRetry`, `!data?.target→noTarget`, key Fragment→key komponen, `trend.data?.periods→data?.periods`).
     - ItemPeerComparison 436 → 10 "hilang" (semua setara prop/ekspor); FlipRanking 419 → 32 "hilang" (semua setara); ItemTrendTable 332 → 8 "hilang" (semua import/`export function`).
     - **Arah mundur** (baris BARU yang tidak ada di LAMA — mendeteksi logika yang dicamuk/ditambah): SEMUA extra lines adalah murni wiring (deklarasi interface, destructuring props, pemanggilan `<TrendHeader .../>` dsb.). Tidak ada satu pun baris logika baru.
- Checklist kelas bug split (a–g) dikerjakan eksplisit (lihat §3).

## 2. Tabel cakupan diferensial

| File lama (28d7930) | → Modul baru | Verifikasi | Status |
|---|---|---|---|
| index.tsx (761) | index.tsx (246) + hooks/useItemTrendAutocomplete (113) + hooks/useDrillPeriodSync (41) + hooks/useItemRankTrend (91) + hooks/useItemTrendDerived (169) + hooks/useTrendTableSort (31) + components/TrendHeader (166) + components/TrendContentStates (113) + components/TrendDataView (196) + components/MetricSelector (38) | manual + mekanis 2-arah | **PARITAS PENUH** |
| ItemPeerComparison.tsx (579) | ItemPeerComparison/index (295) + types (80) + ItemPeerStates (85) + PeerTableRow (105) + card-compute (134) | manual + mekanis 2-arah | **PARITAS PENUH** |
| FlipRanking.tsx (492) | FlipRanking/index (200) + types (45) + FlipRankingHeader (91) + FlipRankingStates (58) + FlipRankingTableHeader (70) + FlipRankingRow (195) | manual + mekanis 2-arah | **PARITAS PENUH** |
| ItemTrendTable.tsx (407) | ItemTrendTable/index (176) + patternBadge (48) + ItemTrendTableHeader (102) + ZScoreCell (84) + FlipCell (95) | manual + mekanis 2-arah | **PARITAS PENUH** |
| 12 file kecil lain di folder | tidak diubah split (diff-stat 28d7930→HEAD: hanya 29 file di atas) | `git diff --stat` | **TIDAK TERSSENTUH** |

## 3. Checklist per-kelas bug split (semua negatif)

- **(a) Stale closure / dependency array** — dep arrays identik satu per satu: debounce `[query]`; outside-click `[showDropdown]`; `periods [data?.periods]`; `satuan/chronological/flips [periods]`; `flipScore [flips]`; `sortedRows [chronological, sortKey, sortDir, flips]`; `toggleSort []`; `rankPeriods [rankData?.periods]`; `PeerTableRow.flags [row, peerAvg]`. Satu-satunya delta: `handlePeriodDrill` lama `useCallback(...,[])` → baru `[setDrillPeriod]` — setter `useState` bersifat stabil, perilaku identik (bukan bug).
- **(b) State ownership** — TIDAK ADA state yang pindah komponen: semua custom hook dipanggil dari `ItemTrendTabImpl` (owner state tetap komponen yang sama, hook hanyalah pemindahan tekstual). Initial value identik (`''`, `false`, `'period'/'asc'`, `null`, `'riskScore'/'desc'`, `'qtyDeviasi'`). Cleanup effect identik (`clearTimeout`, `removeEventListener`).
- **(c) Urutan eksekusi** — urutan hook bergeser (drill-sync kini terdaftar setelah query), tapi: adjust-state-during-render `useDrillPeriodSync` tetap berjalan dalam render komponen yang sama (bukan lintas komponen → tidak melanggar aturan React); tidak ada queryKey/dep yang membaca `drillPeriod`; kedua efek autocomplete tetap berurutan sama dalam satu komponen. Tidak ada perubahan semantik.
- **(d) Early-return/guard** — rantai guard CardContent identik: `!selectedItem → trend.error → trend.isLoading && periods.length===0 → periods.length===0 → data`; guard no-peer ItemPeerComparison identik termasuk pemetaan `noTarget={!data?.target}`; guard drill-row (`drillPeriod.month/week === p.monthLabel/weekLabel`), chevron (`topFlip && cb && dKey && riskLevel !== 'low'`), `rankPeriods.length >= 1`, `periods.length > 1 / >= 2` — semuanya terbawa utuh.
- **(e) Props drilling** — semua pasangan props diverifikasi manual satu per satu, khususnya yang bertipe sama (month/week string; area/kelompok/pic/outletCode string; sortKey/sortDir; `month={drillPeriod.month} week={drillPeriod.week}`; `buildPeerCardData(target, peers, peerAvg)`; `useDrillPeriodSync(monthLabel, currentWeek)`; `useItemTrend({itemName: selectedItem, month: monthLabel, week: currentWeek, ...})`). Tidak ada tertukar.
- **(f) Default/fallback** — `?? []`, `?? null`, `?? 0`, `|| ''`, `?? 'first'`, `?? 'Deviasi'`, `p.rankNominal > 0 ? ... : null` — semua identik lama vs baru.
- **(g) Key list / urutan sort** — semua template key (`${p.monthKey}-${p.weekLabel}-${i}`, `${p.outletCode}-${i}`, `${item.itemName}-${i}`) dan komparator sort (termasuk komparator flip null-always-bottom BUG2-FLIP-04 dan zScore `-Infinity`) identik; key Fragment lama ≡ key komponen baru (semantik rekonsiliasi React sama).

## 4. Bug-hunt umum di folder (di luar diferensial split)

Diperiksa: `periodHelpers` (periodSortKey/periodShortLabel), `flipHelpers` (groupPeriodsByWeek/computeFlipAnalyses/computeItemFlipScore/getFlip(For)Period/formatDisparity/flipBadge), `flip-badges` (riskBadge/categoryBadge/drillKey/monthPrefix/directionBadgeClass), `item-peer-compute` (computeEfficiencyScore/rankColor), `card-compute` (gap/scatter/rank), `patternBadge`, `FlipMatrix` (grid + cellColorClass), `FlipSummaryCard`, `ItemTrendRankChart` (domain [1,maxRank] reversed + rank-0 sentinel), `RankBadgeRow`, `ItemTrendSearchBar`, `FlipDrillPanel`, `types`. Konsistensi silang ke sumber data juga dicek (read-only, di luar domain): `src/lib/flip-metrics.ts` (disparity 0–1, kategori <10%/<40%), `src/lib/queries/items/flip-ranking.ts` (`avgDisparity` 0–1, `disparityPct` 0–100 — FE mengalikan/diakses dengan skala yang benar), `src/lib/queries/item-trend.ts` (`nominalDeviasi` = SUM(ABS) → label tooltip "|Nominal|" benar), `src/lib/zScoreHelpers.ts`, `src/lib/a11y.ts` (urutan argumen `sortableHeaderProps(key,label,activeKey,dir,onToggle)` benar).

## 5. Temuan

**Tidak ditemukan bug nyata yang mengubah perilaku** — baik yang diperkenalkan SPLIT-B maupun pre-existing yang jelas + berisiko rendah untuk diperbaiki. Temuan non-perilaku yang didokumentasikan (TIDAK diperbaiki, dengan alasan):

1. **[DITEMUKAN — tidak mengubah perilaku] `'use client'` hilang di 5 file `ItemTrendTable/*`** (index/FlipCell/ZScoreCell/ItemTrendTableHeader/patternBadge). BUKTI: file lama baris 1 `'use client';`; file-file baru tidak berdirektif (folder lain dari split — FlipRanking/*, ItemPeerComparison/*, components/*, hooks/* — semuanya berdirektif). ANALISIS: netral — modul tanpa direktif yang diimpor dari modul client tetap masuk bundle client; satu-satunya importer adalah `components/TrendDataView.tsx` ('use client') dan barrel `index.tsx` ('use client', re-export `export { ItemTrendTable } from './ItemTrendTable'`), tidak ada importer server (rg seluruh src: hanya 2 itu). Directive adalah penanda boundary, bukan penentu bundle bila import-chain sudah client. Sesuai aturan task (perbaiki HANYA bug yang mengubah perilaku; jangan sentuh yang tanpa dampak perilaku) → dibiarkan; dicatat sebagai hazard laten (baru bermasalah jika kelak diimpor langsung dari server component).
2. **[DITEMUKAN — PRE-EXISTING, tidak diperbaiki] `periodHelpers.periodSortKey` menginterpolasi `monthKey` mentah** (`${p.monthKey}` → `"null|04"` saat monthKey null) tanpa fallback `monthLabel` sebagaimana `FlipMatrix.monthSortKey` (`p.monthKey ?? p.monthLabel`) dan `flipHelpers.groupPeriodsByWeek` (`a.monthKey ?? a.monthLabel`). Inkonsisten antar-helper saat SourceFile hilang (kasus BUG-FLIP-03). TIDAK DIPERBAIKI karena: (i) identik di 28d7930 (pre-existing); (ii) dampaknya hanya urutan render periode tanpa monthKey; (iii) fallback ke monthLabel pun TIDAK mengubah urutan relatifnya (monthKey "2026-07" berawalan digit < label "JULI 2026"/"null" berawalan huruf → dua-duanya tetap mengurut ke belakang) sehingga "perbaikan" tidak punya efek semantik yang jelas; (iv) tanpa spesifikasi urutan yang benar untuk data rusak, mengubahnya = risiko > manfaat.
3. **[CATATAN — bukan bug] Warning lint hasil split** (kelas no-unused-vars, tanpa dampak perilaku): `Card`/`Table`/`TableRow`/`TableCell` terimport-tak-terpakai di FlipRankingHeader/FlipRankingTableHeader/PeerTableRow (import disalin utuh saat split), `FlipRankingSummary` type import tak terpakai di FlipRanking/index.tsx, nama parameter posisi-tipe (`key`, `itemName`, `q`, `b`) — semuanya warning, 0 error. Aturan task melarang "memperbaiki" warning tanpa dampak perilaku → dibiarkan.

Kandidat lain yang diperiksa dan DIPASTIKAN BUKAN bug: formula percentile `(rank/total)*100` (persentil rank standar — rank 1 dari 5 = p20, benar); `computeEfficiencyScore` devBom null → penalti 0 (keputusan desain lama untuk BOM=0); `safeDiv` guard b>0; komparator flip null-comparator (by design BUG2-FLIP-04); `formatDisparity` Math.round; kategori flip sempurna <10% FE ≡ BE; `nominalDeviasi` ABS di API vs label "|Nominal|" tooltip (benar); circular import type-only `item-peer-compute ↔ ItemPeerComparison` (terhapus saat kompilasi; struktur sama dengan pre-split); `next/dynamic` path relatif lama `'../ItemTrendLineChart'` → absolut `'@/components/dashboard/tabs/ItemTrendLineChart'` (file sama → chunk sama).

## 6. Perbaikan yang dilakukan

**Tidak ada perubahan kode.** Domain `src/components/dashboard/tabs/ItemTrendTab/**` bersih di working tree (`git status --short -- <domain>` kosong) — tidak ada bug perilaku yang ditemukan sehingga tidak ada diff yang sah sesuai aturan minimal-diff. File di luar domain yang termodifikasi di working tree berasal dari agent paralel lain (dicatat, tidak disentuh).

## 7. Verifikasi (gate)

- `bunx tsc --noEmit --incremental false` → **0 error** seluruh repo (termasuk seluruh file domain).
- `bun run lint` → **0 error**, 381 warning (baseline pre-existing; domain hanya menyumbang warning kelas lama — no-unused-vars/exhaustive-deps; tidak ada warning baru yang saya tambahkan karena tidak ada edit).
- `rg -l "ItemTrend|FlipRanking|ItemPeerComparison" tests/` → `tests/lib/flip-metrics.test.ts` (satu-satunya) → `bunx vitest run tests/lib/flip-metrics.test.ts` → **15/15 PASS**.
- Tidak menjalankan `bun run dev/build/db:*`; tidak menambah dependency; tidak `git add/commit/...`.

Stage Summary:
- Audit diferensial 2-arah (manual penuh + diff mekanis normalisasi) atas 4 file besar (2.239 baris) → 25+ modul SPLIT-B: **paritas perilaku penuh — tidak ada bug yang diperkenalkan split** (checklist kelas a–g semua negatif; tabel cakupan di Work Log §2).
- Bug-hunt umum folder (periodHelpers/z-score/flipHelpers/item-peer-compute/card-compute/FlipMatrix/FlipDrillPanel/FlipSummaryCard/ItemTrendRankChart/RankBadgeRow/SearchBar + konsistensi silang ke lib & query read-only): tidak ditemukan bug nyata yang layak diperbaiki.
- 2 temuan non-perilaku didokumentasikan TIDAK diperbaiki: hilangnya `'use client'` di ItemTrendTable/* (netral — import-graph client terbukti) dan fallback `monthKey` null di `periodSortKey` (pre-existing, edge-case, perbaikan tanpa efek semantik jelas).
- 0 perubahan kode di domain; gate lolos: tsc 0 err · eslint 0 err · vitest flip-metrics 15/15.
