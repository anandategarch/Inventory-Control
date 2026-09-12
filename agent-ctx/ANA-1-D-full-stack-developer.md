# Task ID: ANA-1-D — Rekurensi/Persistence per outlet + chip L3

**Agent**: full-stack-developer
**Repo**: /home/z/audit-inventory (@ 88beddf, dev server port 3100 dibiarkan hidup)
**Status**: COMPLETED

## Goal
Metrik Rekurensi/Persistence per outlet (terisolasi, ADDITIF) + chip kecil di baris resto prioritas L3 (RestoRecommendationCard). NOL perubahan priority score / weights / sinyal existing / queryKey / cacheKey.

## Files modified (6)
1. **`src/lib/queries/outlets/outlet-recurrence.ts` (BARU)** — `queryOutletRecurrence(month, week, currentMonthKey, filters, toleranceFallback, highLossNominal)` → `Map<outletCode, OutletRecurrenceHistory>`. Prisma `$queryRaw` tagged template + `buildSqlFilters` + `withStatementTimeout` (pola persis resto-recommendations.ts). CTE 3 lapis:
   - `monthly`: per (outlet.code, sf."monthKey") pada weekLabel SAMA, `sf."monthKey" < currentMonthKey` (fallback `monthLabel != month` bila monthKey null — pola sama dengan resto-recommendations); flag `abnormal` per bulan.
   - `ordered`: `ROW_NUMBER() OVER (PARTITION BY outletCode ORDER BY monthKey DESC)`.
   - final: window `rnDesc <= 12` (konstanta `OUTLET_RECURRENCE_WINDOW_MONTHS = 12`), `periodCount = COUNT(*)`, `abnormalCount = COUNT(*) FILTER (WHERE abnormal)`, `streak = COALESCE(MIN(CASE WHEN NOT abnormal THEN rnDesc END) - 1, COUNT(*))` (run konsekutif abnormal berakhir di bulan historis terakhir; semua bulan abnormal → streak = periodCount). Semua CAST ke INTEGER (hindari BigInt di JSON).
2. **`src/lib/queries/outlets/resto-recommendations.ts`** — hanya +1 import type dan +field opsional `history?: OutletRecurrenceHistory` di interface `RestoRecommendation`. Fungsi/scoring TIDAK disentuh.
3. **`src/lib/queries/index.ts`** — +1 barrel export `./outlets/outlet-recurrence`.
4. **`src/app/api/recommendations/route.ts`** — query final diubah jadi `Promise.all([queryRestoRecommendations(...), queryOutletRecurrence(...)])` (parallel, murni additive) lalu merge `history` via spread `{ ...r, history }` hanya bila tersedia. `.catch` non-fatal → log + Map kosong (chip hilang, rekomendasi tetap jalan). Thresholds dipakai dari `thresholds` yang SUDAH di-fetch route (`getRuntimeThresholds`). cacheKey TIDAK diubah (v:2 tetap; cache lama tanpa `history` tetap valid — field opsional).
5. **`src/components/dashboard/priority-summary/types.ts`** — +`RecommendationHistory` interface + `history?: RecommendationHistory` di `Recommendation` (opsional supaya payload cache lama tidak crash). `RestoRecommendation` di useRecommendations.ts extends → otomatis dapat field, tanpa edit.
6. **`src/components/dashboard/RestoRecommendationCard.tsx`** — meta line di-restructure jadi `div.flex.min-w-0.items-center.gap-1`: `<p>` teks (code · area · nominal) truncate duluan, chip `shrink-0` selalu terlihat (aman 375px, ritme baris rank badge + nama + skor + mini-bar tidak berubah). Chip rekurensi `⟳ {abnormalCount}/{periodCount} bln` (amber=REKUREN, zinc=SEKALI; hidden bila STABIL / periodCount=0 / history undefined) + `title` bahasa mudah (+ " · data historis masih terbatas" bila periodCount<4) + sr-only readable label. Chip `↗ Memburuk` red outline bila `signals.trendDeteriorating` (field existing — murni frontend).

## Definisi "periode bermasalah" (final — threshold yang SUDAH ADA, bukan angka baru)
`abnormal = devBom > FALLBACK_TOLERANCE_PCT  OR  lossNominal > HIGH_LOSS_NOMINAL_THRESHOLD`
- `devBom = SUM(ABS(qtyDeviasi)) / NULLIF(SUM(ABS(qtyBom)), 0)` per outlet+bulan (same-week snapshot)
- `lossNominal = SUM(CASE WHEN nominalLossSurplus < 0 THEN ABS(nominalLossSurplus) ELSE 0 END)`
- **FALLBACK_TOLERANCE_PCT** — default **0.05**, `getRuntimeThresholds()` src/lib/settings.ts:527 (toleransi fallback kanonik; dipakai build-resto-profile.ts:108 untuk abnormalCount saat item tanpa toleransi per-item).
- **HIGH_LOSS_NOMINAL_THRESHOLD** — default **Rp 50jt** (50_000_000), settings.ts:551; INI P1_NOMINAL (metrics/definitions.ts:196: "P1_NOMINAL_THRESHOLD = HIGH_LOSS_NOMINAL_THRESHOLD (default 50,000,000)"; config/thresholds.ts:44 "Rp 50M loss threshold (P1)").
- classification: REKUREN (abnormalCount ≥ 2) | SEKALI (=1) | STABIL (=0).

## Verification (self-check)
- `bunx tsc --noEmit` → **0 error**.
- `bunx eslint` pada 6 file yang diedit → **0 error, 0 warning baru** (9 warning tersisa semuanya baris pre-existing: `month!`/`week!` route.ts:77/165 + 3 unused-var lama resto-recommendations.ts:197/200/201).
- Dev server 3100 (tidak dibunuh): `GET /` 200 (page + RestoRecommendationCard ter-compile), `GET /api/recommendations?month=Juli 2026&week=WEEK 2` → route ter-compile & tereksekusi, error HANYA "Invalid DATABASE_URL" (sandbox tanpa kredensial Supabase — sama seperti UXFIX-1; bukan error kode). Tidak ada build/vitest/git yang dijalankan.
- Catatan GRAIN: window = 12 bulan same-week (perbandingan valid satu-satunya); cross-week comparison TIDAK mungkin di query ini (weekLabel dipin ke week berjalan).
