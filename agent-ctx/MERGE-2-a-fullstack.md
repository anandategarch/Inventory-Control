# MERGE-2-a — Share z-score baseline helper 3→1 (audit A2, bagian dari task A2)

Agent: full-stack-developer (Z.ai Code)
Repo: /home/z/audit-inventory · HEAD awal 0f726de (tree bersih) · PURE REFACTOR, zero behavior change · NOT committed/pushed (protokol PAT — Main yang commit).

## Ringkasan

Duplikasi z-score baseline yang ditemukan audit A2 (formula z sudah shared di `src/lib/metrics/historical.ts`, tapi statistik sampel + window SQL masih 3×) dikonsolidasi menjadi:

1. **`src/lib/metrics/sample-stats.ts`** (BARU, 98 baris) — statistik sampel JS murni:
   - `computeSampleStatsFromSums(n, mean, sumSq)` — verbatim dari `queries/historical.ts` `computeStats` (bentuk SUM-SQ dari SQL aggregate; Bessel n-1; `Math.max(0, …)` floating-point guard; `mean || 0` NULL/NaN guard — semua didokumentasikan di JSDoc).
   - `computeSampleStats(values)` — verbatim dari `queries/item-trend.ts` (bentuk array; Bessel n-1; guard clamp).
   - `HISTORICAL_MIN_WEEKS_DEFAULT = 4` — JSDoc: default PRD §5.2; runtime override via `getRuntimeThresholds().HISTORICAL_MIN_WEEKS` dipakai pipeline analysis (post-process-historical + computeZScore); item-trend pakai konstanta tetap (query layer tanpa akses Settings, route TIDAK mulai membaca settings — ZEITGEIST dijaga).
   - Return type = `HistoricalStats` dari `metrics/historical.ts` — TIDAK ada shape ketiga.

2. **`src/lib/queries/historical-baseline.ts`** (BARU, 146 baris, precedent H-12 item-outlet-breakdown.ts + MERGE-1-a peer-bucket.ts):
   - `sameWeekHistoricalWindow(opts)` — fragment SQL KONVENSI inti: pin weekLabel SAMA + exclude future months. Dua mode: monthKey-based `sf."monthKey" < ${currentMonthKey}` (BUG2-PARETO-1) + fallback label `ir."monthLabel" != ${currentMonthLabel}` (pre-fix, tetap dipertahankan karena route bisa resolve monthKey undefined saat SourceFile bulan berjalan tidak ada).
   - `sameWeekPeriodPin(recordAlias, monthLabel, weekLabel)` — pin `(ir."monthLabel" = $1 AND ir."weekLabel" = $2)` per periode untuk `queries/historical.ts`.
   - Header wajib: minggu = snapshot kumulatif MTD (W1=1-7 … W4=1-25) → satu-satunya perbandingan antar-bulan valid = weekLabel sama (W4 vs W4, bukan W4 vs W1+W2+W4); exclude future month (BUG2-PARETO-1); referensi audit A2.

3. **`src/lib/queries/historical.ts`** (124 → 130 baris): hapus `computeStats` lokal (→ import `computeSampleStatsFromSums`); `MetricStats` interface → **type alias** `HistoricalStats` (export name tetap hidup untuk barrel `@/lib/queries` `export * from './historical'`, tidak ada konsumen eksternal yang import MetricStats langsung — diverifikasi rg); predicate per-periode → `sameWeekPeriodPin('ir', …)`.

4. **`src/lib/queries/item-trend.ts`** (250 → 253 baris): hapus `computeSampleStats` lokal + const lokal `HISTORICAL_MIN_WEEKS` (→ import `HISTORICAL_MIN_WEEKS_DEFAULT`, nilai sama 4); guard `stats.n >= HISTORICAL_MIN_WEEKS_DEFAULT`; komentar header diarahkan ke modul shared.

5. **`src/lib/queries/pareto/historical.ts`** (99 → 108 baris): gabungkan `ir."weekLabel" = ${week}` + ternary futureFilter (`AND sf."monthKey" < …` | `AND ir."monthLabel" != …`) menjadi SATU fragment `sameWeekHistoricalWindow({ recordAlias: 'ir', sourceFileAlias: 'sf', week, currentMonthKey, currentMonthLabel: month })`; komentar FIX (BUG2-PARETO-1) tetap di call site + versi lengkap pindah ke header modul shared.

## Verifikasi zero behavior (empiris + reasoning karakter-per-karakter)

Script throwaway `bun` (disimpan `/home/z/bughunt/tmp/verify-merge2a.ts`, dijalankan dari dalam repo lalu dihapus dari working tree) — render `Prisma.Sql` lama (verbatim dari HEAD) vs baru:

- `sameWeekPeriodPin` → `.sql` + `.values` **byte-identical** vs predicate lama untuk 3 kombinasi input + komposisi `Prisma.join(pins, ' OR ')` byte-identical → SQL `queryHistoricalStatsMultiMetric` **karakter-identik** (nol perbedaan).
- `sameWeekHistoricalWindow` (branch monthKey) → composed WHERE lama `"WHERE ir.\"weekLabel\" = ?\n        AND sf.\"monthKey\" < ?\n        AND ir.\"absNominalDeviasi\" …"` vs baru `"WHERE ir.\"weekLabel\" = ? AND sf.\"monthKey\" < ?\n        AND …"` — **satu-satunya perbedaan = whitespace antar-konjungsi** (`\n        ` → ` `, char diff di offset 30). Bind params identik (urutan + nilai: `[week, currentMonthKey]`). SQL ekuivalen semantik persis (parse tree + plan Postgres identik) — kelas perbedaan yang sama dengan yang diterima + didokumentasikan MERGE-1-a ("beda whitespace multi-baris → satu baris, ekuivalen semantik").
- Branch fallback label (`currentMonthKey` undefined) → kelas perbedaan whitespace yang sama, params `[week, month]` identik. Branch ini REACHABLE (route: `currentSourceFile?.monthKey ?? undefined`) sehingga fallback sengaja dipertahankan di dalam fragment.
- `computeSampleStatsFromSums` / `computeSampleStats` → identik numerik pada semua edge case yang diuji (n=0, n=1, NaN mean, array konstan, nilai negatif) — body verbatim.
- `HISTORICAL_MIN_WEEKS_DEFAULT === 4` — zero behavior untuk guard item-trend.

## Keputusan desain + penyimpangan spek

1. **item-trend.ts TIDAK memakai fragment SQL** — disetujui spek ("BOLEH memutuskan TIDAK memakai fragment"): baseline same-week item-trend dibangun SEPENUHNYA di JS (query mengembalikan SEMUA periode → `byWeek` map + self-exclusion post-query). Tidak ada predikat window SQL untuk di-share; memaksa fragment = restrukturisasi query (LATERAL/correlated subquery) = perubahan bentuk SQL + risiko. Didokumentasikan di header item-trend.ts DAN header historical-baseline.ts.
2. **`sameWeekPeriodPin` diekspor KEDUA** (di luar sketch signature `sameWeekHistoricalWindow` saja) — diperlukan untuk call site historical.ts yang bentuknya pin per-(month, week) eksak (spek: "fragment builder bisa dipakai untuk pasangan itu"); sketch signature diadaptasi sesuai instruksi "SESUAIKAN bentuk persis dengan yang ada di tiap call site".
3. **`currentMonthLabel` ditambahkan ke opts** (di luar sketch) — fallback `ir."monthLabel" != ${month}` harus tetap hidup di dalam fragment demi zero behavior (branch reachable); tanpa ini fragment hanya bisa render branch monthKey.
4. **`MetricStats` → type alias `HistoricalStats`** — murni tipe, export name tetap hidup (tidak ada konsumen eksternal — diverifikasi `rg`; barrel `export *` tetap kompatibel). Memenuhi "definisikan interface satu kali" tanpa membuat shape ketiga.
5. **Tidak ada perubahan barrel** (`@/lib/queries`, `@/lib/metrics`) — file baru di-import langsung via path modul; surface publik stabil. `pareto/historical.ts` stats SQL (AVG + STDDEV_SAMP) sengaja TIDAK dimigrasi ke JS.
6. **File lama `queries/historical.ts` KEEP export `MetricStats`** — bukan dihapus, di-alias (lihat #4).

## Gerbang (semua hijau, dijalankan SETELAH semua edit)

| Gate | Hasil |
|---|---|
| `bunx tsc --noEmit` | 0 error |
| `bun run test` | **473/473 passed** (27 file), `git status tests/` = kosong (0 baris) |
| `bunx eslint` 5 file scope | 0 error, **0 warning** (baseline HEAD via `git show | eslint --stdin` = 0 warning juga → tidak ada perubahan warning) |
| `git diff --stat` | hanya 3 M (`historical.ts`, `item-trend.ts`, `pareto/historical.ts`) + 2 new (`sample-stats.ts`, `historical-baseline.ts`) |

## Marker lama terjaga

- BUG2-PARETO-1 (pareto/historical.ts param comment + blok komentar filter; versi lengkap di header historical-baseline.ts + JSDoc fragment).
- Komentar "Filter: same weekLabel, different monthLabel", "Two-level aggregation", semua komentar header file lain tidak tersentuh isinya.
- Komentar const + fungsi yang dipindah ikut pindah (JSDoc lama di-expand di sample-stats.ts, makna asli dipertahankan).

## File berubah

| File | Status | Baris |
|---|---|---|
| `src/lib/metrics/sample-stats.ts` | BARU | 98 |
| `src/lib/queries/historical-baseline.ts` | BARU | 146 |
| `src/lib/queries/historical.ts` | M | 124 → 130 |
| `src/lib/queries/item-trend.ts` | M | 250 → 253 |
| `src/lib/queries/pareto/historical.ts` | M | 99 → 108 |
