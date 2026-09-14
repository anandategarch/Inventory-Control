# BUG-3-FIX-A — full-stack-developer (export pipeline)

Repo: /home/z/audit-inventory · Task ID: BUG-3-FIX-A
Konteks: worklog entry BUG-3-a (hunt export backend) + BUG-3 (fix sentinel cache Main — SUDAH selesai, tidak disentuh).

## Task
Perbaiki sisa temuan perf+correctness pipeline /api/export-report dari hunt BUG-3-a: P1 (hapus 5 dead query), P2 (sections-aware fetching), P3 (merge SET LOCAL), P4 (preloaded resolveComparePeriod), P5 (cache prev topcat), C3 (timeout metadata query), C4 (sections= kosong), C5 (sanitize Content-Disposition), C7 (rate-limit export + Retry-After), P6 (update komentar usang).

## Files changed (scope eksklusif dipatuhi)
- src/app/api/export-report/route.ts
- src/app/api/export-report/services/{data-fetcher,docx-builder,types}.ts
- src/lib/queries/shared.ts (hanya withStatementTimeout)
- src/lib/rate-limit.ts
- tests: 3 file (lihat "Test updates" — semua karena perubahan in-scope / leftover Main)

## Work log per fix
- **P1**: hapus q-rules (evaluateRulesSql), q-hist-rules (evaluateHistoricalRulesSql), q-hist-stats (queryHistoricalStatsMultiMetric), q-hist-critical (queryHistoricalCriticalItems), q-area (queryAreaAnalysis) + seluruh plumbing (historicalByOutletItem, allFlags/topFlagByKey, histCriticalKeys, areaAnalysisRaw, field ReportData.areaAnalysis + growthComparison.historicalAnalysis, GrowthMetrics.multiPeriodComparison [juga 0 konsumen], DocxContext.{sqlFlags,thresholds,month,week,prevWeek,prevMonth}). getRuntimeThresholds DIPERTAHANKAN — hanya untuk TOP_N_ITEMS. Header comment data-fetcher (daftar tanggung jawab) ditulis ulang 1-13 akurat. Tradeoff dicatat: export tidak lagi cross-warming 5 q-* itu untuk dashboard (dashboard punya warm-up sendiri di run-queries.ts); arah umum "dashboard → export" tetap di-warm penuh.
- **P2**: `const need = new Set(sections ?? ALL_EXPORT_SECTIONS)` di awal fetchReportData; mapping diverifikasi dari docx-builder: exec/growth/breakdown → q-kpis (+ q-exec-summary prev utk exec/growth), topItems → q-top-nominal + q-top-devbom + q-topcat + prev q-topcat + 4× q-hist-catavg, variance → q-variance, trend → q-trend. 404 short-circuit (COUNT) tetap jalan untuk semua kombinasi dan sekarang jadi WAVE PERTAMA (dulu 5 dead query ikut dibayar sebelum 404 dilempar). Dua wave serial (kpis dulu, lalu batch kategori) digabung jadi SATU Promise.all post-404 (pola H-8 QUICK WIN 2) — hilang 1 barier RTT. Section yang tidak dipilih dapat placeholder nol (null kpis / array kosong) — tidak pernah dirender karena hasSection memakai list yang sama.
- **P3**: withStatementTimeout — dua `SET LOCAL` digabung jadi SATU `$executeRaw\`SELECT set_config('statement_timeout',$1,true), set_config('work_mem','32MB',true)\`` → 5→4 RTT per query berat (~230ms/RTT iad1→sin1). Signature + opsi transaksi (timeout/maxWait) + semantika transaction-scoped persis sama; timeout kini via bind parameter (set_config menerima $1, beda dari SET LOCAL). Sengaja $executeRaw BUKAN $queryRaw agar blast radius test minimal (lihat bawah).
- **P4**: resolveComparePeriod dipanggil dengan `{ weeksRaw, fileMonthKeys }` preloaded (pola analysis/services/fetch-records.ts:152-162) — hemat 2 round-trip.
- **P5**: queryTopItemsByAllCategories(prev…) dibungkus cachedSharedQuery. **Keputusan kunci (deviasi disengahkan dari saran 'q-topcat-prev', dijelaskan di komentar kode)**: pakai queryId 'q-topcat' dengan params period = prevMonth/prevWeek + extra.limit=100, BUKAN 'q-topcat-prev', karena daftar invalidasi invalidateAnalysisCache() (prefix 'q-topcat\x1f', di aggregation-cache/** yang DILARANG disentuh) tidak memuat 'q-topcat-prev' → row itu tidak akan dihapus saat mutasi → stale 30 menit. Dengan 'q-topcat', row prev ikut ter-invalidasi prefix yang sama. Limit TETAP 100 (analisis lookup: prev rows dipakai sebagai lookup map utk top-N current — item peringkat #10 sekarang bisa #11-100 di periode lalu; topNItems akan mengubah nilai riil jadi '—' = regresi correctness). extra.limit=100 menjaga key tetap beda dari row current (limit=topNItems).
- **C3**: db.week.findMany + db.sourceFile.findNow + db.inventoryRecord.count dibungkus withStatementTimeout (default 30s) — tidak bisa hang tanpa batas (PgBouncer strip statement_timeout URL param → dulu bisa gantung sampai 504, salah satu sumber "spinner muter terus").
- **C4**: route.ts `sections = sectionsParam !== null ? sectionsParam.split(',').filter(Boolean) : null` — `?sections=` (kosong) = TIDAK ada section (header-only doc), bukan semua. Verifikasi docx-builder: list kosong → semua hasSection() false → dokumen header+footer saja, tidak crash (semua body di belakang guard; data-fetcher memberi placeholder nol). **Bug turunan yang ketemu & difix**: buildCacheKey MENGHAPUS extra dengan nilai string kosong → `?sections=` akan berbagi cache key dengan "semua section" (cache poisoning) → key extra kini memakai marker '__NONE__' untuk list kosong (unforgeable — validation.ts 400-reject token di luar 6 kunci).
- **C5**: docx-builder fileName + `.replace(/[^A-Za-z0-9._-]/g,'_')`; route.ts Content-Disposition + `filename*=UTF-8''${encodeURIComponent(...)}` (RFC 5987/6266).
- **C7**: rate-limit.ts + bucket `export: { maxRequests: 10, windowMs: 60_000 }`; route.ts pakai RATE_LIMITS.export + header `Retry-After` (dihitung dari rl.resetAt — fixed-window limiter, dibulatkan ke atas, min 1s; window 60s).
- **P6**: komentar usang di-update: "17/18-query Promise.all" → deskripsi section-gated; "~8s cold" → deskripsi akurat (tergantung jumlah section + warmth q-*); "title + 7 sections" → 6; header PERF-FASE3-BE04 ditandai bahwa evaluator SQL sudah tidak dipakai pipeline ini.

## Test updates (3 file, semua terdampak perubahan in-scope / leftover Main)
1. tests/queries/top-growth.test.ts + 2. tests/queries/change-analysis.test.ts: assertion `mockExecuteRaw).toHaveBeenCalledTimes(2)` → `1` (2 SET LOCAL → 1 set_config merged). Dibuat minimal dengan memilih $executeRaw (bukan $queryRaw) untuk statement merged: semua test lain yang assert `mockQueryRaw` count/calls[0] TIDAK tersentuh.
3. tests/lib/validation.test.ts: **pre-existing red SEBELUM perubahan saya** (diverifikasi via git stash: stash file saya → test tetap gagal) — fixture lama `sections: 'summary,pareto'` meng-assert perilaku lama yang sengaja dihapus fix Main BUG-3-a C6 (strict keys di validation.ts). Fixture di-update ke kontrak baru ('exec,topItems') + case reject key tak dikenal + case terima token kosong. Bukan bagian scope saya, tapi gerbang "test hijau" mengharuskan; dicatat jelas di komentar test + worklog.

## Gates
1. `bunx tsc --noEmit` → 0 error ✓ (dijalankan 3×: awal, tengah, akhir)
2. `bun run test` → 509/509 PASS ✓ (baseline 487 + test yang ditambah agent paralel; 1 pre-existing red dari leftover Main diperbaiki, lihat atas)
3. `bunx eslint <semua file berubah>` → 0 error, 14 warning — SEMUA pre-existing (baseline sebelum perubahan: 16 warning; diff saya justru -2 karena blok multiPeriodComparison yang memicu warning 'sortKey' dihapus) ✓
4. `bunx tsc --noEmit` ulang di akhir → 0 error ✓

## Stage summary
- Dead compute 35-60% dari cold path export hilang; export "exec only" kini hanya bayar metadata + COUNT + q-kpis + q-exec-summary (dulu: + q-trend + topcat + prevTop(100) + 4×hist-catavg + 5 dead query).
- 404 path paling murah: metadata + COUNT saja sebelum lempar EarlyHttpResponse.
- RTT berat dipangkas: 5→4 per withStatementTimeout query, -2 preloaded resolver, -1 barier wave; metadata ter-bound timeout.
- Correctness: cache-key sections= kosong tidak lagi menabrak key "semua section"; prev-topcat ter-invalidasi mutasi; filename aman RFC; 429 membawa Retry-After.
- Dilarang/disentuh: TIDAK menyentuh aggregation-cache/**, validation.ts, frontend, route lain; tidak commit/push; tidak menjalankan dev server/build.
