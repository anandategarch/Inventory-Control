# Work Record — Task ANA-1-E

**Agent**: full-stack-developer
**Task**: "Peluang Perbaikan (Rp)" vs Median Area — Benchmark Opportunity di tab PEER (fase ANA-1, roadmap eksekusi; TERUKUR, murni angka peluang Rp — tanpa elemen aksi/tindakan apa pun)
**Status**: ✅ Complete
**Date**: 2026-09-12

## Context

- Worklog riwayat: fase ANA-1 = eksekusi roadmap analisis (validasi ROADMAP-VALIDATE-1: median/percentile benchmark + opportunity Rp = salah satu yang BENAR-BENAR ABSEN dari kapabilitas eksisting). User MENOLAK fitur berbau "action log" — implementasi ini murni angka & daftar (read-only, tanpa workflow).
- Pola yang ditiru: `src/lib/queries/outlets/peer-comparison.ts` (query), `src/app/api/peer-comparison/route.ts` (route: zod + rate-limit + CACHE_ANALYSIS + withCacheAndDedup 5 mnt), `TrendChartCard`/`ItemLevelComparison` (presentational card — fetch di parent `PeerComparison.tsx`), `shared/BarList` (ranked bar list).

## Files Created

| File | Isi |
|------|-----|
| `src/lib/queries/outlets/benchmark-opportunity.ts` | `queryBenchmarkOpportunity(month, week, filters)` → CTE `outlet_loss` (per-outlet: `lossNominal` = SUM(CASE WHEN nominalLossSurplus<0 THEN ABS(nominalLossSurplus) ELSE 0 END) — definisi IDENTIK dashboard.ts/peer-comparison `totalLoss`; `devBom` = SUM(ABS(qtyDeviasi))/NULLIF(SUM(ABS(qtyBom)),0)) → CTE `area_median` (`percentile_cont(0.5) WITHIN GROUP (ORDER BY lossNominal)` GROUP BY area) → `opportunityRp` = GREATEST(0, lossNominal − areaMedianLoss). Output `{ totalOpportunityRp, areaCount, topOutlets(≤8, opportunityRp>0, sort desc) }`. Prisma tagged template + `buildSqlFilters` + `withStatementTimeout`; week null → fallback MAX(weekLabel) (anti double-count minggu kumulatif, pola peer-comparison). Area = `Outlet.area` (konsisten modul peer). |
| `src/app/api/benchmark-opportunity/route.ts` | GET `?month=&week=&kelompok=` — meniru persis struktur route peer-comparison: `rateLimit(benchmark-opportunity:{ip}, RATE_LIMITS.analysis)`, zod `benchmarkOpportunityQuerySchema`, `resolveMonthLabel`, `buildCacheKey({route:'benchmark-opportunity', month, week, kelompok})`, `withCacheAndDedup` TTL 5 mnt (sama dengan PEER_CACHE_TTL), response + `cached`/`stale` flags + `CACHE_ANALYSIS` headers, `errorResponse` catch. Read-only, tanpa POST. Kelompok dinormalisasi `all`→null. Tanpa outletCode (metrik network-wide per area — cache sengaja dibagi lintas ganti focus outlet). |
| `src/components/dashboard/peer-comparison/benchmark-opportunity-card.tsx` | Kartu compact presentational "Peluang Perbaikan (Rp)": judul + InfoTooltip + description pertanyaan §21 ("Berapa Rp yang bisa ditekan jika tiap resto loss-nya turun ke median areanya?"); hero angka total (fmtIDR compact, title = nilai penuh); BarList top 5 outlet (label `outletName · area` + tooltip built-in, value = Rp); caption "TERUKUR · dibanding median resto satu area · {areaCount} area"; empty-state ramah saat totalOpportunityRp=0 ("Tidak ada peluang — semua resto sudah di bawah median areanya"), guard areaCount=0 (periode tanpa data), loading spinner, error + tombol Coba Lagi. |

## Files Modified (additive only)

- `src/lib/validation.ts` — tambah export `benchmarkOpportunityQuerySchema` (month/week/kelompok; pakai schema dasar existing). Tidak menyentuh schema lain.
- `src/lib/aggregation-cache.ts` — daftarkan `'benchmark-opportunity'` ke `invalidateAnalysisCache()` routes (pola CACHE-01: semua route ber-AggregationCache wajib di-invalidate saat mutasi ingest/settings/pic/delete).
- `src/components/dashboard/PeerComparison.tsx` — tambah useQuery `['peer-comparison','benchmark-opportunity', monthLabel, currentWeek, kelompok]` (staleTime 5 mnt / gcTime 10 mnt / keepPreviousData — sama dengan sibling; parallel dengan main/items; TANPA activeOutlet di key karena metrik network-wide) + render `<BenchmarkOpportunityCard>` sebagai modul ke-5 di grid analisis (`grid-cols-1 lg:grid-cols-2`) setelah ScatterPlotCard.

## Keputusan Desain

- **Median per area, bukan peer-set**: benchmark restonya = resto-resto satu AREA (bukan peer ±10% sales) — sesuai roadmap "benchmark opportunity" dan label TERUKUR; area dipakai dari `Outlet.area` (konsisten tampilan modul peer).
- **Loss definition identik dashboard.ts**: ABS per record saat nominalLossSurplus < 0 → tidak ada definisi ganda.
- **Filter kelompok saja** (sama dengan peer-comparison); area sengaja tidak difilter di route supaya benchmark mencakup semua area.
- **topOutlets hanya opportunityRp > 0** — outlet ber-peluang 0 bukan "top" apa pun; total 0 otomatis menghasilkan topOutlets kosong → empty-state.
- **devBom dikembalikan API** (per spec output) tapi kartu tidak menampilkannya per baris — spek kartu: hero + BarList + caption; field tersedia untuk konsumen API lain.
- **Kartu selalu dirender** di grid (self-managed loading/error/empty) — tetap berguna saat target tidak punya peer (4 kartu sibling tersembunyi).

## Verification Results

- `bunx tsc --noEmit` → **0 error** (exit 0, seluruh project).
- `bunx eslint` pada 6 file yang disentuh → **0 error**; 11 warning semuanya pre-existing pada kode lama (non-null assertion & unused-var yang sudah ada sebelumnya) + 1 warning baru `monthLabel!` di queryFn — pola identik dengan query items/trend sibling (273/274/301/302) yang juga warning-level by convention.
- Route diuji via curl ke dev server (:3100): tanpa month → 400 `month required`; month invalid → 400 pesan zod; month+week valid → sampai layer DB (500 `Invalid DATABASE_URL` — **pre-existing environment issue**: dev server pid 14181 mewarisi DATABASE_URL SQLite `file:/home/z/my-project/db/custom.db` sehingga SEMUA route ber-DB gagal identik, termasuk /api/analysis & /api/status; bukan defect kode baru — terkonfirmasi dari /home/z/bughunt/dev.log, 18 error serupa sejak server start).
- NOL perubahan pada query/route existing (semua existing file hanya bertambah; tidak ada behavior lama yang berubah).
