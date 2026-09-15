---
Task ID: SPLIT-F
Agent: general-purpose
Task: Refactor murni (pure code motion) dua script CLI besar — `scripts/audit/audit-migration.ts` (886 baris) dan `scripts/audit-data-qa.ts` (656 baris) — menjadi modul-modul kecil (<250 baris/file) dengan entry tipis tetap di path lama. Tanpa perubahan perilaku/logika/urutan langkah/SQL/output CLI. Kedua script TIDAK dijalankan (DB produksi); verifikasi via tsc + eslint + transpile + parity-statik.

Work Log:
- Baca `worklog.md` (tail 150) — pola referensi: SPLIT-GOD-FILE (commit b4b37d2, entry tipis + modul per section, verifikasi parity). Baca `agent-ctx/DOC-MASTER-general-purpose.md` + `agent-ctx/REFACTOR-1-a-fullstack.md` (precedent split backend: barrels, verbatim bodies, type-level adaptation minimalem, warning-parity 1:1).
- Scan referensi eksternal: `rg -n "audit-migration|audit-data-qa" --hidden -g '!.git' -g '!node_modules' .` → HANYA ARCHITECTURE.md (2×, path-only), AUDIT-REPORT.md (3×, satu di antaranya pakai nomor baris `:24-25`), worklog.md (historis, read-only). package.json TIDAK punya script untuk kedua file ini; README/nixpacks/railway/Procfile/.github tidak ada referensi; `rg -l ... tests/` → kosong (tidak ada test).
- Konfirmasi `tsconfig.json` → `exclude: ["...", "scripts"]` (pre-existing: scripts tidak pernah tercakup tsc proyek). `eslint.config.mjs` → scripts/ TERTUTUP lint (ignores hanya node_modules/.next/out/build/examples/skills).
- Baseline lint kedua script lama: **0 error, 23 warning** (3 di audit-data-qa: `any`×3 di helper raw; 20 di audit-migration: `any`×14 + unused `mismatchCount`/`cols`/`customized`).
- Baseline tsc standalone (flag strict setara proyek + types node/bun-types, file asli diekstrak dari `git show HEAD:` ke /tmp): **110 error laten** — semuanya dari quirk generik `raw<T>(...): Promise<T[]>` di audit-data-qa (semua call-site mempassing tipe ROW-ARRAY sebagai T → `Promise<{...}[][]>`). Laten karena scripts tak pernah di-tsc. Runtime tak terdampak (generik terhapus).
- SPLIT `scripts/audit/audit-migration.ts` (886 → 14 file):
    * Entry tipis di PATH LAMA (135 baris): header verbatim + komentar AUDIT-SEC-ENV verbatim, baca env `OLD_DATABASE_URL`/`DATABASE_URL` verbatim, validasi throw/info verbatim, `createPools()`, `main()` (banner, connectivity ping OLD→set `ctx.state.oldReachable=false`+issue MIGR-00, ping NEW→exit 1, panggil check1..check10 berurutan, summary, dump JSON), `main().catch().finally(pool.end ×2)` verbatim.
    * `scripts/audit/migration/context.ts` (50): `Issue`, `TABLES`, `createMigrationAuditContext()` → `{ oldPool, newPool, state:{oldReachable}, issues, addIssue }` + `type MigrationAuditContext = ReturnType<...>`. `let OLD_REACHABLE` lama → field `state.oldReachable` (urutan tulis-ping-→-baca-check identik).
    * `scripts/audit/migration/db.ts` (20): `createPools()` (2× `new Pool` config verbatim) + `q()` verbatim.
    * `scripts/audit/migration/report.ts` (41): `hr()` verbatim, `printIssueSummary()` (blok SUMMARY dari main, verbatim), `writeIssuesJson()` (dynamic `import('fs')` + writeFileSync /tmp/audit-migration-issues.json verbatim).
    * `check-row-counts.ts` (132) / `check-fk-integrity.ts` (45) / `check-sequences.ts` (50) / `check-indexes.ts` (129) / `check-unique-constraints.ts` (51) / `check-sample-records.ts` (112) / `check-settings.ts` (113) / `check-aggregation-cache.ts` (26) / `check-null-checks.ts` (49) / `check-performance.ts` (52) — CHECK 1..10 verbatim; substitusi mekanis `q(ctx.newPool,…)`/`ctx.addIssue(…)`/`ctx.state.oldReachable`.
    * SATU penyesuaian resolusi: dynamic import `'../../src/lib/settings'` → `'../../../src/lib/settings'` (modul satu level lebih dalam; target file sama — terbukti resolve di tsc: src/lib/settings/index.ts ikut ter-compile; catatan: settings.ts baru saja dipecah jadi folder oleh agent paralel, tetap resolve).
- SPLIT `scripts/audit-data-qa.ts` (656 → 8 file):
    * Entry tipis di PATH LAMA (98 baris): header verbatim (+ peta modul), `createDataQaContext()`, `main()` = 28 await section berurutan (1, 2, 2a, 3..27) + save report (`Bun.write('/tmp/audit-data-qa-report.txt', ctx.out.join('\n'))` + console.log verbatim), `main().catch().finally(ctx.db.$disconnect())` verbatim.
    * `scripts/audit-data-qa-lib/context.ts` (37): `createDataQaContext()` — PrismaClient + `out`/`log`/`section`/`raw` verbatim; `type DataQaContext = ReturnType<...>`.
    * 6 modul topik (grup kontigu supaya urutan output identik): `direction-signs.ts` (117, §1–4), `field-consistency.ts` (151, §5–8), `master-data.ts` (124, §9–12), `records-integrity.ts` (149, §13–17), `samples-and-signs.ts` (86, §18–21), `distributions.ts` (98, §22–27) — 28 fungsi `sectionNN_*(ctx)`, body verbatim (`ctx.log/ctx.raw/ctx.db/ctx.section`).
    * SATU penyesuaian type-level (zero-runtime, generik terhapus saat eksekusi): `raw<T>(…): Promise<T[]>`+`$queryRawUnsafe<T[]>`+`return []` → `Promise<T>`+`$queryRawUnsafe<T>`+`return [] as T` — membetulkan quirk laten 110 error; SEMUA call-site tidak berubah.
    * Nama folder pakai ASCII murni `audit-data-qa-lib/` sesuai instruksi (hindari nama non-ASCII).
- VERIFIKASI PARITAS (script TIDAK dijalankan — DB produksi):
    * Urutan label: 28 label `section('…')` QA identik urutannya (diekstrak berurutan dari modul sesuai urutan main()); 11 label `hr('…')` migration identik (CHECK 1..10 → SUMMARY).
    * Count paritas: SELECT QA 69=69; SELECT migration 88=88; `await q(` 25=25; call `addIssue(` 21=21 (angka 22 lama = +1 definisi fungsi); `ctx.log(` 86 = 86 `log(` body lama (diff 3 baris = 2 pemanggilan log di dalam helper yang pindah ke context.ts + 1 `console.log` entry — semua tetap ada).
    * Diff multiset baris ternormalisasi (strip `ctx.`, wrapper import/export/function): SEMUA selisih hanyalah wrapper struktural + 3 baris fix type raw — TIDAK ADA perubahan SQL/pesan/logika.
- VERIFIKASI TOOLING:
    * `bunx eslint <domain>` → **0 error, 23 warning = 1:1 dengan baseline** (perlu ReturnType-of-factory untuk menghindari 12 warning baru dari params interface — quirk base `no-unused-vars` yang juga ada di kode lama, mis. useItemTrendAutocomplete.ts:32).
    * tsc standalone 22 file domain (entry + modul + graf src/lib/settings via dynamic import) → **0 error** (baseline file lama: 110 error laten — lihat atas).
    * `bun run lint` (full repo) → 0 error, 389 warning (23 milik domain saya, sisanya pre-existing/agent paralel).
    * `bunx tsc --noEmit --incremental false` (full repo, scripts memang di-exclude) → 1 error DI LUAR domain: `src/app/api/export-report/services/data-fetcher/query-batch.ts(244,47) TS2345` (domain export-report, kerjaan agent paralel — tidak disentuh, tidak diperbaiki).
    * `bun build <file> --no-bundle` (transpile-only, TIDAK mengeksekusi) → exit 0 untuk kedua entry + 20 modul.
- `git status` domain saya bersih: hanya `M scripts/audit/audit-migration.ts`, `M scripts/audit-data-qa.ts`, `?? scripts/audit/migration/`, `?? scripts/audit-data-qa-lib/`. Semua perubahan lain (src/**, agent-ctx/SPLIT-E-split.md) milik agent paralel — tidak disentuh. Tidak ada add/commit/push.

Stage Summary:
- **audit-migration**: 886 baris → entry 135 + 13 modul (max 132 baris/file) = 1.005 baris total (+119 dari header/import/export — rasio baris-logika identik). Entry tetap di `scripts/audit/audit-migration.ts`.
- **audit-data-qa**: 656 baris → entry 98 + 7 modul (max 151 baris/file) = 860 baris total (+204 dari 28 wrapper fungsi + blok import + header modul). Entry tetap di `scripts/audit-data-qa.ts`.
- Peta file baru: `scripts/audit/migration/{context,db,report,check-row-counts,check-fk-integrity,check-sequences,check-indexes,check-unique-constraints,check-sample-records,check-settings,check-aggregation-cache,check-null-checks,check-performance}.ts` dan `scripts/audit-data-qa-lib/{context,direction-signs,field-consistency,master-data,records-integrity,samples-and-signs,distributions}.ts`.
- Semua file <250 baris ✓. Path entry tidak berubah ✓ (bukti: package.json tidak mereferensikan script ini sama sekali; ARCHITECTURE.md:771/:903 + AUDIT-REPORT.md menyebut path, bukan cara invoke; tidak ada test yang mengimpor).
- Perilaku identik: pure code motion — urutan langkah/SQL/output terverifikasi statis (label order, multiset diff, count paritas). DUA penyesuaian terdokumentasi: (1) path dynamic import check7 (+1 level `../`, target file sama), (2) fix signature generik `raw` type-level-only (menghapus 110 error laten; JS hasil erasure identik).
- Gates: eslint domain 0 error (warning 23 = 1:1 baseline); tsc domain 0 error (standalone, scripts memang di-exclude tsconfig proyek — pre-existing); bun transpile 0 error; 1 error tsc luar domain dicatat & diabaikan.

Catatan risiko/bug (TIDAK diperbaiki — di luar mandat):
1. **AUDIT-REPORT.md:11** menyebut `scripts/audit/audit-migration.ts:24-25` — nomor baris kini stale setelah split (blok komentar AUDIT-SEC-ENV sekarang ~baris 38–46 di entry). Dokumen read-only untuk agent ini.
2. **ARCHITECTURE.md:771** mengklaim audit-migration.ts "(770 lines)" — sudah stale sebelum split (file aslinya 886; kini entry 135 + modul). Read-only.
3. Header audit-data-qa.ts menyebut "~17 checklist SQL queries + reports findings as JSON" — tidak akurat sejak lama (28 section; output TXT di /tmp/audit-data-qa-report.txt). Dipertahankan verbatim.
4. Dead vars pre-existing dipertahankan verbatim (masih jadi warning): `mismatchCount` (check-row-counts), `cols` di cabang unreachable check-sample-records, `customized` (check-settings).
5. Fix type-level `raw` (satu-satunya deviasi dari verbatim murni) — sudah diberi komentar TYPE-LEVEL FIX di context.ts; jika policy "verbatim absolut" berlaku, mundurkan ke `Promise<T[]>` akan mengembalikan 110 error laten tanpa efek runtime.
6. check7 melakukan dynamic import ke `src/lib/settings` (relatif 3 level) — jika lokasi/struktur settings berubah lagi (baru dipecah jadi folder oleh agent paralel SPLIT lainnya), path ini ikut perlu disesuaikan; risiko yang sama sudah ada pre-split.
7. Entry audit-migration tetap membuat `oldPool` dengan connection-string sentinel invalid saat `OLD_DATABASE_URL` kosong (perilaku asli — ping gagal → MIGR-00 → NEW-only checks).
8. Kedua script tetap TIDAK dijalankan oleh agent ini (DB produksi). Smoke-test runtime pasca-split (mis. dengan DATABASE_URL dummy sampai gagal koneksi dengan pesan yang sama) disarankan saat window maintenance.
