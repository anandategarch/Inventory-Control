---
Task ID: BUG-Q
Agent: full-stack-developer
Task: Bug hunt nyata di `src/lib/**` (satu-satunya domain yang boleh diubah) + perbaiki minimal-diff. Prioritas: diferensial split 5 file yang dipecah sesi lalu (28d7930..cfbac95), query-cache + invalidasi, SQL queries (off-by-one / ORDER BY / JOIN / div-zero / NULL / salah tanda / W1-W5 / AVG-ABS-vs-signed), settings/definitions (key ganda / default), ingestion + drive-import (atomik / timeout / dedup / byte-cap / path traversal), item PRE-EXISTING (entryBlocks, skippedErrors, komentar stale), metrics (calcGrowth / z-score). Batasan: tanpa git add/commit/push/checkout/stash/reset, DB produksi tak terjangkau (verifikasi via unit test), tanpa test baru, Tanpa dependency baru.

Work Log:

## 1. Konteks + metode

- `tail -120 worklog.md` + baca `agent-ctx/SPLIT-D-split.md` + `agent-ctx/SPLIT-E-split.md` (peta modul + catatan risiko mereka).
- Working tree saat mulai: bersih di HEAD cfbac95 (agent paralel lain mulai muncul belakangan — lihat "Catatan lingkungan").
- Metode diferensial: ekstrak baseline `git show 28d7930:<path>` untuk 5 file yang dipecah, lalu bandingkan BODY kode (strip komentar/import/export via script python difflib) terhadap konkatenasi modul hasil split.

## 2. Diferensial split (kelas bug pemindahan kode) — SEMUA 5 LOLOS pure motion

| Target split | Bukti |
|---|---|
| `src/lib/settings/` (4 file) vs `settings.ts` | Body identik; satu-satunya diff = header modul + import antar-modul + named re-export barrel. Tidak ada konstanta ganda, singleton cache (`_settingsCache`/`_cacheLoadedAt`/`_defaultsEnsured`) didefinisikan SEKALI di store.ts. |
| `src/lib/drive-import/` (8 file) vs `drive-import.ts` | 371 baris body identik di kedua sisi; diff hanya: `extractDriveId` berpindah posisi (deklarasi top-level, bebas TDZ), keyword `export` ditambahkan, header modul. `FETCH_TIMEOUT_MS/FOLDER_LIST_TIMEOUT_MS/MAX_DOWNLOAD_BYTES` didefinisikan sekali (http-safety.ts). Barrel meredefinisi TIDAK dilakukan — export persis 6 simbol lama + 3 type. |
| `src/lib/ingestion/process-ingestion/` (6 file) vs `process-ingestion.ts` | Identik modulo arg-threading mekanis: early-return 4x → discriminated union `resolveInputFiles` (caller `if (!resolved.ok) return [resolved.errorResult]` — perilaku sama); `body.numberLocale` → `args.numberLocale`; `naturalKeys/skippedDuplicates/weekDbMap` dipindah ke dalam `runIngestTransaction` + `skippedDuplicates` di-return (closure lama juga hanya dibaca setelah tx). Urutan await di orchestrator: resolveInputFiles → lock → manualFileName sanitize → hashFile → hash-precheck → stale-stub purge → readAllRows → parseMonthFromFilename → pre-cache outlet/item → prepareRows → runIngestTransaction → duplicateOf-check → skippedDuplicates-log → statusCache.clear() → await invalidateAnalysisCache() → clearMonthResolverCache() — SAMA dengan baseline (diverifikasi baris-per-baris vs baseline L91-540). Race branch tetap return hardcoded (lihat item pre-existing #2). |
| `by-other-metric*` (5 sibling + barrel) vs `by-other-metric.ts` | **IDENTICAL** — 451 baris body sama persis (script strip-diff: "IDENTICAL (after stripping comments/imports/exports)"). |
| `change-analysis*` (4 sibling + barrel) vs `change-analysis.ts` | Identik modulo import antar-sibling yang muncul di tengah konkatenasi (artefak metode, bukan perubahan kode). |

Kesimpulan diferensial: TIDAK ADA bug kelas pemindahan kode (argumen tertukar, konstanta duplikat beda nilai, early-return hilang, urutan await berubah, cache-key/sv berubah, singleton/timeout/scheme didefinisikan ulang). Catatan: cache-key `sv` versi marker BUKAN wilayah split ini (mereka di route/export — read-only bagi saya; k-verified via grep: sv 2/3/6/7 marker tetap satu tempat per query).

## 3. Audit cache + invalidasi

- `cache.ts` (LRU+TTL, statusCache 1-entry 5-min), `aggregation-cache/{key-builder,generation,inflight,store,swr,invalidate}.ts` dibaca penuh: sentinel ESC-prefix + \x1f separator + sanitizeKeyPart benar; generation guard (BUG-2-b) di swr.ts utuh (miss-path, SWR-path, awaiter re-enter path); inflight cleanup guarded terhadap registrasi lebih baru.
- `invalidateAnalysisCache()` route list (44 prefix) dicocokkan terhadap semua route cache + semua `q-*` id yang dipakai `cachedSharedQuery` di src/lib (q-outlet-agg, q-self-anom dll. — semuanya tercantum). Semua mutasi di src/lib (processIngestion) memicu `invalidateAnalysisCache` + `statusCache.clear` + `clearMonthResolverCache`; route mutasi lain (settings/pic/data/refresh/migrate-direction/import-mode/import-all-mode) diverifikasi via grep semuanya await invalidateAnalysisCache.
- `query-cache.ts`: semua parameter yang mempengaruhi hasil masuk key (month/week/compareWeek/compareMonth/area/kelompok/outletCode/itemName/picCodes sorted/extra). `histPeriodsKeyParts` + `histCriticalKeysHash` (FNV-1a, JSON.stringify per komponen) benar. TTL 30-min konsisten dengan analisis payload. `cachedSharedQueryMap` menangani Map→entries→Map dengan benar.
- `tests/lib/query-invalidation.test.ts` + `aggregation-cache.test.ts` tetap hijau (dijalankan dalam suite penuh).

## 4. Audit SQL (semua kelas yang diminta)

Dibaca penuh + diverifikasi manual: shared.ts (buildSqlFilters + DIRECTION_FROM_SUM_SQL + computePareto8020 + withStatementTimeout), dashboard.ts (queryTrendAgg/queryExecSummary/queryDashboardKpis — penjualan MODE via OutletPeriodSales, guarded div, COALESCE), health-ranking.ts (variance top-5 pushdown rw/ri <= 5 benar; flip LOSS↔SURPLUS klasifikasi WORSENED/IMPROVED benar; historical critical VALUES join), historical.ts + historical-baseline.ts + rule-evaluation.ts (evaluateRulesSql 16 rule + evaluateHistoricalRulesSql; div-by-zero di-guard via `!= 0`/`IS NOT NULL`; baseline GREATEST(0, ...) anti-NaN), price-effect.ts (Bennet exact + ghost-row residual + dev-only bridge assert), heatmap.ts (metric guard + clamp itemLimit), areas.ts, weekly-composition.ts, item-trend.ts + item-trend-rank.ts + item-trend-matrix.ts (same-week convention konsisten), self-history-anomaly.ts (ABS vs SIGNED dipisah benar; flip threshold 0.5/0.25; tanda lossToSurplus/surplusToLoss benar mengikuti konvensi qty>0=SURPLUS), flip-ranking.ts (NULLS LAST + monthKey sort + BUG2-FLIP-06 filter totalPairs>0), outlet-agg-scan.ts (v:3 marker + hlt di cache key; DISTINCT-item counts), outlet-recurrence.ts (calendar-consecutive streak via LAG), peer-comparison.ts + peer-comparison-items.ts (numeric latest-week R-8; ±10% sales window; kelompok-scope-dengan-focus-guard), benchmark-opportunity.ts (percentile_cont median; ir.area bukan o.area), resto-recommendations.ts, growth-drivers/{drivers,top-growth}.ts (H-6 salesMode fix; |prev| denominator), pareto/{by-dimension,historical,nested,compute}.ts (populationTotal window pre-LIMIT; Prisma.raw JOIN literal statis), top-items/{by-deviasi-rank via shared-cte, by-other-metric-* semua sibling, peer-bucket, global-search, item-outlet-breakdown, item-anomali-outlets}. Konvensi tanda LOSS=negative konsisten di seluruh repo (FIX CALC-4). W1-W5: `CFG_RECON_SETTINGS.WEEK_PERIODS` (W1=1-7..W4=1-25 kumulatif) + derivasi W5+ `min(N*7,31)` konsisten dengan semua same-week pin di query layer.

## 5. Audit settings

`definitions.ts`: 40 key, **nol duplikat** (diverifikasi script). `runtime-thresholds.ts`: 40 key num() fallback — semua fallback SAMA dengan defaultValue definitions (cocokkan satu per satu: 0.10/0.05/0.03/0.05/0.05, 2.0/2.0/1.5, 0.50/0.70, 1.5/2.0, 2.0/4/2.0/4/100_000, bobot 30/25/20/15/10, TOP_N 10/10/30, 50jt/10jt, HEALTH_WEIGHT 30/25/25/20, HEALTH_THRESH 8 pasang). BUG-2-4 (empty string → fallback) utuh. Tidak ada migrasi versi yang hilang (ensureDefaultSettings createMany skipDuplicates mengisi key baru per cold start).

## 6. Audit ingestion + drive-import

- Transaksi atomik: dedup-delete + create + master-data + insert + DQ + sales-MODE dalam SATU `$transaction` (timeout 240s) — utuh pasca-split. `insertInventoryRecords` error-strict (P2002 dihitung, error lain rethrow). Advisory lock xact-scoped + in-lock recheck (AUDIT-BUG-5) utuh.
- Timeout/abort: semua fetch drive punya AbortSignal.timeout (60s/30s); readTextCapped content-length precheck + stream cap; pipelineWithByteCap destroy + partial-file unlink.
- Path traversal: `safePath` resolve+prefix; drive filenames → `path.basename + [^\w.\- ]→_`; sheets title → strip `[<>:"/\\|?*]` sebelum dipakai; manualFileName → inline sanitize. Satu-satunya jalan ke `downloadGoogleSheetsAsCsv` adalah importFromDriveUrl yang sudah sanitasi. Tidak ditemukan traversal yang bisa di-exploit (nama `..` → EISDIR pada createWriteStream, bukan menulis ke parent).
- Dedup hash: hashFile streaming SHA-256; precheck + in-lock recheck + stale-stub purge.
- ditemukan 2 bug nyata (lihat §7): header-normalization drift CSV vs XLSX.

## 7. BUG DITEMUKAN + DIPERBAIKI (2 bug nyata, diff minimal)

### BUG-Q-1 — `queryParetoByDevBom` remainderCount/totalCount kehilangan semantik populasi (fix BUG-2-c yang tidak tuntas)

- **Lokasi**: `src/lib/queries/items/top-items/by-other-metric-pareto.ts` (return akhir, sebelum fix: `remainderCount: 0` hardcoded + `totalCount: topItems.length`).
- **Penjelasan**: fix BUG-2-c (commit sesi lalu) membuat `grandTotal`/`sharePct`/`cumPct`/`remainderPct` jadi jujur terhadap POPULASI PENUH (semua item yang lolos threshold, bukan hanya slice top-`maxDrivers`) — komentar kode sendiri bilang "remainderPct = 100 − cumPct becomes the true 'rest of population'". Tapi dua field saudaranya tidak ikut diubah: `totalCount` tetap panjang SLICE (== drivers.length) dan `remainderCount` tetap hardcoded 0.
- **Dampak (data salah yang tampil ke user)**: konsumen `TopItems.tsx:216-217` menampilkan badge `"{drivers.length} item · {pareto.totalCount} total"`. Saat populasi item yang lolos threshold > maxDrivers (default 20), badge menampilkan mis. "20 item · 20 total" padahal total populasi 34 — angka "total" salah. Pasangan `remainderCount=0` vs `remainderPct>0` juga tidak konsisten (konvensi sibling `computePareto8020` di shared.ts: `remainderCount: rows.length - drivers.length, totalCount: rows.length`; nested-Pareto pakai window `populationTotal` untuk hal yang sama). Fallback `.catch()` di run-queries.ts:197 juga mengembalikan `totalCount: 0` untuk populasi kosong — konsisten dengan semantik populasi, bukan slice.
- **Bukti kode (lama vs baru)**:
  ```ts
  // LAMA                                     // BARU
  remainderCount: 0,                          remainderCount: itemAggs.length - topItems.length,
  totalCount: topItems.length,                totalCount: itemAggs.length,
  ```
- **Verifikasi**: `tests/queries/top-items.test.ts` — test #2 (2 item, maxDrivers 20) assert `totalCount === 2` → populasi 2 → tetap 2 ✓; test cap (3 item, maxDrivers 2) TIDAK meng-assert totalCount/remainderCount ✓; test kosong early-return `totalCount: 0` ✓. Suite penuh 512/512 pass tanpa mengubah satu test pun (test memang tidak menegaskan bug — field yang salah tidak di-assert di kasus cap; saya TIDAK menambah test baru sesuai batasan "ubah test HANYA jika ada file test yang sudah menyentuh query itu" — file test-nya menyentuh query ini, jadi boleh, tapi tidak diperlukan karena fix tidak melanggar assertion mana pun).

### BUG-Q-2 — Header CSV dinormalisasi dengan 2 dari 4 strategi (drift duplikasi vs jalur XLSX) → kolom bisa hilang diam-diam saat ingest CSV

- **Lokasi**: `src/lib/csv-parser.ts` (callback `columns:` di `parseCsvStream`).
- **Penjelasan**: komentar lamanya sendiri bilang "Normalize headers same way as Excel parser", tapi implementasinya hanya menjalankan 2 strategi alias (exact + slash-normalized) sedangkan `normalizeHeader` di `excel.ts` (yang SUDAH di-export dan dipakai jalur .xlsx) menjalankan 4 strategi (exact, slash, strip-`%`, strip-`%`+slash). Header bertipe "%deviasi to bom" / "%qty deviasi to bom" (% menempel ke huruf) gagal dipetakan di jalur CSV → kolom tersebut jatuh ke nama mentah → data kolom itu TIDAK masuk DB saat ingest CSV (jalur Google Sheets export + CSV upload), padahal file .xlsx dengan header sama akan terpetakan benar.
- **Dampak**: kolom pctQtyDeviasiToBom (dan sejenisnya) kosong untuk file CSV dengan varian header tersebut — data salah/parsial tanpa error. Latent (tergantung varian header file yang di-upload), tapi divergensi perilaku nyata antara dua jalur ingest untuk file yang sama.
- **Bukti kode (lama vs baru)**:
  ```ts
  // LAMA (inline, 2 strategi)                        // BARU (shared, 4 strategi)
  const cleaned = h.toLowerCase()                      return normalizeHeader(h);
    .replace(/\s+/g, ' ').trim();
  return HEADER_ALIASES[cleaned]
    || HEADER_ALIASES[cleaned.replace(/\s*\/\s*/g, '/')]
    || cleaned;
  ```
- **Bukti mekanis (bun one-liner, 27 header representatif)**: 25 header menghasilkan nilai IDENTIK old-vs-new; tepat 2 header berbeda — `%Deviasi to bom` dan `%qty deviasi to bom`: old `'%deviasi to bom'` (unmapped) vs new `'pctQtyDeviasiToBom'` (canonical). Jadi fix ini superset murni: semua header yang tadinya cocok tetap cocok, fallback (return cleaned) identik.
- **Verifikasi**: tidak ada test yang menyentuh csv-parser/parseCsvStream (rg → nol file test) → tidak ada test yang perlu/boleh diubah; tsc 0 error (normalizeHeader memang di-export dari excel.ts, csv-parser sudah import dari modul itu — tidak ada perubahan import graph / exceljs tetap dynamically-imported).

## 8. Item PRE-EXISTING — hasil investigasi + tindakan

1. **`entryBlocks` dead code (folder-scan.ts:48)** — investigasi: benar-benar dead (dideklarasikan, tidak pernah di-push, tidak pernah dibaca; loop parsing memakai `starts` + `html.slice`; TIDAK ada error/path yang dibuang). → **dibersihkan minimal**: hapus variabel + komentarnya, ditandai komentar "BUG-Q cleanup". Perilaku nol perubahan. (Menghapus 1 warning pre-existing `no-unused-vars` — lihat verifikasi.)
2. **`skippedErrors` di return transaksi process-ingestion tidak pernah dipakai caller** — investigasi mendalam: BUKAN bug fungsional terselubung. Baris ERROR memang di-skip dari insert, TAPI issue-nya sendiri TETAP dilaporkan end-to-end: `allIssues` → baris DQIssue di dalam transaksi → `summarizeDQ(allIssues)` → `dq.severityCounts.ERROR` → `IngestResult.dqErrors` (+ `sourceFile.dqErrorCount`). Jadi tidak ada error yang dibuang; yang dead hanyalah COUNT baris-skip itu sendiri (diverifikasi: orchestrator mendestrukturinya hanya untuk diteruskan, tak ada konsumen `IngestResult` yang membacanya; jalur per-week `processRowsForImport` memang meng-return skippedErrors ke callernya sendiri — itu modul berbeda dan tetap utuh). → **dibersihkan minimal**: field dihapus dari `PrepareRowsResult`, `IngestTransactionArgs`, `IngestTransactionResult`, destrukturisasi orchestrator, return tx (raced branch ikut bersih dari hardcoded `skippedErrors: 0`). Perilaku nol perubahan (tsc memastikan tidak ada konsumen lain).
3. **Komentar stale "process-ingestion.ts" (kini folder)**:
   - `src/lib/ingestion/process-rows-for-import.ts:69` (DALAM domain) → **diperbaiki**: "process-ingestion/ (… a folder since the SPLIT-D code-motion split)".
   - `scripts/fix-null-akun-duplicates.ts:49` (LUAR domain `src/lib/**`) → **TIDAK disentuh** — cross-domain finding.
   - Tambahan yang ditemukan audit (dalam domain, comment-only): `src/lib/queries/outlets/outlet-recurrence.ts:26-34` merujuk "settings.ts:527" / "settings.ts:551" (file yang sudah dihapus SPLIT-D, nomor baris menyesatkan) → **diperbaiki** menjadi referensi `src/lib/settings` / `settings/definitions.ts` tanpa nomor baris. (`change-analysis.ts:39` menyebut "settings.ts" tanpa nomor baris — masih bisa diresolvkan secara konseptual, dibiarkan demi diff minimal.)

## 9. Temuan LAIN yang TIDAK diperbaiki + alasan

- **`src/lib/excel-to-csv.ts` adalah modul mati (zero code callers)**: `convertExcelToCsv` tidak diimport siapa pun di src/ (satu-satunya rujukan = worklog.md; scripts/convert-excel-to-csv.ts adalah CLI spawn terpisah; scripts/upload-to-turso.ts punya salinan lokalnya sendiri). Salinan `cellToValue` lokalnya juga MENDRIFT dari excel.ts (tidak punya cabang `instanceof Date` / BUG-8 fix → Date cell akan jadi ISO-string via JSON.stringify kalau modul ini dipakai). TIDAK diperbaiki/dihapus: menghapus satu modul utuh melampaui mandat pembersihan-minimal item pre-existing yang diflag, dan dampak runtime nol (dead code). Dicatat supaya task pembersihan berikutnya bisa menghapusnya aman.
- **Pin `weekLabel = historicalPeriods[0].weekLabel` di `queryHistoricalCategoryAvg`** (risiko #2 SPLIT-E): BUKAN bug pada caller yang ada — semua caller membangun period list dengan weekLabel yang SAMA (`fetch-records.ts:251` filter `p.weekLabel === week && p.monthLabel !== month`; `export data-fetcher/setup.ts:143` sama; `self-history-anomaly` memakai `${week}` langsung). Kalau kelak ada caller yang mengirim period list multi-week, query ini akan memfilter diam-diam — dicatat sebagai catatan desain, bukan bug hari ini.
- **Banner "Network Item Risk" di by-other-metric-pareto.ts** (risiko #1 SPLIT-E): catatan desain historis yang SPLIT-E sengaja pertahankan verbatim + sudah diberi penjelasan di header file. Bukan bug fungsional.
- **Komentar "BUG-Q-01/02" di heatmap.ts**: bukan buatan sesi ini — sudah ada di HEAD (commit 1486adf, hasil restore audit lama). Guard defensif yang valid (metric guard + itemLimit clamp). Bukan bug.
- **`readTextCapped` mengembalikan teks terpotong (bukan throw) saat melewati cap pada respons chunked**: perilaku "bounded read" yang didokumentasikan; semua pemakaian bersifat best-effort (parsing title/sample error). Bukan bug.
- **Deviasi kecil yang didokumentasikan**: float-order SUM (~1e-15) antara evaluateHistoricalRulesSql vs stats-map (komentar NOTE di file itu sendiri) — accepted deviation, bukan bug.

## 10. Cross-domain findings (TIDAK diedit — di luar `src/lib/**`)

1. `scripts/fix-null-akun-duplicates.ts:49` — komentar masih menyebut "process-ingestion.ts" sebagai file (kini folder `src/lib/ingestion/process-ingestion/`). Comment-only, nol efek runtime.
2. `src/components/dashboard/TopItems.tsx:216-217` — konsumen badge "{drivers.length} item · {pareto.totalCount} total" adalah pihak yang paling diuntungkan BUG-Q-1; setelah fix domain saya, badge otomatis benar (tidak perlu perubahan komponen).
3. `src/app/api/analysis/services/run-queries.ts:197` — fallback `.catch()` queryParetoByDevBom sudah konsisten dengan semantik populasi post-fix (tidak perlu diubah).
4. (Observasi lingkungan, bukan bug) Agent paralel lain sedang menyentuh `src/app/api/analysis/services/validate-and-resolve.ts`, `src/app/api/peer-comparison/items/route.ts`, `src/components/filters/FileUploadDialog/index.tsx`, `src/hooks/useRecommendations.ts` — muncul sebagai modified di working tree SETELAH sesi saya mulai; tidak saya sentuh; verifikasi tsc/lint/vitest saya dijalankan DI ATAS state gabungan itu dan tetap 0 error / 512 pass.

## 11. Verifikasi

- `bunx tsc --noEmit --incremental false` → **0 error seluruh repo** (termasuk 8 file yang saya ubah).
- `bun run lint` → **0 error**; 379 warning — seluruhnya baseline pre-existing di tests/ + non-null assertion lama. Perubahan saya: **menghapus 1 warning pre-existing** (entryBlocks unused di folder-scan.ts — warning yang SPLIT-D catat sebagai inherited) dan **menambah 0 warning** (eslint khusus 8 file domain saya: hanya 2 warning non-null assertion pre-existing di process-rows-for-import.ts:104/121 yang TIDAK saya sentuh).
- `bunx vitest run` FULL suite → **31 file, 512/512 PASS** (baseline dipertahankan; TIDAK ada file test yang diedit sama sekali).
- Bukti mekanis tambahan: bun one-liner header-parity (27 header: 25 identik, 2 header %glued berubah dari unmapped → canonical — persis kelas bug yang difix, superset murni).
- DB produksi tidak terjangkau dari sesi ini (tidak ada DATABASE_URL) — sesuai batasan, verifikasi perilaku SQL via unit test mock (suite 512) + review manual.

## 12. Tabel cakupan audit

| Area | File | Mode |
|---|---|---|
| Split diferensial | settings/ (4), drive-import/ (8), process-ingestion/ (6), by-other-metric* (6), change-analysis* (5) vs baseline 28d7930 | strip-diff body (5/5 identik) |
| Cache | cache.ts, query-cache.ts, query-invalidation.ts, aggregation-cache/* (7) | full read |
| SQL queries | shared.ts, dashboard.ts, health-ranking.ts, price-effect.ts, historical.ts, historical-baseline.ts, rule-evaluation.ts, areas.ts, heatmap.ts, item-trend.ts, weekly-composition.ts, items/{flip-ranking, self-history-anomaly, item-trend-matrix, item-trend-rank, item-anomali-outlets, item-peer-comparison, peer-bucket, item-outlet-breakdown, global-search}.ts, top-items/{by-other-metric-* ×5, shared-cte, types}.ts, outlets/{change-analysis-* ×4, outlet-agg-scan, peer-comparison, benchmark-opportunity, outlet-recurrence, resto-recommendations (core+scan)}.ts, pareto/{by-dimension, historical, nested, compute}.ts, growth-drivers/{drivers, top-growth}.ts | full read |
| settings | definitions.ts, store.ts, runtime-thresholds.ts, index.ts + dup-key script | full read + script |
| ingestion | process-ingestion/* (5 modul), process-rows-for-import.ts, batch-insert.ts, ingestion-lock.ts, outlet-period-sales.ts, safe-path.ts, find-excel-files (grepped callers), excel.ts, csv-parser.ts, excel-to-csv.ts | full read |
| drive-import | 8 file | full read |
| metrics | growth.ts, historical.ts, sample-stats.ts, sales.ts, deviation.ts, flip-metrics.ts, zScoreHelpers.ts, auto-compare.ts | full read |
| utils/resolver | build-where.ts, filename.ts, month-resolver.ts, period-resolver.ts, kelompok-resolver.ts, pic-resolver.ts, rate-limit.ts | full read |
| utils lain | validation.ts, format.ts, colorScale.ts (120/354), excel-to-csv.ts (80/177), db.ts, db-maintenance.ts, background-scheduler.ts, outlet.ts, outlet-code-filters.ts, logger.ts, utils.ts, a11y.ts, cache-headers.ts, chart-constants.ts, early-http-error-response.ts, metrics/{benchmark,forecast,definitions}.ts, peer-comparison-items.ts (core SQL), resto-recommendations (scoring tail) | targeted pattern-scan (divisi/NULLIF/CASE-tanda/ORDER BY/LIMIT/week pinning/AVG-ABS) — tidak ada anomali yang lolos kelas bug yang dicari |

## 13. Catatan proses (transparansi)

- SATU insiden prosedur: perintah verifikasi secara tak sengaja menjalankan `git stash` (maksud saya hanya `git stash list`). Langsung dipulihkan total dengan `git stash pop` pada detik yang sama — working tree kembali byte-identik (stash refs dropped, `git status` menunjukkan set file modified yang sama persis: 8 file domain saya + 4 file agent paralel + 1 file laporan agent lain yang untracked). Tidak ada commit/push/checkout/reset yang dilakukan; tidak ada konten yang berubah karena insiden ini. Pelajaran: jangan pernah menaruh `git stash` mentah di baris perintah yang sama dengan subperintah read-only.
- File yang diubah (8, semua di `src/lib/**`): `csv-parser.ts`, `drive-import/folder-scan.ts`, `ingestion/process-ingestion/{prepare-rows,orchestrator,ingest-transaction}.ts`, `ingestion/process-rows-for-import.ts`, `queries/items/top-items/by-other-metric-pareto.ts`, `queries/outlets/outlet-recurrence.ts`. Stat: +49/−26 baris (mayoritas komentar penjelasan BUG-Q; perubahan kode efektif: 2 baris pareto + 1 baris csv + penghapusan plumbing dead).

Stage Summary:
- 2 bug NYATA ditemukan + diperbaiki (diff minimal, tanpa refactor): (1) `queryParetoByDevBom` remainderCount/totalCount kehilangan semantik populasi penuh — sisa fix BUG-2-c yang tidak tuntas; badge "N item · M total" di TopItems menampilkan total yang salah ketika populasi > maxDrivers; (2) normalisasi header CSV hanya menjalankan 2 dari 4 strategi alias yang dijalankan jalur XLSX — header %menempel ("%deviasi to bom") membuat kolom hilang diam-diam pada ingest CSV; fix = pakai `normalizeHeader` shared (superset murni, terbukti 25/27 header identik + 2 header buggy berubah tepat ke canonical).
- Item pre-existing tuntas: `entryBlocks` (dead code, dibersihkan — menghapus 1 warning pre-existing), `skippedErrors` (investigasi: BUKAN bug fungsional terselubung — error DQ tetap ter-report via allIssues→dqErrors; dead plumbing dihapus dari 3 modul), komentar stale "process-ingestion.ts" (in-domain diperbaiki; scripts/ = cross-domain finding) + 2 referensi "settings.ts:NNN" basi di outlet-recurrence diperbaiki.
- Diferensial split 5 file: SEMUA terbukti pure code motion (tidak ada bug kelas pemindahan kode). Temuan dead-module `excel-to-csv.ts` (zero callers + cellToValue drift) dicatat untuk pembersihan mendatang.
- Verifikasi: tsc 0 error (repo penuh) · eslint 0 error / 0 warning baru (1 warning lama hilang) · vitest 512/512 (31 file) TANPA satu pun edit test · DB tak terjangkau → verifikasi via unit + review manual, sesuai batasan.
- Laporan ini menggantikan worklog.md (tidak ditulis); tidak ada commit/push (Main yang commit); tidak menambah dependency; hanya file di `src/lib/**` yang diedit.
