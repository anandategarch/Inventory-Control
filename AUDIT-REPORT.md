# 🔍 Audit Report — Inventory-Control

**Repo:** `anandategarch/Inventory-Control` · **Metode:** static audit 4 area paralel (backend/SQL, frontend, correctness, security) + verifikasi manual hot path

**Konteks:** Next.js 16 App Router · Prisma 6 + PostgreSQL (Supabase, transaction pooler) · React 19 · TanStack Query 5 · Zustand · Recharts · ~54K record/bulan, 333 outlet, 109 item (tumbuh ~280K rows @ 8 bulan)

---

## 🚨 ACTION SEGERA (sebelum apapun)

### 1. Kredensial database bocor di git — `scripts/audit/audit-migration.ts:24-25`
```ts
const OLD_URL = 'postgresql://postgres.<project1>:<password>@aws-0-ap-southeast-1...';
const NEW_URL = 'postgresql://postgres.<project2>:<password>@aws-0-ap-southeast-1...';
```
Dua project Supabase dengan **password penuh** ter-commit. Repo ada di GitHub → siapapun yang punya akses read bisa connect langsung ke DB produksi (drop table, dump data).

**Fix (5 menit):** rotasi kedua password di Supabase dashboard → ganti ke `process.env` → purge history (`git filter-repo` / BFG) karena string sudah masuk 10+ commit.

### 2. GitHub PAT yang Anda kirim di chat ini — revoke juga (GitHub → Settings → Developer settings → Tokens).

---

## 🔴 BUG KRITIS — Angka salah / data korup

### BUG-1: Re-import bulan sama → SEMUA angka dobel (data corruption)
`src/app/api/ingest-process/route.ts:413-490` + `prisma/schema.prisma:47`

`Week.weekKey` hanya dikomentari "sortable unique" — **tidak ada `@unique`**. Import ulang file bulan yang sama dengan **nama file berbeda** (misal hasil edit/rename) membuat `SourceFile` + `Week` kedua untuk periode yang sama. Transaksi hanya menghapus record milik file baru — record lama tetap ada → duplikat. Semua query memfilter `monthLabel+weekLabel` → exec summary, Pareto, Z-score, trend, health ranking **semuanya dobel**.

Mode `import` tidak pernah cek `existingWeeks` (hanya mode `detect`); `import-all` percaya `weeksToImport` dari client.

**Fix:** tambahkan `@@unique([monthKey, weekLabel])` di model `Week` (raw migration), dan di mode import: resolve Week existing by `(monthKey, weekLabel)` lalu hapus record + SourceFile lamanya dalam transaksi yang sama.

### BUG-2: Perbandingan beda minggu (W2 vs W1) → growth ngawur
`src/lib/period-resolver.ts:66-70` + `src/hooks/useDashboardEffects.ts:131-134`

Aturan bisnis: "Comparison must be same-week across months" (minggu kumulatif). Tapi **fallback**-nya justru melanggar aturan itu:
```ts
// Fallback: chronological previous
prevWeek = allPeriods[currentIdx - 1].weekLabel;
prevMonth = allPeriods[currentIdx - 1].monthLabel;
```
Bulan pertama data / minggu tidak ada di bulan sebelumnya → dibandingkan dengan **minggu berbeda di bulan yang sama**. Karena minggu kumulatif (W2 ≈ 2× data W1), growth tampil ~−50% palsu, DIRECTION_FLIP false positive, dan 26% bobot priority score Resto ikut salah — diam-diam tanpa penanda.

Ironis: komentar di kode bilang ini sudah di-"FIX (BUG 1)" tapi fallback-nya memasukkan kembali persis perilaku yang diperbaiki.

**Fix:** hapus fallback — return `{prevWeek: null, prevMonth: null}` (caller sudah handle null), atau tandai response `comparePeriodMismatch: true` agar UI menampilkan "tidak dapat dibandingkan".

### BUG-3: Duplikat record saat `akunPenyesuaian` NULL
`prisma/schema.prisma:143` + `src/lib/ingestion/process-rows-for-import.ts:171`

`@@unique([weekId, outletId, itemId, akunPenyesuaian])` — di PostgreSQL, **NULL ≠ NULL di unique index**. `createMany({skipDuplicates: true})` tidak mendedup dua baris sama dengan akun NULL. Ditambah `/api/ingest-process` selalu `fastMode: true` → validasi DUPLICATE tidak jalan.

**Fix:** `ALTER TABLE ... ADD UNIQUE NULLS NOT DISTINCT (...)` (PG15+), atau normalisasi NULL → sentinel `''` saat ingest, atau dedup in-memory by key `outlet|item|week|akun` sebelum createMany.

### BUG-4: Kehilangan baris data secara diam-diam
`src/lib/ingestion/process-ingestion.ts:346-355` + `process-rows-for-import.ts:170-178`
```ts
catch { for (const rec of batchRecords) { try { await ...create(...) } catch {} } }
```
Fallback per-baris dengan **catch kosong** — error koneksi/timeout di tengah import → baris hilang tanpa DQ issue, tanpa error. Import "sukses" tapi data kurang.

**Fix:** bedakan Prisma P2002 (skip + hitung) dari error lain (rethrow → rollback), log tiap baris gagal sebagai DQIssue.

### BUG-5: Ingestion lock tidak menahan apa pun di multi-instance
`src/lib/ingestion/ingestion-lock.ts:12-22` — `Set` in-memory per instance; `/api/ingest-process` bahkan tidak meng-acquire-nya. Multi-instance: import bersamaan bulan sama → interleaved delete/insert → korup (bergabung dengan BUG-1).

**Fix:** `SELECT pg_advisory_xact_lock(hashtext(${monthKey}))` sebagai statement pertama di dalam transaksi import.

### Bug menengah lain (ringkas)
| # | Lokasi | Masalah |
|---|---|---|
| M-1 | `post-process-historical.ts:113-120` | Sub-metric Z-score hardcode `n>=4` padahal primary pakai `HISTORICAL_MIN_WEEKS` dari Settings → inkonsisten |
| M-2 | `ingest-process/route.ts:193-199` | `extractMonthFromRows` pakai tahun server (`new Date()`) untuk baris BULAN2 tanpa tahun → bulan Desember yang diupload Januari salah tahun 12 bulan |
| M-3 | `rule-evaluation.ts:147-156` | LATERAL prev-period `LIMIT 1` tanpa `ORDER BY` → nondeterministik jika ada duplikat |
| M-4 | `api/ingest/route.ts:12` | `maxDuration=30` tapi tx timeout 240s & vercel 300s → file besar terbunuh di tengah transaksi |
| M-7 | `priority-summary/chart-data-builders.ts:247-253` | Chart "Area Avg"/"Semua Resto" mem-fabricate angka (outlet×0.65 / ×0.45) saat data peer tidak ada → benchmark palsu |
| L-1 | `post-process-historical.ts:126-133` | `zScore ?? 0` — KOSONG dirender jadi ADA-0; record flagged dengan null hilang dari filter |

---

## ⚡ OPTIMASI KECEPATAN (akar "lemot")

### PERF-1: Frontend fetch `/api/analysis` 2× setiap ganti periode — `useDashboardEffects.ts:110-137`
Urutan kejadian (mount & setiap ganti bulan/minggu):
1. `setMonth`/`setWeek` → query analysis jalan dengan `compareWeek: null` → **fetch #1** (payload 100KB+)
2. Effect auto-compare → `setCompareWeek(...)` → queryKey berubah → **fetch #2**

Total 5 round-trip saat mount, re-render ~8×, semua chart re-animasi dua kali.

**Fix:** resolve week + compare **atomik** dalam satu action store sebelum query aktif:
```ts
// useDashboard.ts
selectWeek: (week, compareWeek, compareMonth) =>
  set({ currentWeek: week, comparisonWeek: compareWeek, comparisonMonth: compareMonth }),
```
Effect dan `FilterBar.onValueChange` panggil `selectWeek` sekali → 1 fetch, 1 re-render. Cache-warming harus prefetch dengan compare yang sudah resolved agar key sama.

### PERF-2: Pareto N+1 — `src/lib/queries/items/top-items/by-other-metric.ts:322-352`
```ts
const outletRowsByItem = await Promise.all(topItems.map((item) =>
  withStatementTimeout((tx) => tx.$queryRaw`... AND i.name = ${itemName} ...`)));
```
20 item → **20 transaksi paralel**, masing-masing scan periode penuh. Ditambah batch lain → puncak **~32 koneksi simultan** vs `connection_limit=30` → pool exhaustion → stall acak bahkan untuk 1 user (penyebab "kadang lemot kadang nggak").

**Fix (1 query):**
```sql
WITH abnormal AS (
  SELECT i.name AS "itemName", o.code, o.name, o.area, SUM(...) ...
  GROUP BY i.name, o.code, o.name, o.area
  HAVING SUM(ABS(ir."qtyDeviasi"))/NULLIF(SUM(ABS(ir."qtyBom")),0) > $3
),
ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY "itemName"
  ORDER BY ABS("nominalDeviasi") DESC) rn FROM abnormal)
SELECT * FROM ranked WHERE rn <= 20;
```
Nest di JS. Peak koneksi turun ~32 → ~10.

### PERF-3: `evaluateRulesSql` mengirim ~35K baris ke Node padahal cuma butuh yang flagged
`src/lib/queries/rule-evaluation.ts:90-183` — semua kolom flag `0/1 INT`. Tambahkan:
```sql
WHERE ("f_tol_breach_high" + "f_tol_breach" + "f_tol_not_set" + "f_over_explained"
     + "f_resid_high" + "f_resid_warn" + "f_high_loss" + "f_dir_flip") > 0
```
Biasanya 5–15% baris yang fire rule → transfer turun ~10×.

### PERF-4: `queryVarianceAnalysis` mengirim ~20-35K baris untuk di-sort lalu diambil 5+5
`src/lib/queries/health-ranking.ts:199-262` — ganti dengan `ROW_NUMBER() OVER (ORDER BY delta DESC/ASC)` + filter `rn<=5` → transfer 10 baris.

### PERF-5: Cache TTL 5 menit terlalu pendek — `validate-and-resolve.ts:32`
Data hanya berubah via ingest/settings/pic — invalidation sudah wired ke 15 route. TTL 5 menit menjamin full recompute **20–50 query** tiap 5 menit per kombinasi filter. SWR hanya meng-delete row cache → request berikutnya bayar cold cost penuh.

**Fix:** TTL 30–60 menit + saat stale: background recompute (reuse pattern `withCacheAndDedup` L268-304), bukan delete-then-recompute.

### PERF-6: Race in-flight dedup — `validate-and-resolve.ts:193→208→241`
`setInflight` dipanggil **setelah** `await getCachedWithMeta` — dua request concurrent sama-sama lewat masa null → keduanya jalan full pipeline. Frontend retry 3× memperparah.

**Fix:** pindah `setInflight` sebelum await cache (persis seperti `withCacheAndDedup` yang sudah benar).

### PERF-7: Recharts animasi menyala di chart tab default
`GrowthComparison.tsx:115`, `DeviationBreakdownChart.tsx:93`, `LossVsSurplusChart.tsx:48`, `AnalysisCards.tsx:83-86`, `peer-comparison/trend-chart.tsx`, `scatter-plot-card.tsx`, `ItemDeepDive.tsx`. Radix Tabs unmount tab tidak aktif → tiap balik ke tab, chart **re-mount + re-animasi ~1.5s**.

**Fix:** `isAnimationActive={false}` di tiap series (3 file lain sudah melakukannya — tinggal ikuti pola).

### PERF-8: 333 outlet di-render tanpa virtualisasi/pagination
`AdvancedAnalysis.tsx:57-104` — `OutletHealthRanking` render semua baris + sort inline tiap render (~2000 node DOM di tab default).

**Fix:** paginate 30 + "Tampilkan lagi" (pattern sudah ada di `HistoricalZScoreCard`), atau virtualizer (sudah dipakai di `DrillDownDrawer`).

### PERF-9 (menengah, akumulatif)
| Masalah | Lokasi | Fix |
|---|---|---|
| 3-4 RTT sekuensial Stage 2 (refetch week+sourceFile yang sudah diambil) | `fetch-records.ts:144-168`, `period-resolver.ts:33-39` | pass data yang sudah ada |
| ~40 scan redundant periode sama dalam 1 request | `dashboard.ts:201-346` dll | merge 3 query single-row jadi 1 |
| Tiap query = BEGIN + 2×SET LOCAL + COMMIT (~140 RTT ekstra/request); work_mem 64MB×30 koneksi = 1.9GB | `shared.ts:37-52` | gabung SET / set role-level; turunkan work_mem |
| `staleTime` 30s di Peer/Resto → refetch tiap re-entry tab | `PeerComparison.tsx:222-297`, `RestoAnalysis.tsx` | staleTime 5 menit |
| 1 request search per keystroke di trend tab (`useDeferredValue` ≠ debounce) | `ItemTrendTab/index.tsx:398-414` | debounce 250-300ms |
| Cache hit: JSON.parse 1MB + stringify ulang | `aggregation-cache.ts:149,164` | simpan gzip BYTEA / trim payload |

**Estimasi gabungan PERF-1..6:** cold path 6–8s → ~2–3s, stall periodik tiap 5 menit hilang, fetch saat ganti filter turun 50%.

---

## ⚡ OPTIMASI KECEPATAN (akar "lemot") — UPLOAD & DELETE

### PERF-UPLOAD-1 (FATAL): Rate limit 5/menit dipakai PER-CHUNK upload — `ingest-upload/route.ts` + `rate-limit.ts`
`/api/ingest-upload` memakai `RATE_LIMITS.ingest` (5 req/mnt). Frontend mengupload chunk 4MB **berurutan** → file >20MB = 6+ chunk → **chunk ke-6 selalu kena 429 "Rate limit exceeded"** → upload gagal / user retry berkali-kali → terasa "upload lama". FIX: bucket khusus `ingestUpload` (120/mnt) — aman karena per-chunk dibatasi 5MB dan total 50MB di sisi server (FIX-A-3).

### PERF-UPLOAD-2: Last-chunk re-download SELURUH file dari DB hanya untuk menghitung total byte
`findMany({select:{data}})` menarik semua byte chunk (hingga 50MB) dari Postgres hanya untuk `sum(c.data.length)`. FIX: `SELECT COUNT(*), SUM(LENGTH("data"))` — Postgres menghitung in-process, hanya 2 integer yang ditransfer.

### PERF-UPLOAD-3: File ter-transfer 3× + parse 2× pada alur detect → import-all
Alur: (a) upload N chunk ke DB, (b) last-chunk menarik semua chunk kembali (lihat PERF-UPLOAD-2), (c) `detect` reassemble = **menarik semua chunk lagi** + parse Excel penuh, (d) `import-all` reassemble **lagi** + parse **lagi**. FIX: (i) verifikasi ukuran kini via agregat (PERF-UPLOAD-2); (ii) `/tmp/ingest-process/{fileHash}{ext}` yang ditinggalkan `detect` kini di-REUSE oleh import/import-all (path content-addressed by SHA-256 + cek ukuran advisory) — 1 full-download + 1 parse hilang; cold instance serverless fallback transparan ke jalur lama.

### PERF-UPLOAD-4: Chunk di-upload SEKUENSIAL — `FileUploadDialog.tsx`
1 fetch = 1 round-trip penuh per 4MB. FIX: worker pool 3-konkuren; chunk TERAKHIR selalu dikirim paling akhir (server memakai chunk terakhir sebagai pemicu verifikasi jumlah+ukuran → baru PERF-UPLOAD-3 check chunk count server-side `storedChunks !== totalChunks`).

### PERF-IMPORT-1/2: ~442 round-trip upsert master-data PER IMPORT — `process-rows-for-import.ts`
Setiap kemunculan pertama outlet (333) / item (109) → 1 `await upsert` SEKUENSIAL di dalam transaksi interaktif (5-15ms per hop lewat pooler Supabase → 3-8s latensi murni per upload, berulang tiap request karena map selalu mulai kosong). FIX: 3-pass — (1) CPU normalize+derive semua baris sambil kumpulkan kandidat outlet/item distinct, (2) resolusi SET-BASED (findMany IN → createMany skipDuplicates → findMany ids; ± 4 query total, race-safe paritas BUG-5-5, LOGIC-12 area/name refresh hanya saat beda nilai), (3) enqueue + insert via Map lookup (0 query master-data per baris). `BATCH_SIZE` 500 → 1000 (42 kolom × 1000 = 42K bind params < limit 65.535) → jumlah round-trip createMany per 35K baris turun 70 → 35.

### PERF-DELETE-1 (FATAL): `maxDuration=30` di `/api/data` — hapus bulan/reset semua terpotong Vercel
InventoryRecord punya **~16 index** (12 `@@index` + unique + NULL-safe + INCLUDE covering) → DELETE per baris membersihkan 16 entri index; reset semua = 306K baris × 16 ≈ 5M operasi index dalam SATU transaksi → puluhan detik → Vercel mematikan function di 30s → client timeout → user retry → kena 429 (bucket 5/mnt) "tunggu beberapa menit" → inilah "hapus juga lama". FIX: `maxDuration` 300 (paritas ingest-process).

### PERF-DELETE-2: Reset semua kini TRUNCATE — `data/route.ts`
`TRUNCATE TABLE "DQIssue","InventoryRecord","Week","SourceFile","OutletPeriodSales"` — operasi level-metadata O(1) terhadap jumlah baris (vs DELETE row-by-row × 16 index), tetap atomik, sequence dipertahankan (id lanjut seperti jalur lama). Outlet/Item sengaja tidak di-truncate (master data, FK Restrict).

### PERF-DELETE-3: Hapus bulan/file vs import paralel bisa interleave
DELETE tidak memegang advisory lock yang sama dengan import (`pg_advisory_xact_lock(hashtext(monthKey))`) → hapus bulan yang bersamaan dengan import bulan sama menghasilkan state tergantung urutan commit. FIX: lock ditambahkan sebagai statement pertama di transaksi delete month & fileId (xact-scoped, key space sama dengan import).

---

## ⚡ OPTIMASI KESEPAKAN INTERAKSI FRONTEND (akar "lemot saat dipakai") — PAKET A

Audit susulan (setelah upload/delete) menemukan 3 penyebab utama aplikasi terasa berat SAAT DIPAKAI sehari-hari (pindah tab, mengetik pencarian, refresh background). Semuanya fixed di paket ini:

### FE-INTERACT-1 (P1): Pindah tab = remount seluruh subtree + refetch storm — `page.tsx` + `PeerComparison.tsx` + `RestoAnalysis.tsx`
Dua lapis masalah yang saling menguatkan:
1. **Remount**: `TabsContent` Radix tanpa `forceMount` → setiap pindah tab, seluruh isi tab (chart, tabel, state lokal seperti outlet peer terpilih) di-*unmount* dan dibangun ulang dari nol.
2. **Refetch storm**: 4 query (`peer-comparison` main/items/trend di `PeerComparison.tsx` + `outlet-items` di `RestoAnalysis.tsx`) tanpa `staleTime` → jatuh ke default global 30 dtk → user balik ke tab Peer/Resto setelah >30 dtk = 3-4 request ditembak ulang padahal data tidak berubah (hanya berubah saat upload / tombol refresh — yang memang sudah meng-invalidate key-key ini).

FIX: (a) `forceMount` + `data-[state=inactive]:hidden` di kelima `TabsContent` (keep-alive — state & DOM bertahan, ganti tab jadi instan; Radix tidak menyembunyikan konten force-mount sendiri, class Tailwind yang melakukannya); (b) `staleTime: 5*60_000` + `gcTime: 10*60_000` pada 4 query tersebut (paritas dengan umur cache server & semantik "data hanya berubah saat ingest/refresh").

### FE-INTERACT-2 (P1): Autocomplete item-search = 1 request per huruf — `ItemTrendTab/index.tsx`
`useDeferredValue` **bukan debounce** — ia hanya menunda render; nilainya tetap berubah tiap ketikan → queryKey baru per karakter → "ayam goreng" = 9 request ke `/api/item-search`. FIX: debounce timer 300ms (`setTimeout`/`clearTimeout` di `useEffect`, clear instan delay-0 saat input dikosongkan); prop `debouncedQuery` ke `ItemTrendSearchBar` (pengganti `deferredQuery`).

### FE-INTERACT-3 (P2): Dashboard "terkunci" saat refresh background + animasi tab ganda
1. **isFetching drill**: prop `analysis.isFetching` diturunkan ke 4 komponen tab → setiap background refetch toggling false→true→false mengalahkan `React.memo` (10+ section re-render 2× per siklus); `FetchAware` men-dim + `pointer-events-none` → seluruh dashboard tidak bisa diklik selama refresh (padahal data lama masih valid dipakai).
2. **Animasi ganda**: class `animate-fade-in-up` (0.3s) di tiap `TabsContent` **ditumpuk** rule CSS `[data-state=active][role=tabpanel]{animation:fadeInUp .25s}` → animasi entrance berlapis tiap ganti tab di subtree ratusan node DOM.

FIX: (a) seluruh wrapper `FetchAware` + prop `isFetching` dihapus dari `DashboardTab`/`RestoTab`/`PeerTab`/`ParetoTab` + `SectionHeader` (indikator refresh kini tunggal & global di `DashboardHeader.analysisFetching`); (b) kedua lapis animasi dihapus (tab switch instan).

**Verifikasi**: `tsc --noEmit` 0 error · eslint 11 file berubah 0 error · vitest **438/438** · perilaku Radix `forceMount` diverifikasi langsung dari source `@radix-ui/react-tabs@1.1.13` (konten force-mount tetap dirender + `hidden=false` → wajib class hide; tidak bergantung asumsi).

---

## ⚡ OPTIMASI BACKEND (akar "lemot" server-side) — PAKET B

Audit susulan D-a menemukan sisa beban backend terbesar: scan periode sama berulang 7-10×, jalur import kedua masih per-baris, dan fetch metadata duplikat per request. Semuanya fixed di paket ini:

### PERF-DB-SCAN-1 (P1): 4 KPI single-row men-scan WHERE identik 4× — `queries/dashboard.ts` + `run-queries.ts` + `export-report/data-fetcher.ts`
`queryExecSummary`, `queryDeviationBreakdown`, `queryLossVsSurplus`, `queryCostImpact` masing-masing scan `WHERE monthLabel+weekLabel+f` yang SAMA (35K baris) + 4 transaksi terpisah. FIX: `queryDashboardKpis` — SATU scan + SATU transaksi menghasilkan semua 21 ekspresi (13 exec + residual + 2 count + 5 cost); breakdown/lvs/costImpact diturunkan via `kpisToBreakdown`/`kpisToLvs`/`kpisToCostImpact` (field-per-field identik — ekspresi yang sama persis, beberapa bahkan sudah overlap di kode lama: `totalLoss`≡`lossNominal`, `qtyDeviasi`≡`total`). Fungsi lama tetap ada (dites unit + pemanggil lain); pipeline analysis & export-report kini pakai versi merge. **3 scan + 3 transaksi hilang per request dingin.**

### PERF-DB-SCAN-2 (P1): queryTopItemsByCategory ×4 → 1 query — `by-other-metric.ts`
4 query kategori (waste/susut/trial/lossSurplus) scan periode + join yang sama; export-report bahkan 8× (4 curr + 4 prev). FIX: `queryTopItemsByAllCategories` — 1 scan, ranking per kategori di sisi server via `ROW_NUMBER() OVER (ORDER BY SUM(ABS(qtyX)) FILTER (...) DESC)`, hanya union top-N yang keluar DB (pola yang sama dengan fix variance & nested-Pareto). Presisi semantik dijaga: `FILTER (WHERE qtyX IS NOT NULL AND qtyX != 0)` identik dengan WHERE lama per kategori, direction per kategori replikasi `DIRECTION_FROM_SUM_SQL` atas row-set terfilter yang sama. **Analysis: 4→1 query; export: 8→2.**

### PERF-DB-SCAN-3 (P2): growthDrivers 4 transaksi → 2 — `growth-drivers.ts`
3 dari 4 metrik (bom/qtyDeviasi/nominalDeviasi) grain-ITEM: masing-masing FULL OUTER JOIN curr×prev sendiri = 8 scan period. FIX: `aggregateItemMetrics` — 1 pasang CTE + 1 FULL OUTER JOIN menghasilkan 3 pasang metrik per item (`FILTER (WHERE field IS NOT NULL)` = parity filter row lama; group yang semua-row-NULL → 0/0 → delta 0 → terfilter threshold, identik hasil akhirnya). Sales (grain outlet) tetap query sendiri (grain beda). **8→4 scan period; 4→2 transaksi.**

### PERF-IMPORT-3PASS (P1): jalur `/api/ingest` & `import-drive` masih upsert master-data per-baris — `process-ingestion.ts`
Fix C5 (3-pass bulk master-data) hanya diterapkan ke `/api/ingest-process`; jalur process-ingestion masih `await tx.outlet.upsert(...)` per kode baru di dalam loop baris — import pertama dengan master baru = **±446 round-trip sequential** (5-15ms per hop via pooler). FIX: helper `ensureOutletsExist`/`ensureItemsExist` di-export dari `process-rows-for-import.ts` dan dipakai ulang: PASS 1 (CPU: validate+normalize+derive + kumpul kandidat distinct, first-seen-wins), PASS 2 (di dalam tx setelah advisory lock: findMany IN → update-bila-bedua → createMany skipDuplicates → findMany ids; parity BUG-5-5 race-safe + LOGIC-12 refresh area/nama + backfill satuan), PASS 3 (enqueue + batch insert via Map murni). Week upsert (3-4 unik) di-hoist dari loop. **±446 → ±4-8 query per import.**

### PERF-FETCH-4 (P2): `resolveComparePeriod` re-fetch week+sourceFile sequential — `period-resolver.ts` + `fetch-records.ts`
Stage-2 sudah mengambil `weeksRaw`+`fileMonthKeys` paralel, lalu resolver fetch ulang KEDUANYA **secara sequential** (2 RT + 1 barrier serial) di SETIAP request analysis/export/outlet-items/rekomendasi. FIX: (a) parameter `preloaded?: PreloadedPeriodTables` — analysis fetch-records kini meneruskan data yang sudah ada (0 query ekstra); (b) pemanggil tanpa preloaded kini `Promise.all` (2→1 barrier). Backward-compatible (param opsional).

### PERF-TXMEM-5 (P3): `work_mem 64MB` per transaksi × ~10 konkuren = tekanan memori — `queries/shared.ts`
Budget teoretis 640MB vs shared Postgres kecil. FIX: 64MB → **32MB** (sort agregat di pipeline ini ≤ beberapa MB per sort node — tetap bebas spill, tekanan memori terpangkas separuh).

### Catatan desain — kenapa "pajak round-trip" withStatementTimeout TIDAK di-batch penuh (keputusan disengaja)
Temuan D-a F1 memperkirakan +110-120 round-trip per request dingin. Analisis lebih dalam menunjukkan estimasi itu mengasumsikan RT serial — padahal batch pipeline ini menjalankan 5-6 transaksi PARALEL (BEGIN/SET/COMMIT saling tumpang-tindih antar koneksi), jadi biaya wall-clock riil ~50-150ms. Menggabungkan query ke 1 transaksi per batch akan MENYERIALKAN query di satu koneksi → regresi wall-clock justru lebih besar (3× durasi query per batch) saat cache dingin. Kompromi (split K-transaksi per batch) menambah kompleksitas + risiko isolasi-kesalahan (query non-blocking seperti pareto yang di-`.catch()` bisa meracuni transaksi bersama). Keputusan: scan-merge (F2/F6) yang mengurangi PEKERJAAN DB (bukan hanya RT) + work_mem turun + dokumentasi ini agar maintainer masa depan tidak "memperbaiki" arah yang salah. RT tax yang tersisa sudah ter-overlap paralel.

**Verifikasi**: `tsc --noEmit` 0 error · eslint 10 file berubah **0 error** (15 warning pre-existing, terverifikasi identik di HEAD) · vitest **438/438** (termasuk test growth-drivers, dashboard, top-items) · parity semantik didokumentasikan per-fix di komentar kode.

---

## 🚀 OPTIMASI DEPLOY VERCEL — PAKET C

Audit D-a (poin 11) menemukan bahwa konfigurasi deploy membuat batas waktu route **tidak pernah sepenuhnya aktif** di Vercel, plus satu lockfile "zinaya" yang bisa menghidupkan kembali dependency yang sudah dihapus. Semua fixed di paket ini:

### DEPLOY-1 (P2): blok `functions` vercel.json = no-op — `vercel.json`
Key lama `"src/app/api/ingest"` & `"src/app/api/import-drive"` (tanpa suffix `/route.ts`) tidak match function mana pun — schema resmi vercel.json (openapi.vercel.sh) mensyaratkan key = **glob path FILE** function (mis. `src/app/api/ingest/route.ts`), bukan direktori route. Artinya selama ini `maxDuration` produksi 100% berasal dari `export const maxDuration` di 31 route (mekanisme native Next.js di Vercel — memang sudah benar semua), dan blok `functions` hanya memberi rasa aman palsu + sumber kedua yang bisa drift. FIX: blok dihapus — single source of truth = route export (intent 300s untuk ingest & import-drive sudah tercakup oleh export di kedua route itu); ditambah `$schema` agar editor memvalidasi config terhadap schema resmi.

### DEPLOY-2 (P1): Fluid Compute belum diaktifkan → `maxDuration` 120s/300s di-clamp 60s — `vercel.json`
Tanpa Fluid Compute, plafon duration Vercel **Hobby = 60 dtk** (Pro = 300 dtk) — artinya `analysis` (120s) dan `data`/`ingest`/`import-drive`/`ingest-process` (300s) yang dinaikkan di paket-paket sebelumnya **terpotong di 60 dtk pada produksi ber-plan Hobby** (import file besar / reset-semua putus di tengah jalan — gejala "upload selalu gagal setelah ~1 menit"). FIX: `"fluid": true` — properti **top-level project-wide** per schema resmi (project baru default ON, project lama harus opt-in eksplisit; nilai `true` menutup kedua kasus). Efek samping positif untuk app ini: satu instance kini melayani request konkuren (bukan 1 request : 1 instance) → cache in-memory (`aggregation-cache` 5 mnt, settings 30 dtk, month-resolver) & bucket rate-limit jadi konsisten lintas-request (tidak "reset" tiap instance baru), cold start jauh lebih jarang, dan throughput request paralel (chunk upload ×3, prefetch FE) naik tanpa menambah instance. `maxDuration` per route (10–300s) tetap berlaku apa adanya — fluid hanya mengangkat plafonnya. **Verifikasi pasca-deploy (tidak bisa dilakukan dari repo): dashboard Vercel → Project → Settings → Functions → indikator Fluid ON. Bila project lama mengabaikan config, aktifkan toggle Fluid di dashboard.**

### DEPLOY-3 (P3): `/api/pic/import` tanpa `maxDuration` — `src/app/api/pic/import/route.ts`
Route ini menjalankan `$transaction` berisi hingga ±333 `outletPIC.update` sequential (via pooler bisa >10 dtk) + `invalidateAnalysisCache()` — melebihi default Vercel 10 dtk → timeout di tengah import PIC. FIX: `export const maxDuration = 60` (paritas dengan route mutasi lain). `/api/route.ts` berupa health endpoint trivial — default 10s memang cukup.

### DEPLOY-4 (P3): `package-lock.json` stale — `npm ci` akan meng-install dependency yang sudah dihapus — dihapus dari repo
Kedua environment deploy memakai **bun** (Vercel: `buildCommand` = `bunx prisma generate && bun run next build`; Railway: `startCommand` = `bun run start`) dan `bun.lock` aktif ter-maintain serta **sinkron** dengan package.json (section dependencies tidak berubah sejak regenerasi terakhirnya — terverifikasi; 10+ paket radix yang dihapus memang tidak ada di lock). Sementara `package-lock.json` terakhir diupdate **2026-08-26** dan tertinggal 2 perubahan package.json: masih memuat 10+ paket `@radix-ui/react-*` yang **sudah sengaja dihapus** pada cleanup audit — `npm ci` di environment mana pun (Docker, nixpacks-jika-deteksi-npm, CI) akan memasang graph dependency LAMA yang salah secara diam-diam. FIX: file dihapus — deteksi package manager Vercel/Railway/nixpacks kini deterministik (bun.lock satu-satunya), dan tidak ada lagi lockfile yang "berbohong". Bila kelak alur npm benar-benar diperlukan: `npm install --package-lock-only` meregenerasi lock segar dari package.json terkini.

**Verifikasi**: vercel.json tervalidasi terhadap schema resmi openapi.vercel.sh (difetch & diinspeksi: `fluid` = properti top-level boolean; opsi per-function memang mensyaratkan glob path file) · sinkronisasi `bun.lock` ↔ `package.json` diverifikasi offline (50/50 dependency, 0 missing/extra, spec identik — tidak perlu `bun install` ulang) · `tsc --noEmit` 0 error · eslint 0 error · vitest **438/438**.

---

## 🧭 FITUR ANALISA BARU — PAKET E: Tab "Kepatuhan" (Kontrol & Kepatuhan)

Fitur analisa tambahan pertama — dibangun di atas infrastruktur yang sudah teruji (scan-merge ala Paket B, cache 5 mnt, keep-alive tab ala Paket A). **6 lensa kontrol + 1 lensa turunan dari SATU scan periode** (`src/lib/queries/compliance.ts` — CTE `base` direferensikan oleh 6 agregat → PostgreSQL mematerialisasikannya SEKALI → 1 scan fisik + agregat murah; hasil kembali dalam 1 round-trip via `UNION ALL (lens, to_jsonb(row))` — `to_jsonb` sekaligus menormalkan COUNT bigint ke angka JSON):

1. **FEAT-COMPLIANCE-1 (Kepatuhan Toleransi per item)**: ranking item berdasarkan jumlah & nominal pelanggaran |Deviasi/BOM| > toleransi. Semantik **100% paritas rule engine** (`f_tol_breach` / `f_tol_breach_high` / `f_tol_not_set`) — threshold di-load dari `getRuntimeThresholds()` yang sama dengan `rule-evaluation.ts`, jadi panel dan mesin rule tidak mungkin berbeda versi. Sebelumnya flag ini hanya baris per-record di daftar rule — kini ada panel agregat per item.
2. **FEAT-COMPLIANCE-2 (Prioritas Penetapan Toleransi)**: item TANPA toleransi tapi deviasi besar + melebihi ambang standar — daftar aksi "tetapkan toleransi item ini dulu". Data (`tolerancePct` + `pctQtyDeviasiToBom`) ada sejak awal, belum pernah dianalisa agregat.
3. **FEAT-COMPLIANCE-3 (Deviasi Tak Terjelaskan per outlet)**: residual = deviasi − (waste+susut+trial), per outlet, dengan klasifikasi WARN/HIGH paritas `f_resid_warn`/`f_resid_high` — indikator penyelidikan terkuat (pencurian/salah input). Sebelumnya hanya 1 angka total di KPI dashboard.
4. **FEAT-COMPLIANCE-4 (Efisiensi vs Penjualan)**: |deviasi nominal| / penjualan per outlet — pembanding apple-to-appel antar outlet beda ukuran (`nominalSales` denormalized per record; `MAX` per outlet per minggu = pembacaan aman tanpa multiplikasi). Outlet tanpa data penjualan dikecualikan.
5. **FEAT-COMPLIANCE-5 (Lens Kategori BAHAN vs PACKAGING)**: split |deviasi| + rincian waste/susut/trial + residual per kategori (`Item.category` sudah terisi, belum pernah jadi lensa analisa).
6. **FEAT-COMPLIANCE-6 (Indikasi Transfer Antar Outlet)**: item×area yang di minggu yang sama punya outlet **LOSS** dan outlet **SURPLUS** sekaligus (GROUP BY item,area,direction + `ROW_NUMBER` outlet terbesar per sisi) — pola klasik stok berpindah tanpa dokumen / salah pencatatan dua sisi; "nilai cocok" = min(total loss, total surplus).
7. **FEAT-COMPLIANCE-7 (Ketidakcocokan Antar-Area — mismatch pairs #5)**: item yang sama di minggu yang sama menunjukkan **LOSS terkonsentrasi di area A** sementara **SURPLUS muncul di area B ≠ A** — indikasi stok berpindah ANTAR AREA tanpa dokumen transfer (mutasi gudang/area) atau pencatatan ganda. Pairing dilakukan di lapisan shaping dari baris `transfer_agg` yang SAMA (baris per item×area×direction) → **nol scan SQL tambahan, nol round-trip tambahan** — total tetap 1 query/1 scan. Semantik konsisten v1: "nilai cocok" per pasangan = min(total loss area A, total surplus area B), outlet terbesar per sisi dari `transfer_top` yang sama. Pasangan bersifat **kandidat penyelidikan, bukan partisi** (satu sisi bisa muncul di beberapa pasangan — didokumentasikan di tooltip FE). Sort deterministik (matchNominal → matchQty → itemId → nama area) + slice top 15; ringkasan baru `crossAreaSignalCount` / `crossAreaMatchNominalTotal` digabung ke kartu KPI "Sinyal Transfer" (value = total dalam-area + antar-area). Perilaku filter: saat filter area aktif hanya 1 area yang masuk scope → sinyal antar-area otomatis kosong (teks empty-state menjelaskan).
8. **FEAT-COMPLIANCE-8 (Kronis vs Sekali-Timu per Outlet — chronic-vs-spike)**: lensa perilaku **level BULAN** (route terpisah `/api/chronic-outlets` — tanpa param `week` BY DESIGN) menjawab: outlet ini menyimpang **TIAP MINGGU** (kronis → masalah sistemik: proses/PIC/kebocoran) atau **buruk hanya di satu minggu dominan** (spike → peristiwa sekali-timu, cek kejadian minggu itu)? Query `src/lib/queries/chronic-outlets.ts`: 1 scan bulan penuh — CTE `wk` (SUM per outlet×minggu: |dev|, net, residual) direferensikan 3 CTE → dimaterialisasi SEKALI → rollup per outlet (COUNT FILTER minggu deviasi/residual/loss/surplus) + argmax minggu terburuk via `ROW_NUMBER`. Klasifikasi heuristik terdokumentasi di konstanta: **KRONIS** = deviasi di ≥3 minggu DAN ≥75% minggu berdata; **SPIKE** = minggu terburuk ≥60% |dev| bulanan (min 2 minggu); sisanya VARIABEL. Per-outlet juga: arah dominan (loss/surplus/campuran per minggu), total & rata |dev|, minggu terburuk + porsinya, minggu residual. FE: section ke-8 tab Kepatuhan — query kedua TanStack **keyed month-only** (ganti minggu TIDAK refetch — cache 5 mnt reusable antar minggu), invalidasi refresh `['chronic-outlets']`; badge KRONIS/Spike/Variabel + sub-baris minggu residual.
9. **FEAT-COMPLIANCE-9 (Kualitas Input: Angka Bulat — round-number heuristic)**: share |qtyDeviasi| "berakhiran 0/5" per outlet dibandingkan **baseline periode** — indikator PIC yang **menaksir** alih-alih menghitung stok fisik (manusia memfabrikasi/mengestimasi cenderung menghasilkan angka bulat; hasil hitung nyata jarang serong 0/5). Predikat SQL di atas `base` yang SAMA: `ROUND(|qtyDeviasi|×10)::int % 5 = 0` (menangkap akhiran .0/.5 dan digit akhir 5/0 — decigram integer menetralkan noise float) + tingkat ketat `% 10` ("berakhir 0"); 3 kolom FILTER di `outlet_agg` + 3 di `totals` (baseline) → **nol scan/round-trip tambahan**, tetap 1 query. Shaping: outlet dengan < 3 baris deviasi dikecualikan (share = noise); sort Δ di atas baseline (tersangka terjauh di atas) → share → outletId; `roundBaseline` level-result untuk badge FE. Caveat terdokumentasi di tooltip: satuan kemasan (pcs isi 5/10, kg granularitas 0,5) membuat angka bulat wajar — **selalu bandingkan dengan baseline**, jangan nilai absolut.
10. **FEAT-COMPLIANCE-10 (Momentum Outlet — akselerasi |deviasi|)**: tren arah besaran deviasi per outlet sepanjang bulan — **memburuk** (besaran sedang membesar, intervensi sebelum makin dalam) vs **membaik** vs stabil. Digabung ke query chronic yang SAMA (tetap 1 scan bulan, 1 round-trip): baris per outlet×minggu dari CTE `wk` dikembalikan sebagai lensa `'week'` UNION ALL tambahan (weekNo dari `CAST(SUBSTRING(weekLabel FROM '[0-9]+') AS int)` — aman karena nomor minggu dalam sebulan selalu 1 digit); shaping JS menghitung rata |dev| **paruh kedua vs paruh pertama** minggu outlet (index split, gap kalender diabaikan; band ±25% = STABLE; paruh pertama nol + paruh kedua ada = 'baru' WORSE dengan pct null). Ringkasan `worseningCount`; FE kolom "Momen" di tabel kronis (+ rose memburuk / − emerald membaik) + badge section menampilkan hitungan memburuk.
11. **FEAT-COMPLIANCE-11 (Drilldown Baris Item)**: baris item pada 4 tabel item-grain (Kepatuhan Toleransi per Item, Prioritas Penetapan Toleransi, Indikasi Transfer Antar Outlet, Ketidakcocokan Antar-Area) kini **bisa diklik** → membuka modal `ItemDeepDive` yang sudah ada (drilldown seluruh outlet untuk item itu pada minggu terpilih, limit 500 — reuse penuh komponen & query `/api/drilldown`, nol endpoint baru). Aksesibilitas memakai helper yang sama dengan TopItems (`clickableRowProps` dari `src/lib/a11y.ts`: `role="button"`, `tabIndex=0`, Enter/Space) — konsisten pola dashboard; hover bg + cursor + baris tips di atas section pertama sebagai affordance. (Tabel outlet-grain — residual/penjualan/kronis — sengaja tidak diklik: drilldown ItemDeepDive berbasis item×minggu, bukan outlet×bulan.)

**Route** `/api/compliance`: GET `month`+`week` wajib + filter `area/kelompok/outlet/pic` (regex + resolusi kelompok∩PIC paritas flip-ranking), rate-limit 30/mnt, cache DB 5 mnt (`withCacheAndDedup`, SWR stale flag), `maxDuration` 60. **Route** `/api/chronic-outlets`: GET `month` wajib (month-grain, tanpa `week` — strict zod menolak param liar), pola rate-limit/cache/maxDuration identik. **FE**: tab ke-6 "Kepatuhan" (lazy import + `forceMount` keep-alive; strip 6 KPI ringkasan + 9 section tabel; TanStack `staleTime` 5 mnt + `gcTime` 10 mnt + `keepPreviousData`; tombol refresh meng-invalidate key `['compliance']` + `['chronic-outlets']`).

**Verifikasi**: `tsc --noEmit` 0 error · eslint 6 file berubah **0 error** (0 warning baru) · vitest **438/438**. (Catatan: browser/live-DB smoke test tidak memungkinkan di sandbox — tidak ada `.env`/akses DB; verifikasi mengikuti standar paket A/B/C.)

---

## 🧹 PAKET F — P3 HYGIENE (sisa temuan audit P3, low-effort high-certainty)

Tujuh item hygiene yang tersisa dari audit (semua sudah terverifikasi kelayakannya di riset audit awal, tidak ada yang butuh keputusan desain baru):

1. **P3-HYG-1 (double-serialize cache ~1MB)** — `aggregation-cache.ts` + `analysis/services/validate-and-resolve.ts`. Cache hit `/api/analysis` membayar **serialisasi ganda**: `JSON.parse(row.payload)` (~1MB string → objek, 10–20ms) di `getCachedWithMeta`, lalu `NextResponse.json()` meng-stringify objek itu **lagi** (~1MB, 10–20ms) — padahal string JSON-nya sudah utuh di DB. Payload analysis adalah cache row terbesar di sistem (~1MB) dan hit-nya paling sering (setiap ganti tab/filter/minggu yang jatuh ke cache hangat) → ±20–40ms CPU murni per hit, dikali N user × N interaksi. Fix: helper baru **`getCachedRawWithMeta`** (kembalikan string mentah + flag stale — semantik SWR identik, tanpa parse) + jalur hit baru di validate-and-resolve: flag envelope `"cached":true`/`"stale":true` di-inject lewat **string surgery O(1) tepat setelah `{` pembuka** (`'{' + inject + raw.slice(1)`) — aman dari duplicate-key karena payload tersimpan TIDAK pernah memuat `cached`/`stale` (`assembleResponse` tidak mensetnya; flow lama memutasi SALINAN hasil parse, bukan payload). Shape guard murah menggantikan cek objek lama: `raw[0]==='{' && raw.includes('"success":')` (scan substring 1MB = µs, level C). Dampak perilaku terdokumentasi: `durationMs` pada hit kini memuat **durasi compute asli** (semantik lama: durasi baca cache) — tidak ada konsumen FE untuk field ini (fmtNum/dialog hanya memakai duration milik response ingest/upload). In-flight dedup tetap benar: cache hit me-resolve in-flight dengan **marker raw** (`{__rawJson, stale}`) dan awaiter di atas fungsi melayani marker dengan response raw yang sama (tetap nol recompute); jalur fresh-compute (route.ts) tidak berubah (objek, satu kali stringify). Keputusan terdokumentasi: helper generik `withCacheAndDedup` (dipakai 15+ route lain) TIDAK diubah — payload route lain jauh lebih kecil dan envelope-nya di-spread per-route (butuh parse memang); analysis adalah satu-satunya payload ~1MB.
2. **P3-HYG-2 (index `[direction]` dead — write amplification)** — `prisma/schema.prisma`. Indeks single-column atas `InventoryRecord.direction` (3 nilai: LOSS/SURPLUS/NEUTRAL) tidak pernah dipakai: **tidak ada satu pun query yang mem-filter kolom tabel ini** (setiap `"direction"` di `src/lib/queries` adalah nilai SELECT hasil komputasi SUM/CTE; `/api/migrate-direction` hanya SET). B-tree kardinalitas-3 tidak akan pernah dipilih planner — biayanya murni write amplification: setiap ingest (~54K baris/bulan) + bulk import memelihara B-tree mati. Dihapus dari schema (komentar terdokumentasi di lokasi sama); **berlaku pada `db:push` berikutnya** — konsisten dengan catatan operasional AUDIT-DB-PUSH-2 (setelah push apapun, jalankan `bun run db:recreate-covering-indexes`).
3. **P3-HYG-3 (3 route peer-comparison tanpa cache + tanpa invalidasi)** — `api/peer-comparison/{route,items,trend}`. Ketiga route ini menjalankan pipeline CROSS JOIN + grouping multi-CTE **di setiap request** (tab Peer mem-fire ketiganya tiap ganti outlet/perioda/filter), dan TIDAK terdaftar di `invalidateAnalysisCache` (mutasi data tidak membersihkan apa pun — memang tidak ada yang bisa basi karena memang tidak di-cache). Fix: dibungkus **`withCacheAndDedup` TTL 5 mnt** (pola keluarga analysis/pareto/compliance): route utama — key `outlet/month/week/kelompok` + extra `{mode,limit}`; `/items` — compute di-ekstrak ke fungsi murni `computePeerComparisonItems` (parameter sudah tervalidasi + month-resolved sebelum masuk) + extra `{mode,topItems}`, interface di-hoist ke module scope; `/trend` — **kedua jalur** (peer eksplisit dari FE dan auto-compute `queryPeerComparison`) masuk dalam satu computeFn, key memuat `peers` eksplisit (penentu penuh peer-set) + `kelompok` (hanya relevan jalur auto — dimasukkan tanpa syarat demi simpel, paling buruk 2 entry, tidak pernah salah hit). Ketiganya kini juga terdaftar di `invalidateAnalysisCache()` (18 route total). Response envelope (`success/targetOutlet/…`) dibangun ulang tiap request — flag `cached`/`stale` tidak terbeku di cache.
4. **P3-HYG-4 (cache docx: number[] bloat 4×)** — `export-report/services/docx-builder.ts` + `export-report/route.ts`. Buffer docx (±500KB) di-cache sebagai **`Array.from(buffer)` number[]** → JSON-nya ~4× ukuran biner (tiap byte jadi `"123,"` — cache row ~2MB + `JSON.parse` lambat) dan rekonstruksinya `Buffer.from(number[])` harus mem-walk array 500K elemen. Fix: **`bufferBase64`** (`buffer.toString('base64')` — row 1.33× biner, parse string instan; consumer `Buffer.from(b64,'base64')` decode cepat). Route consumer ikut diperbaiki (tipe generic + rekonstruksi) — tanpa ini build rusak (tsc menangkap saat integrasi).
5. **P3-HYG-5 (TrendChart mati di-bundle)** — `Charts/TrendChart.tsx` dihapus + export barrel `Charts/index.ts` dibersihkan. Komponen sudah lama tidak dirender (DashboardTab — komentar "TrendChart removed per user request") tapi masih di-export barrel → tetap ter-bundle di lazy chunk Charts yang tidak ada yang merender. `TrendChartCard` milik PeerComparison adalah komponen BERBEDA (`peer-comparison/trend-chart.tsx`) — tidak terpengaruh.
6. **P3-HYG-6 (keydown: querySelector 3-selector di setiap keypress)** — `hooks/useDashboardActions.ts`. Handler keydown global menjalankan `document.querySelector('[role="combobox"]…, …, …')` **sebelum guard digit-tab** — berarti tiap ketikan biasa di input (huruf apa pun) tetap membayar probe DOM 3-selector. Fix: selector di-hoist ke konstanta module + probe hanya dievaluasi **setelah** key terbukti salah satu digit tab `1..5` (constant folding untuk semua keypress lain — guard dropdown pindah ke dalam cabang digit).
7. **P3-HYG-7 (render-time compute tanpa memo ×3)** — `TopItems.tsx` + `resto-analysis/ranking-nasional.tsx`. (a) `TopItemsByNominal`: array data BarList + closure handler dibangun ulang tiap render → memo BarList tak pernah hit — kini `useMemo` (deps array sumber, fallback `|| []` di-pin identitasnya dengan `useMemo` agar tidak baru tiap render) + `useCallback`; (b) `GapAnalysisCard` (dirender di 3 tab): pipeline filter→group-by→avgGap→sort atas `topDeviasiRank` (hingga 500 baris) + sort outlet per-item inline per repaint expand — kini satu `useMemo` (termasuk `sortedOutlets` pre-sorted); (c) `RankingNasionalCard`: filter+slice atas top-50 nasional per render → `useMemo`.

**Verifikasi**: `tsc --noEmit` 0 error · eslint 11 file berubah **0 error, 0 warning baru** (warning tersisa di TopItems/aggregation-cache/useDashboardActions diverifikasi pre-existing via stash-compare, 11 ≤ 12 baseline) · vitest **438/438** (22 file, 4s). (Catatan: live-DB/browser smoke test tidak memungkinkan di sandbox — standar paket A–E.)

---

## 🎨 UI/UX REVIEW + FIX PRIORITAS TINGGI — H-14 (2026-09-12)

Review UI/UX menyeluruh pertama (Fase A statis 2 reviewer paralel atas 103 komponen + Fase B perencanaan dinamis; eksekusi di `dc7e683`). Temuan lengkap: **3 TINGGI · 8 SEDANG · 10 RENDAH**. Yang TINGGI di-fix di paket ini (sisanya backlog di bawah).

### T1 (TINGGI) — CTA EmptyState mati saat DB kosong (onboarding rusak)
- **Akar**: satu-satunya listener `open-upload-dialog`/`open-drive-dialog` + satu-satunya mount FileUploadDialog/DriveImportDialog ada di **FilterBar** — padahal FilterBar hanya dirender `{hasData && …}` (DashboardHeader.tsx:130), kebalikan eksak dari saat EmptyState (yang mendispatch event itu) tampil. DB kosong → tombol "Upload File"/"Import dari Drive" di layar pertama pengguna baru = dead click.
- **Fix**: dialog + listener tunggal dipindah ke **page.tsx** (host level-halaman, selalu ter-mount); tombol FilterBar sendiri kini mendispatch event yang sama (satu listener, satu mount — tanpa risiko double-open dari CTA ErrorState saat FilterBar terpasang). FileUploadDialog/DriveImportDialog tetap `dynamic` lazy (bundle utama tidak berubah).

### T2 (TINGGI) — Kegagalan `/api/status` = loading palsu permanen
- **Akar**: `page.tsx` hanya meng-gate `status !== undefined` — field `error` query tidak pernah dibaca. `useStatus` throw saat server crash/timeout, retry habis, `refetchOnWindowFocus:false` → LoadingState + timer detik berjalan selamanya, mengklaim "memuat" padahal tidak akan pernah selesai.
- **Fix**: branch `statusError ? <ErrorState …/>` sebelum branch loading di page.tsx + `handleRetry` ErrorState kini juga meng-invalidate `['status']` (sebelumnya tombol retry no-op untuk kasus ini).

### T3 (TINGGI) — 12 query key tidak pernah di-invalidate oleh 6 handler mutasi (data basi lintas-tab)
- **Akar** (lanjutan utang H-12): `handleRefresh` punya daftar 18 key yang benar, tapi 6 handler lain (FileUploadDialog, DataManagementDialog, DriveImportDialog, FilterBar-ingest, SettingsDialog save/reset/migrate, PicManagementDialog) masih membawa subset lama 5-6 key. Karena tab keep-alive (`forceMount`) menjaga observer tetap terpasang + `refetchOnWindowFocus:false` global, key yang terlewat **tidak pernah ditanyakan ulang** (server-cache sudah bersih — browser-nya saja yang tidak bertanya). Konsekuensi nyata: hapus bulan non-current → tab Trend masih menampilkan periode terhapus; delete + re-upload file koreksi → Dashboard tab tampil angka baru tapi Pareto/heatmap/price-effect/drilldown tampil angka lama (dua tab dua kebenaran) — sampai user F5/reload.
- **Fix**: daftar 18 key diekstrak ke **`src/lib/query-invalidation.ts`** (`invalidateAllData(queryClient)`) — dipanggil oleh SEMUA 8 situs mutasi (refresh + 7 di atas; DataManagementDialog juga menambah `['dq-issues']` dialog-local). Satu sumber kebenaran; handler berikutnya tidak bisa lagi "lupa" key.

### Verifikasi H-14
`tsc --noEmit` 0 error · vitest **446/446** (25 file) · eslint `src tests` 0 error / 299 warning (identik baseline — 0 warning baru) · `next build` sukses. (Browser smoke test dinamis tidak memungkinkan di sandbox — tidak ada akses DB produksi; kode fix terverifikasi statis penuh.)

### Backlog UI/UX (tidak di-fix — dicatat untuk paket berikutnya)
- **SEDANG-1** `fmtGrowth` desimal titik vs `fmtPct` koma (format.ts:145-149) + ±15 situs ad-hoc `.toFixed` dot di InsightsPanel/PriceEffectCard/FlipRanking/correlation-insight-card/GrowthComparison/DeviationBreakdownChart/signal-chart/ranking-nasional/trend-chart — satu konsep dua separator, kadang berdampingan.
- **SEDANG-2** Badge duplikat `benchmarkHighCount` ≡ `highDevBomCount` (predikat SQL sama di-alias 2×, outlet-agg-scan.ts:146-147) → PrioritySummaryCard tampil 2 badge angka sama + 2 bullet analisa identik (resto-recommendations.ts:332/342).
- **SEDANG-3** SourceDataModal "Data Sumber **Lengkap**" hanya fetch/export 50 baris; hint digate `records.length === 50`, bukan `drill.data?.hasMore` yang sudah tersedia.
- **SEDANG-4** Tombol FilterBar "Refresh Data" sebenarnya POST `/api/ingest` (re-ingest folder server — kosong di Vercel) sedangkan refresh sejati (18-key) hanya ⌘/Ctrl+R tanpa tombol visible.
- **SEDANG-5** Sufiks axis ItemTrendLineChart `M`=juta/`K`=ribu vs konvensi app `M`=miliar/`Jt`/`Rb` (format.ts:2-6) — "M" bermakna 1000× beda antar tab.
- **SEDANG-6** GapAnalysisCard preset `idr0` (angka penuh) campur `fmtIDR` (kompak) dalam satu kartu (gap-analysis-card.tsx:71-73 vs :107).
- **SEDANG-7** Toast refresh sukses tanpa syarat + menelan kegagalan `/api/refresh` (useDashboardActions.ts lama; kini masih fire-and-forget di helper baru — perilaku dipertahankan sengaja agar non-blocking).
- **SEDANG-8** Touch target tab trigger ±26px & tombol header 32px (WCAG 2.5.8 pass ≥24px; rekomendasi ≥44px mobile — mitigasi: app PC-first).
- **RENDAH** (7): typo "rekoniliasi" (EmptyState); komentar stale DashboardHeader "Cari Item" + `setupRequired` dead field; spacing CardHeader pb-2 vs pb-3; SparkLine tanpa aria; hex hard-coded scatter-plot (dark palette terkunci light); affordance overflow tab-bar 375px; `N/A` vs `'—'`; konfirmasi `confirm()` native vs AlertDialog (semua aksi destruktif SUDAH ada konfirmasi — hanya gaya yang tidak seragam); spinner vs skeleton campur antar tab; tombol X tanpa aria-label di SourceDataModal/DrillDownDrawer; hint SettingsDialog stale; error heatmap tanpa tombol retry.
- **Terverifikasi BAIK** (tidak perlu sentuh): sticky footer benar (`min-h-screen flex flex-col` + `sticky bottom-0 mt-auto`); skip-link + semantic landmarks; keep-alive tab + visited-gating; `keepPreviousData`; error gate analysis dengan retry + hint timeout; export flow disabled+spinner+toast; shortcut keyboard dengan guard typing/dropdown; `prefers-reduced-motion` + scrollbar tipis + focus-ring row; BarList/DeltaBar/Tracker/AnomalyFlags a11y; sistem `formatByPreset` teruji; server-side invalidation cache 31 prefix di SEMUA route mutasi; konfirmasi aksi destruktif lengkap dengan penjelasan konsekuensi; rate-limit + advisory lock; DQ dsb.



---

## 🔒 SECURITY (ringkas)

| # | Severity | Temuan | Fix |
|---|---|---|---|
| S-02 | HIGH | `.env.example` menjanjikan "fail-closed in production" tapi middleware fail-open semua env | samakan doc & code |
| S-03/S-04 | HIGH | Upload chunked: batas 50MB dicek **hanya di chunk terakhir**; `Buffer.concat` tanpa cap → OOM; chunk orphan tanpa TTL | running total tiap chunk + cap byte sebelum concat + TTL cleanup |
| S-05/S-06 | HIGH | Drive import: download tanpa cap ukuran; exceljs tanpa cap baris (zip bomb) | abort stream @100MB, cap 50 file, cap 250K baris |
| S-07 | MED | `/api/refresh` POST tidak di `PROTECTED_PATHS` → anonymous bisa wipe cache + spam recompute | tambah ke list (1 baris) |
| S-08 | MED | `?admin_token=` di URL → bocor ke log/history/Referer | header-only |
| S-09 | MED* | GET semua data publik walau ADMIN_TOKEN diset (analysis, export docx, PIC) | gate reads jika perlu |
| S-10 | MED* | Param-spray bypass cache → pool exhaustion | rate limit ketat + semaphore |
| S-11 | MED | Error bocor host/port Supabase ke client (`ingest-process:584-602`, `setup:47-49`) | route via `errorResponse()` |

*\* berlaku saat deploy publik (file `railway.toml` & `vercel.json` ada di repo).*

**Yang sudah BAIK:** tidak ada SQL injection (semua `$queryRaw` tagged template), path traversal tertangani, SSRF Drive mitigated, zod di hampir semua route, CSP/HSTS, constant-time token compare, Prisma singleton, virtualization di drawer, memoization disiplin, sign convention & Z-score formula benar.

---

## 📋 URUTAN EKSEKUSI

| Prioritas | Item | Effort | Dampak |
|---|---|---|---|
| P0 | Rotasi password Supabase ×2 + purge git history + revoke PAT | 30 mnt | Tutup lubang terbesar |
| P1 | PERF-1 (double fetch) + PERF-7 (animasi) | 1-2 jam | Kecepatan terasa langsung |
| P1 | BUG-1 (dedup Week) + BUG-2 (fallback minggu) | 2-3 jam | Angka bisa dipercaya |
| P2 | PERF-2 (Pareto N+1) + PERF-3/4 (egress) | 3-4 jam | Cold path −50-60%, hilangkan stall |
| P2 | PERF-5/6 (TTL + race dedup) | 1 jam | Hilangkan recompute periodik |
| P3 | BUG-3/4/5 (ingest integrity) | 2-3 jam | Keamanan data |
| P3 | S-03..S-07 hardening | 2-3 jam | Siap deploy publik |
| P4 | PERF-8/9 + sisanya | bertahap | Polish |

---
## 📌 Status Implementasi (update)

**Sudah diterapkan di repo (commit berurutan):**

- `perf(fe)` — PERF-1 (fetch `/api/analysis` 1× via action atomik `setPeriod`), PERF-7 (animasi Recharts off)
- `perf(db)` — PERF-2 (Pareto N+1 → 1 query `ROW_NUMBER`), PERF-3/4 (filter baris di sisi SQL)
- `fix(cache/ingest)` — PERF-5 (TTL 30 mnt + SWR background recompute), PERF-6 (race dedup in-flight), BUG-1 (`@@unique([monthKey, weekLabel])` + purge lintas-file + script `db:fix-duplicate-weeks`), BUG-2 (fallback beda-minggu dihapus, FE+BE)
- `fix(ingest-integrity)` — **BUG-3/4/5**:
  - **BUG-3**: dedup natural-key in-memory di kedua jalur ingest (kunci `week|outlet|item|COALESCE(akun,'')`, jalan juga di fastMode) + script `bun run db:fix-null-akun-duplicates` (normalisasi `''`→NULL, dedup baris lama — keeper = baris terkaya data, tie-break id terbaru, lalu `CREATE UNIQUE INDEX "InventoryRecord_nullsafe_akun" ON "InventoryRecord"("weekId","outletId","itemId",COALESCE("akunPenyesuaian",''))` — indeks ekspresi yang tidak bisa diekspresikan di schema.prisma; `ON CONFLICT DO NOTHING` menghormatinya).
  - **BUG-4**: helper `insertInventoryRecords` (`src/lib/ingestion/batch-insert.ts`) — P2002 di-skip + dihitung + di-log; error lain di-rethrow supaya transaksi rollback (dipakai di 4 titik: process-ingestion ×2, process-rows-for-import ×2, plus route pic/import — kelas bug sama).
  - **BUG-5**: `pg_advisory_xact_lock(hashtext(monthKey))` sebagai statement PERTAMA di dalam semua 3 transaksi import (process-ingestion + 2 mode ingest-process) — serialisasi lintas-instance, auto-release saat COMMIT/ROLLBACK; query `existingPeriodFiles`/`existingWeek` dipindah ke DALAM transaksi setelah lock (hapus stale-snapshot) + re-check `fileHash` dalam transaksi untuk menang import file sama yang berbarengan (hasil: SKIPPED, bukan double-import).

**Belum (butuh aksi manual user):**
- P0: **rotasi password Supabase** (3 project: `fmnfutshaqycabuxzizq`, `vefkgapveggbmkloaslw`, `proosjqivxadwgftofry`) + **revoke PAT GitHub**. Rotasi password tetap WAJIB: purge tidak bisa menarik kembali apa yang sudah ter-clone/cache (GitHub menyimpan objek tak-terjangkau untuk sementara; clone/fork/PR lama masih memuatnya).

**Purge git history — SELESAI (2026-09-09):**
- git-filter-repo `--replace-text` atas seluruh 494 commit: 3 password Supabase (`R3Sef79DEk0AiZiZ`, `mLQROZchGEigkHmK`, `eMPn5DL91pc15nHv`) + PAT GitHub di-replace dengan marker `***REDACTED-***`. Verifikasi: 0 kemunculan di seluruh history baru.
- File terkontaminasi di history lama: `MASTER_CONTEXT.md` (103 commit), `scripts/audit/audit-migration.ts` (85), `worklog.md` (275 — password project tertua). HEAD sebelum purge sudah bersih → isi file terbaru tidak berubah.
- Force-push `main` (`d938dac...137ea9e`). Semua commit SHA setelah titik kontaminasi pertama berubah — clone lama di mesin lain harus **re-clone** (atau `git fetch && git reset --hard origin/main`).
- `scripts/audit/audit-migration.ts` kini baca kredensial dari env (`DATABASE_URL` / `OLD_DATABASE_URL` — AUDIT-SEC-ENV).

**Follow-up terimplementasi:**
- N+1 kecil `pareto/nested.ts` (10 tx) — FIXED: Step 2 kedua fungsi (`queryParetoNestedItemOutlet` + `queryParetoNested`) sekarang 1 query CTE `ROW_NUMBER() OVER (PARTITION BY parent) rn<=20` (pola sama dengan fix PERF-2), menggantikan 10 transaksi `withStatementTimeout` paralel. Bonus konsistensi: filter parent kini pakai ekspresi group yang SAMA dengan Step 1 (`pic` 'Unassigned' tidak lagi mismatch vs total parent).
- **Perf & correctness upload/hapus (PERF-UPLOAD-1..4, PERF-IMPORT-1/2, PERF-DELETE-1..3)** — lihat seksi "UPLOAD & DELETE" di atas. Ringkas: bucket rate-limit chunk khusus 120/mnt (akhir 429 di chunk #6 untuk file >20MB), verifikasi total-ukuran via `SUM(LENGTH(data))` (tidak re-download 50MB), upload chunk paralel ×3 (chunk terakhir tetap terakhir), reuse `/tmp` antara detect→import (1 download+parse hilang), resolusi master-data bulk (±442 → ±4 query), `BATCH_SIZE` 1000, `maxDuration` /api/data & /api/ingest 300s, reset-semua via TRUNCATE atomik, advisory lock pada delete bulan/file. Verifikasi: `tsc --noEmit` 0 error, eslint 0 error, vitest 438/438.
- **Interaksi frontend "lemot saat dipakai" (PAKET A — FE-INTERACT-1/2/3)** — lihat seksi "PAKET A" di atas. Ringkas: tab keep-alive via `forceMount` + `data-[state=inactive]:hidden` (pindah tab tidak lagi rebuild seluruh subtree & state lokal bertahan), `staleTime` 5 mnt + `gcTime` 10 mnt pada 4 query peer/outlet (refetch storm tiap balik tab >30 dtk hilang), debounce 300ms autocomplete item-search (was 1 request per huruf), hapus drill `isFetching` + `FetchAware` (dashboard tidak lagi "terkunci" `pointer-events-none` saat refresh background; indikator refresh kini tunggal di header), hapus animasi tab CSS ganda (0.25s+0.3s berlapis). Verifikasi: `tsc --noEmit` 0 error, eslint 0 error, vitest 438/438.
- **Backend scan-merge & jalur import (PAKET B — PERF-DB-SCAN-1/2/3, PERF-IMPORT-3PASS, PERF-FETCH-4, PERF-TXMEM-5)** — lihat seksi "PAKET B" di atas. Ringkas: 4 KPI single-row → 1 scan `queryDashboardKpis` (analysis + export), 4 (atau 8 di export) query kategori top-items → 1 scan `queryTopItemsByAllCategories` dengan `ROW_NUMBER`+`FILTER` (presisi semantik per kategori), growthDrivers 4→2 transaksi (3 metrik item-grain merge), jalur `/api/ingest`+`import-drive` di-port ke 3-pass bulk master-data (±446 → ±4-8 RT), `resolveComparePeriod` menerima data pre-loaded (2 RT + 1 barrier serial hilang per request), `work_mem` 64→32MB. Keputusan disengaja: batching penuh `withStatementTimeout` DITOLAK (analisis wall-clock di seksi PAKET B — akan menyerialkan query paralel). Verifikasi: `tsc --noEmit` 0 error, eslint 0 error (warning pre-existing), vitest 438/438.
- **Deploy Vercel (PAKET C — DEPLOY-1/2/3/4)** — lihat seksi "PAKET C" di atas. Ringkas: blok `functions` vercel.json yang no-op (key path tanpa `/route.ts` → tidak pernah match function) dihapus — `maxDuration` kini single-source-of-truth di route export 31 route (10–300s) yang memang bekerja native; `"fluid": true` top-level mengangkat plafon duration (Hobby 60s → 300s) sehingga analysis 120s & import/reset 300s benar-benar berlaku di produksi — **verifikasi pasca-deploy di dashboard Vercel (Settings → Functions → Fluid ON)**; `/api/pic/import` diberi `maxDuration = 60` (transaksi bulk ±333 update vs default 10s); `package-lock.json` stale (memuat 10+ dependency radix yang sudah dihapus — `npm ci` = graph dependency lama) dihapus, bun.lock (sinkron, dipakai Vercel & Railway) kini satu-satunya sumber. Verifikasi: schema resmi + sinkronisasi bun.lock offline (50/50 dep, 0 missing/extra), `tsc --noEmit` 0 error, eslint 0 error, vitest 438/438.
- **Fitur analisa "Kepatuhan" (PAKET E — FEAT-COMPLIANCE-1..11)** — lihat seksi "PAKET E" di atas. Ringkas: tab ke-6 dengan 6 lensa kontrol + 5 lensa turunan/pendamping — kepatuhan toleransi per item (paritas penuh rule engine via RuntimeThresholds bersama), prioritas penetapan toleransi (item tanpa toleransi berdeviasi besar), deviasi tak terjelaskan (residual) per outlet dengan klasifikasi WARN/HIGH, |deviasi|/penjualan per outlet, split BAHAN vs PACKAGING, indikasi transfer antar outlet (item×area loss↔surplus serentak + outlet terbesar per sisi + "nilai cocok"), **ketidakcocokan antar-area** (item loss di area A ↔ surplus di area B — pairing di lapisan shaping dari baris `transfer_agg` yang sama, nol scan/round-trip tambahan), **kronis vs sekali-timu per outlet** (lensa level bulan via route `/api/chronic-outlets` terpisah — KRONIS = deviasi ≥75% minggu, SPIKE = minggu terburuk ≥60% |dev| bulanan; FE query kedua keyed month-only sehingga ganti minggu tidak refetch), **kualitas input angka bulat** (share |qtyDeviasi| berakhir 0/5 per outlet vs baseline periode — indikator menaksir vs menghitung; 3 kolom FILTER di scan yang sama), **momentum outlet** (tren |deviasi| paruh kedua vs pertama — memburuk/membaik/stabil, lensa 'week' di query chronic yang sama), dan **drilldown baris item** (4 tabel item-grain klik → modal ItemDeepDive reuse, a11y paritas TopItems). Route `/api/compliance` + `/api/chronic-outlets` (cache 5 mnt, rate-limit 30/mnt, maxDuration 60); FE keep-alive + staleTime 5 mnt + invalidasi refresh `['compliance']` + `['chronic-outlets']`. Verifikasi: `tsc --noEmit` 0 error, eslint 0 error (0 warning baru), vitest 438/438.
- **P3 hygiene (PAKET F — P3-HYG-1..7)** — lihat seksi "PAKET F" di atas. Ringkas: cache hit analysis kini **zero-parse/zero-stringify** (raw JSON string dari DB + inject flag via string surgery — hilangkan double-serialize ~1MB per hit); **index `[direction]` dead dihapus dari schema** (nol query mem-filter — berlaku pada `db:push` berikutnya, ikuti catatan `db:recreate-covering-indexes`); **3 route peer-comparison kini di-cache** (`withCacheAndDedup` 5 mnt + terdaftar di invalidasi — CROSS JOIN multi-CTE tidak lagi jalan per request); **cache docx number[]→base64** (row 4×→1.33× biner + decode cepat, consumer route ikut disesuaikan); **TrendChart mati dihapus** dari bundle; **keydown querySelector** hanya jalan di cabang digit-tab; **3 render-pipeline di-memo** (BarList data, GapAnalysisCard group-by pipeline, RankingNasional filter). Verifikasi: `tsc --noEmit` 0 error, eslint 11 file 0 error (0 warning baru — stash-compare), vitest 438/438.
- **UI/UX review + fix prioritas tinggi (H-14)** — lihat seksi "H-14" di atas. Ringkas: (T1) dialog upload/drive dipindah ke host level-page — CTA EmptyState hidup kembali saat DB kosong (dulu dead click karena FilterBar tidak ter-mount); (T2) kegagalan `/api/status` kini menampilkan ErrorState + retry yang bekerja (dulu loading palsu permanen); (T3) daftar invalidasi 18 key diekstrak ke `src/lib/query-invalidation.ts` dan dipanggil semua 8 situs mutasi — 12 key (pareto/heatmap/trend/flip/rank/search/drilldown/price-effect/item-anomali) tidak lagi basi setelah upload/delete/reset/ingest/settings/pic. Verifikasi: `tsc --noEmit` 0 error, eslint 0 error/299 warning (identik baseline), vitest 446/446, `next build` sukses.

**Eksekusi script DB (2026-09-09, terhadap DB produksi):**
- `db:fix-duplicate-weeks` — dijalankan: **0 duplikat** (data bersih). Script sempat crash saat eksekusi nyata (`having: {_count:...}` ditolak validasi runtime Prisma 6.11) → diganti deteksi `$queryRaw` (SCRIPT-RUNTIME-1).
- `db:fix-null-akun-duplicates` — dijalankan: **0 duplikat / 0 normalisasi**; query deteksi GROUP BY+COALESCE asli kena error PG 42803 → diganti GROUP BY kolom biasa (SCRIPT-RUNTIME-2, semantik identik karena Step 0 sudah menormalkan `''`→NULL; di GROUP BY NULL memang setara). **Index unik `InventoryRecord_nullsafe_akun` BERHASIL DIBUAT** (penjaga BUG-3 level DB aktif).
- Constraint `Week(monthKey, weekLabel)` — **DITERAPKAN** via `CREATE UNIQUE INDEX "Week_monthKey_weekLabel_key"` (nama + definisi identik dengan output Prisma; diterapkan surgikal, 20 baris, instan).
- **`db:push` TIDAK dijalankan langsung** — preview `prisma migrate diff` menunjukkan collateral: `DROP TABLE "AuditLog"` (model hilang dari schema saat force-push dulu; tabel produksi masih ada, 402 baris, MASIH DITULIS deployment aktif) + DROP 3 index covering INCLUDE (perf index-only scan 8s→1.6s) yang tak bisa dimodelkan Prisma. Mitigasi: (a) `model AuditLog` direstorasi ke schema (push berikutnya aman untuk tabel itu), (b) script `db:recreate-covering-indexes` baru (idempoten) untuk memulihkan INCLUDE indexes setelah push di masa depan, (c) unique Week diterapkan surgikal di atas.
- ⚠️ Catatan operasional: SETELAH `db:push`/`db:migrate` apa pun di masa depan, selalu jalankan `bun run db:recreate-covering-indexes` (lihat komentar AUDIT-DB-PUSH-2 di schema.prisma).

---
*Audit dilakukan read-only — tidak ada file repo yang dimodifikasi.*
