# BUG-2-b — full-stack-developer (API/cache fixes)

Task: Eksekusi fix API/CACHE/VALIDATION hasil bug-hunt BUG-1 (fokus temuan BUG-1-c) di repo /home/z/audit-inventory — 8 fix terverifikasi Main: [1] sentinel collision buildCacheKey, [2] SWR/in-flight write-back race, [3] peer-comparison kelompok normalization, [4] error leak items/trend, [5] period-resolver Case 2 same-month cross-week + FilterBar, [6] price-effect noMatch, [7] pic/import max csvContent, [8] drilldown zod area/kelompok/pic.

## Files changed (all in scope, marker `// FIX (BUG-2-b): ...)`)

1. `src/lib/aggregation-cache.ts` — [1]+[2]
   - buildCacheKey: marker 'ALL'/'NONE' → `'\u0000ALL'`/`'\u0000NONE'` (NUL prefix, mustahil dari input user — filosofi sama dengan SEP \x1f). Semua posisi marker diseragamkan (month/week/compareWeek/compareMonth + 5 slot filter).
   - KEPUTUSAN DESAIN (deviasi disengaja dari bullet "normalisasi case-insensitive" di task): pengecekan `'all'` di buildCacheKey TETAP case-sensitive, persis mencerminkan query layer (build-where.ts / shared.ts hanya drop 'all' lowercase). Alasan: (a) test assertion yang dimandatkan task (`buildCacheKey({area:'ALL'}) !== buildCacheKey({area:undefined})`) menuntut literal 'ALL' TIDAK menyatu dengan key no-filter; (b) normalisasi case-insensitive DI DALAM buildCacheKey tanpa normalisasi query layer (file query di luar scope saya) justru membuat poisoning deterministik — `?area=ALL` akan di-key sebagai no-filter tapi query tetap filter 'ALL' → 0 rows → payload kosong di-cache di key no-filter. Dengan NUL sentinel, varian case ('ALL'/'All') menjadi nilai filter literal → key sendiri → entry kosong private, default view AMAN. Normalisasi case-insensitive diterapkan di ROUTE yang saya scope-kan (peer-comparison kelompokParam per resep fix [3]; drilldown area/kelompok normalizeAll).
   - Generation counter `cacheGeneration` (module-level, di-bump invalidateCache + invalidateAnalysisCache sebelum await) + export `getCacheGeneration()`.
   - withCacheAndDedup: (a) miss path — capture gen sebelum computeFn, skip setCached jika gen berubah, data tetap di-return; (b) SWR background IIFE — capture gen sebelum computeFn, skip setCached jika berubah, TAPI resolveComputation tetap dipanggil (promise in-flight tidak boleh menggantung awaiter); (c) awaiter in-flight — capture gen sebelum `await inflight`, jika berubah → tidak return hasil basi, join in-flight baru bila ada, else jatuh ke compute fresh (re-enter); (d) setInflight cleanup di-guard `get(key) === promise` supaya promise lama yang settle tidak menghapus registrasi baru.
   - Komentar self-healing: ganti marker mengubah SEMUA cache key → row lama miss sekali + ter-age-out cleanup (disengaja, tanpa migrasi).
2. `src/app/api/analysis/services/background-recompute.ts` — [2]: capture `getCacheGeneration()` sebelum pipeline fetchRecords→runQueries→postProcess→assembleResponse; sebelum `setCachedRaw`, jika gen berubah → skip write + logger.info.
3. `src/app/api/peer-comparison/route.ts` — [3]: `kelompokParam = kelompok && kelompok.toLowerCase() !== 'all' ? kelompok : null` dipakai untuk cache key DAN queryPeerComparison.
4. `src/app/api/peer-comparison/items/route.ts` — [3]+[4]: kelompokParam (key + computePeerComparisonItems) + errorResponse(e, 'peer-comparison-items').
5. `src/app/api/peer-comparison/trend/route.ts` — [3]+[4]: kelompokParam (key + queryPeerComparison auto-peer path) + errorResponse(e, 'peer-comparison-trend').
6. `src/lib/period-resolver.ts` — [5]: Case 2 — `compareMonthExplicit === month && compareWeek !== week` → `{ prevWeek: null, prevMonth: null }` (konsisten konvensi nulls jalur auto/AUDIT-BUG-2).
7. `src/components/filters/FilterBar.tsx` — [5]: allComparePeriods exclude SEMUA periode bulan berjalan (`if (m.label === monthLabel) continue;` — mencakup periode eksak lama + cross-week same-month). Dropdown compare hanya menawarkan minggu bulan LAIN; opsi lain (auto, dll) utuh.
8. `src/app/api/price-effect/route.ts` — [6]: jalur noMatch early-return `{ summary: emptySummary, items: [] }` — hasCompare = Boolean(compareWeek && resolvedCompareMonth) sesuai param user, semua agregat 0, currTotalNominal/prevTotalNominal 0; tidak ada lagi full-scan tanpa filter yang hasilnya dibuang. emptySummary meniru bentuk emptySummary di price-effect.ts (file itu milik BUG-2-c, TIDAK saya edit) + field aditif `anomalyNominal: 0` (konkuren BUG-2-c menambah field itu — saya sinkronkan via tsc).
9. `src/app/api/pic/import/route.ts` — [7]: `csvContent: z.string().min(1).max(100_000)`.
10. `src/lib/validation.ts` — [8]: drilldownQuerySchema + area (areaSchema ≤50) / kelompok (kelompokSchema ≤50) / pic (picSchema ≤100) — memakai schema shared yang sudah jadi batas wajar repo (lebih ketat daripada 200 char yang disarankan task, konsisten dgn route lain).
11. `src/app/api/drilldown/route.ts` — [8]: area/kelompok/pic dibaca dari `validation.data` (bukan searchParams mentah) + `normalizeAll` (trim+toLowerCase !== 'all' → null) untuk area/kelompok SEBELUM key DAN query (menutup vektor poisoning sisa `?kelompok=all` di route ini — kelas BUG-1-c #3); pic tetap raw (free text, bukan marker 'all').

## Tests

- BARU `tests/lib/aggregation-cache.test.ts` (11 test): sentinel collision (area/kelompok/outlet/item/pic 'ALL' vs undefined ≠; lowercase 'all' masih == no-filter; 'JAKARTA' unik; kelompok case-fold; sentinel NONE tak bisa dipalsukan) + race (miss path skip write-back pasca-invalidate; SWR background tidak menulis data pra-mutasi; awaiter in-flight menolak hasil pra-invali + recompute + tidak hang; jalur normal tetap nge-cache; generation naik sinkron). Mock '@/lib/db' + '@/lib/logger' pola vi.hoisted (ikuti period-resolver.test.ts); deferred via Promise.withResolvers.
- EXTEND `tests/lib/period-resolver.test.ts` (+2 test): Case 2 same-month cross-week → nulls (kedua arah W4→W1 dan W1→W4).
- EXTEND `src/lib/validation.test.ts` (+4 test): drilldownSchema menerima area/kelompok/pic valid; tolak kelompok 1000-char; tolak area >50 / pic >100.

## Self-check (run 2025-final)

- `bunx tsc --noEmit` → 0 error.
- `bunx eslint <semua file yang diubah>` → 0 error; hanya warning pre-existing (db/buildSqlFilters unused, any×3 FilterBar, non-null assertion + type-param v/e di aggregation-cache — semua sudah ada di baseline stash-check; file test baru 0 warning).
- `bun run test` → 473/473 hijau (baseline 455 + 17 test baru saya; +1 test lain milik agen konkuren BUG-2-a/c).
- `rg -n "'ALL'" src/lib/aggregation-cache.ts` → hanya di komentar dokumentasi; marker aktual `'\u0000ALL'`/`'\u0000NONE'`.
- dev.log: `/` compile + 200 OK, tidak ada error runtime baru (EADDRINUSE berasal dari duplikat start dev server, bukan kode).

## Out-of-scope yang TIDAK disentuh (flag untuk Main)

- CACHE_ANALYSIS s-maxage CDN (BUG-1-c #6) — keputusan deployment.
- Schema week longgar 'WEEK 99' (BUG-1-c #8) — dilarang diubah.
- analysis 404-in-flight → 200 (BUG-1-c #13) — validate-and-resolve.ts di luar scope.
- recommendations earlyCacheKey dari month/week mentah (BUG-1-c #7) — recommendations/route.ts sedang diedit agen lain (BUG-2-a).
- outlet-items `resolveOutletAndPeriod` punya COPY inline logika Case 2 (resolve-period.ts:74-75 `let prevMonth = compareMonth || null` TANPA guard same-month cross-week) — file itu di luar scope saya; fix period-resolver TIDAK menjangkau jalur outlet-items. Perlu follow-up Main (1 blok kecil).
- Normalisasi 'all' varian case di route analysis/export (validate-and-resolve membaca mentah) — mitigasi NUL sentinel sudah menutup poisoning (varian case dapat key literal sendiri), tapi `?area=all` lowercase di analysis sudah aman karena build-where.ts drop 'all' untuk query.
