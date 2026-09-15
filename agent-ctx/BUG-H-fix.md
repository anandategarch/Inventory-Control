---
Task ID: BUG-H
Agent: full-stack-developer
Task: Bug hunt umum di jalur panas aplikasi (hooks klien, page.tsx, API routes non-export) — bukan refactor gaya. Domain: `src/hooks/**`, `src/app/page.tsx` + layout non-API, `src/app/api/**` KECUALI `export-report/**` (read-only mutlak). 3 agent lain paralel di tabs/ItemTrendTab, kartu dashboard+filters, dan `src/lib/**`.

Work Log:
- Baca `worklog.md` tail 120 baris: pelajaran kunci = "cache version mismatch dua sisi" (rv/sv) adalah musuh berulang; BUG-HUNT lalu menemukan 7 bug di area serupa.
- **Verifikasi rv parity dua sisi (musuh berulang #1):** `useDashboardActions.ts` handleExport mengirim `params.set('rv', '7')` ↔ `/api/export-report/route.ts` extra `rv: '7'` — MATCH, tidak ada mismatch. (sv 2/6 dsb. semuanya di dalam export-report services — domain Main, tidak disentuh.)
- **Audit hooks (semua 13 file):** useDashboardActions (export blob/timeout/revoke-deferred/validasi content-type+size — semua FIX lama utuh dan benar; dep array useCallback lengkap), useAnalysis/{useAnalysis,fetchAnalysis,useItemTrend,useDrilldown,useStatus,prefetchHeatmap,types}, useDashboard (zustand — tanpa persist, tidak ada hydration issue), useDashboardEffects (2 efek: auto-select atomic + cache warming dengan key-parity), usePriceEffect, useRecommendations, use-toast (variant-aware duration + listener cleanup benar).
- **Audit page.tsx + layout:** hydration (Date.now/random dalam render — tidak ada; `new Date(dataUpdatedAt)` di DashboardHeader hanya client-side pasca-fetch, dikomentari sengaja), effects dengan cleanup benar (keydown, scroll, ResizeObserver, event listener open-upload/open-drive), activeTabRef pattern OK, lazy tabs + visitedTabs gating OK.
- **Audit API routes non-export (semua 30+ route):** analysis (+services validate-and-resolve/fetch-records/run-queries/background-recompute), status, refresh, drilldown, item-trend, item-trend-rank, item-history, recommendations, price-effect, pareto, area-item-heatmap (+cell-detail), flip-ranking (+drilldown), item-anomali-outlets, item-peer-comparison, peer-comparison (+items, +trend), change-analysis (+items), benchmark-opportunity, outlet-items, item-search, settings, data, pic (+import), ingest, ingest-upload, ingest-process (+services via grep), import-drive, setup, migrate-direction. Pola diperiksa: try/catch menelan error, status code, validasi Zod, cache key memuat semua param, sentinel __NO_MATCH__, EarlyHttpResponse, resolve/reject in-flight, headers, parseInt tanpa guard.
- **Audit komponen umum (domain saya):** providers.tsx, layout.tsx, error.tsx, loading.tsx, ExportDialog, DrillDownDrawer, SourceDataModal, ItemDeepDive, DashboardHeader, DashboardFooter, shared/index.tsx (EmptyState/LoadingState/ErrorState/SectionHeader/ScrollToTop). Read-only lintasan komponen domain-lain: PeerComparison/use-peer-queries.ts, OutletPriorityPanel/use-lens-data.ts, ExecutiveStatus, RestoAnalysis.
- **3 bug nyata ditemukan, semua difix (diff minimal):** lihat Stage Summary.

BUG DITEMUKAN + DIPERBAIKI (3):

1. **BUG-H-1 (HIGH) — /api/analysis: awaiter in-flight menyajikan payload 404 sebagai HTTP 200 + `cached:true`.**
   - Lokasi: `src/app/api/analysis/services/validate-and-resolve.ts` (branch awaiter in-flight, ~line 291).
   - Bukti kode (sebelum fix):
     ```ts
     const inflightResult = await inflight;
     if (isRawCacheHit(inflightResult)) { ...raw 200... }
     if (inflightResult && typeof inflightResult === 'object' && 'success' in inflightResult) {
       const r = inflightResult as Record<string, unknown>;
       r.cached = true;                       // ← payload 404 di-mutate
       r.durationMs = Date.now() - startedAt;
       return { ..., response: NextResponse.json(r, { headers: CACHE_ANALYSIS }) }; // ← HTTP 200!
     }
     ```
     Route.ts (satu-satunya resolusi berbentuk object selain RawCacheHit) me-resolve in-flight Promise dengan payload 404: `resolveComputation?.(notFoundResponse)` untuk `{success:false, message:'No records found…'}` lalu return `NextResponse.json(notFoundResponse, {status:404})`.
   - Penjelasan: request PERTAMA untuk (month,week,filters) tanpa data mendapat 404; request KONKUREN (tab kedua / F5 cepat / burst) yang meng-await in-flight Promise yang sama menerima payload yang sama sebagai **200 + cached:true**. `fetchAnalysis` (client) memercayai 200 + JSON → `return res.json()` → "AnalysisData" tanpa `period/executiveSummary/...` → page.tsx `analysis.data` truthy → `ExecutiveStatus` dereference `data.executiveSummary.qtyDeviasi` → TypeError (ErrorBoundary menelan layer CONTROL STATUS). Bonus: mutasi `r.cached = true` pada object bersama yang sedang diserialisasi requester pertama, dan `CACHE_ANALYSIS` pada 200 salah itu membuat CDN bisa menyimpan jawaban cacat 5 menit.
   - Dampak user: layer Control Status jadi layar error (bukan pesan "Tidak ada data untuk kombinasi filter ini" yang seharusnya), kontrak status HTTP inkonsisten antara requester langsung vs konkuren.
   - Fix (diff ringkas): branch `success === false` → `NextResponse.json({ ...r }, { status: 404 })` (copy fresh, tanpa mutasi, tanpa CACHE_ANALYSIS agar CDN tidak mem-pin jawaban "no data" 5 menit — persis menyamai jalur 404 langsung di route.ts). Branch success:true (saat ini dead-code pengaman) dibiarkan apa adanya.

2. **BUG-H-2 (LOW-MED) — /api/peer-comparison/items: `topItems` negatif lolos clamp → `LIMIT -5` → 500.**
   - Lokasi: `src/app/api/peer-comparison/items/route.ts` line ~57.
   - Bukti kode (sebelum): `const topItems = Math.min(parseInt(url.searchParams.get('topItems') || '5', 10) || 5, 20);`
   - Penjelasan: `|| 5` hanya menangkap NaN/0. `?topItems=-5` → `-5` truthy → `Math.min(-5, 20) = -5` → `queryPeerComparisonItems` menempelkannya ke SQL `LIMIT ${topItems}` (peer-comparison-items.ts:186) → PostgreSQL "LIMIT must not be negative" → errorResponse 500. Route saudara (`/api/peer-comparison` untuk `limit`, `/api/recommendations` untuk `limit`) KEDUANYA memakai `Math.max(1, …)` — hanya route ini yang bolong (kelas "validasi input bolong": seharusnya di-clamp, bukan 500). Skema Zod route ini juga tidak memuat `topItems`/`mode` (non-strict → param unknown lolos validasi).
   - Dampak user: konsumen API langsung dengan param salah mendapat 500; UI internal selalu mengirim 5 sehingga tak terlihat dari UI.
   - Fix (diff ringkas): `Math.min(Math.max(1, parseInt(…) || 5), 20)` — paritas dengan route saudara.

3. **BUG-H-3 (MED) — useRecommendations: queryFn tidak memeriksa `res.ok` → body error HTTP (429/5xx ber-JSON) ditelan sebagai DATA query.**
   - Lokasi: `src/hooks/useRecommendations.ts` queryFn (~line 129).
   - Bukti kode (sebelum):
     ```ts
     const res = await fetch(`/api/recommendations?${p.toString()}`);
     const ct = res.headers.get('content-type') || '';
     if (!ct.includes('application/json')) throw new Error('Server error');
     return res.json();   // ← 429/500 JSON body masuk sebagai data!
     ```
   - Penjelasan: `/api/recommendations` rate-limit 429 dan error 5xx semuanya `NextResponse.json` (content-type application/json) → guard content-type lolos → `{success:false, error:'Rate limit exceeded.'}` di-return sebagai `RecommendationsResponse`. Konsekuensi: `error` query tidak pernah ter-set (OutletPriorityPanel lens Prioritas membaca `recError` — tidak pernah ada), `recommendations` undefined → fallback kosong → **hero ExecutiveStatus "0 resto menjadi prioritas"** + panel prioritas tampil kosong tanpa pesan error (error swallow). Ini satu-satunya hook di `src/hooks/**` yang tidak cek `res.ok` — useAnalysis/useStatus/useDrilldown/useItemTrend/usePriceEffect semuanya mengeceknya.
   - Dampak user: pada 429/transient 5xx, dashboard menampilkan "0 resto prioritas" yang salah secara diam-diam, bukan state error yang jujur; retry TanStack juga tidak berjalan karena tidak ada throw.
   - Fix (diff ringkas): tambah `if (!res.ok) { const e = await res.json().catch(() => null); throw new Error(e?.error || \`HTTP ${res.status}\`); }` — paritas pola usePriceEffect.

TIDAK diperbaiki + alasan (diperiksa, dinilai bukan bug nyata / di luar domain / terlalu teoretis):
- **`handleExport` race klik-ganda** (useDashboardActions): dianalisis — dialog ditutup sinkron via `setExportDialogOpen(false)` + tombol Export di ExportDialog DAN header di-disable oleh `isExporting`; satu-satunya jendela teoretis adalah double-click sub-frame sebelum React commit (tertutup oleh batching React 18/19). Tidak ada repro realistis; menambah ref-guard = hardening tanpa bug nyata. Klik-ganda refresh sudah di-guard (`disabled={analysisFetching}` + komentar FIX BUG-HUNT C3/B3).
- **`DrillDownDrawer.handleLoadMore` tanpa cek `res.ok`** (components/drilldown): gagal HTTP → `data.success` false → no-op senyap (tombol re-enabled, bisa retry); tidak ada crash / tidak ada pencampuran data (race-guard filterSigRef dari BUG-3-b B2 tetap melindungi). Dampak = UX minor, bukan perilaku salah — dibiarkan demi diff minimal.
- **`useItemTrend` queryKey duplikasi 'all' vs null** untuk `area/kelompok/outletCode`: dua key berbeda untuk request identik → duplikasi entri cache saja, tidak pernah data salah. Kosmetik.
- **useDashboardEffects Effect 2 menandai `warmedStatusKey` sebelum cek `monthLabel`**: disengaja (warming hanya untuk initial load; Zustand tidak persist jadi monthLabel selalu null saat status pertama kali resolve); setelah ada periode terpilih, live query tetap mem-fetch periode itu. Bukan bug.
- **Berkas domain agent lain di working tree** (FileUploadDialog, csv-parser, drive-import, ingestion, top-items/by-other-metric-pareto — terlihat di `git diff --stat`): tidak disentuh sama sekali.

Cross-domain findings (file LUAR domain saya — JANGAN saya edit, untuk Main/agent pemilik domain):
1. **`src/components/dashboard/PeerComparison/use-peer-queries.ts`** (domain kartu dashboard): keempat queryFn (main / items / trend / benchmark-opportunity) hanya cek `content-type` tanpa `res.ok` — kelas error-swallow yang sama persis dengan BUG-H-3. Respons 429/5xx ber-JSON masuk sebagai data → `peers` kosong → kartu Peer tampil "no peers" tanpa state error, dan `error` query tidak pernah ter-set. Rekomendasi: tambahkan cek `!res.ok → throw` di keempat queryFn (pola usePriceEffect).
2. **`src/components/dashboard/narrative/OutletPriorityPanel/use-lens-data.ts`** (domain kartu dashboard): query lens "Peluang Rp" (`/api/benchmark-opportunity`) dan "Perubahan" (`/api/change-analysis`) juga hanya cek content-type tanpa `res.ok` — dampak sama (lens kosong senyap saat 429/5xx; `oppError`/`chgError` tidak pernah ter-set).
3. **Catatan kecil untuk lib agent:** `src/lib/validation.ts` — `peerComparisonItemsQuerySchema`/`peerComparisonTrendQuerySchema` tidak `.strict()` dan tidak memuat `mode`/`topItems`/`peers` (param unknown lolos validasi Zod lalu dibaca raw di route). BUG-H-2 sudah dimitigasi di sisi route dengan clamp, tapi kalau mau paritas dengan keluarga route strict (item-trend dkk.), schema-nya perlu dilengkapi.

VERIFIKASI:
- `bunx tsc --noEmit --incremental false` → **0 error** seluruh repo.
- `bun run lint 2>&1 | tail -40` → **0 errors, 379 warnings** (semua warning di file saya pre-existing — unused-vars deklarasi resolve/reject + non-null assertion `month!`/`week!` yang sudah ada sebelum edit; tidak ada warning baru dari 3 file yang saya ubah; `peer-comparison/items/route.ts` bahkan 0 warning).
- `rg --files tests/hooks tests/app` → `tests/hooks/use-toast.test.ts` + `tests/app/outlet-items-resolve-period.test.ts` → `bunx vitest run` kedua file: **12/12 PASS**.
- Full suite `bunx vitest run` (regression, termasuk perubahan agent paralel di working tree): **31 file / 512/512 PASS**.
- Tidak menjalankan `bun run dev`/`build`/`db:*` (DB produksi tak terjangkau dari sesi ini); verifikasi statis + test sesuai batasan.

Stage Summary:
- 3 bug nyata ditemukan + diperbaiki dengan diff minimal (3 file, +38/−3 baris efektif, tanpa refactor):
  1. `src/app/api/analysis/services/validate-and-resolve.ts` — awaiter in-flight kini menyajikan payload "No records found" sebagai 404 yang identik dengan jalur langsung (sebelumnya: 200 + cached:true → AnalysisData cacat → TypeError di ExecutiveStatus + mutasi object bersama + risiko CDN mem-pin jawaban cacat).
  2. `src/app/api/peer-comparison/items/route.ts` — `topItems` di-clamp bawah 1 (sebelumnya `?topItems=-5` → `LIMIT -5` → 500 PostgreSQL).
  3. `src/hooks/useRecommendations.ts` — queryFn kini melempar pada `!res.ok` (sebelumnya body 429/5xx ber-JSON ditelan sebagai data → "0 resto prioritas" palsu di hero + panel prioritas kosong senyap; satu-satunya hook tanpa cek res.ok).
- Audit menyeluruh jalur panas: 13 hooks, page.tsx + layout/error/loading/providers, 30+ API route non-export, komponen umum (drawer/modal/dialog export/header/footer/shared). rv parity dua sisi (client '7' ↔ server '7') diverifikasi — tidak ada mismatch versi cache.
- 3 cross-domain findings dilaporkan (use-peer-queries + use-lens-data: kelas error-swallow `res.ok`; validation.ts: schema peer-comparison-items tidak strict) — tidak diedit karena di domain agent lain.
- Gates: tsc 0 err · eslint 0 err (379 warning pre-existing, 0 baru) · vitest 512/512 (termasuk tests/hooks + tests/app 12/12).
- Tidak ada commit/push (sesuai batasan); working tree juga berisi perubahan domain agent paralel yang tidak saya sentuh.
