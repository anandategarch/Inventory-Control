# MERGE-1-a — Merge peer-reference SQL 3→1 (audit A1, pure refactor)

Task ID: MERGE-1-a
Agent: full-stack-developer (Z.ai Code)
Scope: Bagian 1 — ekstrak predikat bucket ±50% jadi modul shared; Bagian 2 — pindahkan SQL inline `/api/peer-comparison/items` ke modul query. ZERO behavior change.
Baseline saat mulai: HEAD cd3f1e7 (NAVLINK-1), working tree bersih, tsc 0 · vitest 473/473 · eslint 0 (baseline diverifikasi ulang via git worktree HEAD di akhir sesi).

## Pemetaan konsumen (SEBELUM memotong — instruksi gerbang)

`rg -n "peer-comparison/items|item-peer-comparison|by-deviasi-rank|shared-cte" tests/ src/`:
- `src/app/api/item-peer-comparison/route.ts` import `@/lib/queries/items/item-peer-comparison` → path TETAP HIDUP (file diedit in-place, tidak dipindah).
- `src/lib/queries/items/top-items/by-deviasi-rank.ts` di-`export *` via barrel `top-items/index.ts` → diedit in-place, surface barrel tak berubah.
- TIDAK ADA test yang import route `/api/peer-comparison/items` maupun modul-modul ini (rg di tests/ = 0 hit; hanya `src/lib/validation.ts` punya schema-nya). `computePeerComparisonItems` hanya direferensikan route.ts sendiri.
- `shared-cte.ts` TIDAK mengandung predikat bucket (hanya `buildDeviasiRankBaseCte` — CTE agregat + ranked; bucket_avg hidup di by-deviasi-rank.ts ×2) → **file tidak diubah**; pola komposisinya (Prisma.raw identifier + interpolasi Sql nested) dipelajari sebagai referensi, sesuai catatan task.
- Konvensi route sibling `/api/peer-comparison/route.ts`: import query via barrel `@/lib/queries`, cache key + withCacheAndDedup + envelope di route, `type X = Awaited<ReturnType<typeof queryX>>` untuk generic cache.

## Bagian 1 — peer-bucket.ts (fragment shared ±50%)

File BARU `src/lib/queries/items/peer-bucket.ts` (81 baris, mengikuti precedent H-12 `item-outlet-breakdown.ts`):
- `peerBomBucketPredicate(targetAlias, candidateAlias): Prisma.Sql` → `ABS(<candidate>."qtyBom") BETWEEN ABS(<target>."qtyBom") * 0.5 AND ABS(<target>."qtyBom") * 1.5`
- Konstanta `PEER_BOM_BUCKET_PCT = 0.5` + `PEER_BOM_BUCKET_UPPER = 1.5` — di-render sebagai SQL LITERAL via `Prisma.raw(String(const))`, BUKAN bind parameter (`${0.5}` di Prisma.sql → `$1` — nilai sama, teks SQL beda). Ini menjamin teks SQL identik dengan kode lama SEKALIGUS mengikat konstanta ke SQL (tak bisa drift).
- Alias via `Prisma.raw` — identifier statis milik call site ('t'/'c', 'ti'/'ipo2'), konvensi sama dengan shared-cte.ts `Prisma.raw(opts.firstCteName)`.
- Guard `ABS(...qtyBom) > 0` (FIX CALC-7) TIDAK dimasukkan fragment — penempatannya berbeda di 2 konsumen (konjungsi WHERE vs JOIN ON) dan task menyebut "hanya predikat bucket yang diganti sumbernya". Header modul + JSDoc memperingatkan call site baru agar tidak membuang guard.

Refactor konsumen (hanya sumber predikat BETWEEN yang diganti — guard, urutan, join, aggregate, komentar FIX CALC-7 semua tetap):
1. `item-peer-comparison.ts` final SELECT WHERE (437 → 439 baris; +9/−7): `AND ABS(c."qtyBom") BETWEEN ABS(t."qtyBom") * 0.5 … AND … * 1.5` → `AND ${peerBomBucketPredicate('t', 'c')}`. Dua blok komentar yang tadinya menyebut duplikasi ("same bucket logic as bucket_avg CTE") diarahkan ke modul shared (comment-only).
2. `by-deviasi-rank.ts` bucket_avg CTE ×2 (272 → 273 baris; +3/−2): `AND ABS(ipo2."qtyBom") BETWEEN ABS(ti."qtyBom") * 0.5 AND ABS(ti."qtyBom") * 1.5` → `AND ${peerBomBucketPredicate('ti', 'ipo2')}` (national `item_per_outlet` + per-outlet `all_item_per_outlet`).

### Bukti ekuivalensi SQL (verifikasi empiris, bukan sekadar review)
Script bun throwaway (dihapus setelah dipakai) me-render fragment + komposisi template persis seperti 2 call site:
- Fragment `peerBomBucketPredicate('t','c')` → `{"values":[],"strings":["ABS(c.\"qtyBom\") BETWEEN ABS(t.\"qtyBom\") * 0.5 AND ABS(t.\"qtyBom\") * 1.5"]}` — **0 bind param, teks identik karakter-demi-karakter**.
- Komposisi by-deviasi-rank → `… AND ABS(ipo2."qtyBom") BETWEEN ABS(ti."qtyBom") * 0.5 AND ABS(ti."qtyBom") * 1.5` — **identik** dengan baris lama.
- Komposisi item-peer-comparison → satu baris `… AND ABS(c."qtyBom") BETWEEN ABS(t."qtyBom") * 0.5 AND ABS(t."qtyBom") * 1.5` — ekuivalen semantik dengan bentuk multi-baris lama (beda whitespace saja; SQL whitespace-insignificant).

## Bagian 2 — SQL inline route → queries/outlets/peer-comparison-items.ts

File BARU `src/lib/queries/outlets/peer-comparison-items.ts` (276 baris, kolokasi dengan `peer-comparison.ts`):
- `queryPeerComparisonItems(outletCode, month, week, mode, topItems, kelompok?)` — parameter posisi eksplisit MENIRU sibling `queryPeerComparison` (outlets/peer-comparison.ts): bentuk paling alami di kode existing; JSDoc mendokumentasikan tiap param + kontrak.
- SELURUH pipeline SQL multi-CTE (sales_mode → target → peer_outlets → target_top_items → CROSS JOIN + LEFT JOIN InventoryRecord → GROUP BY/ORDER BY) + koersi BigInt + grouping Map + peerAvg/peerBest/gap dipindah **verbatim**.
- Tipe `PeerOutletEntry` + `GroupedItem` ikut pindah dan kini di-`export` (dipakai return type query; kontrak JSON frontend `ItemComparisonResponse` di components/dashboard/peer-comparison/types.ts tidak berubah). `PeerItemsComputeParams` (internal route, tidak pernah diimport siapa pun) dibubarkan karena parameter kini posisi.
- Semua marker/komentar FIX terjaga: BUG2-RESTO-1 / FIX-P1-PEER-1 (kelompok scope peer), BUG-2-b / BUG-1-c (poisoning guard doc), P3-HYG-3, DB-06, AUDIT8-ROLLBACK-1 (withStatementTimeout), komentar guard `if (!item) continue`.

`src/app/api/peer-comparison/items/route.ts` jadi tipis (340 → 110 baris; +9/−239):
- Tetap di route: rate limit, Zod `peerComparisonItemsQuerySchema`, parsing + normalisasi 'all' (kelompokParam, komentar BUG-2-b/BUG-1-c #3 utuh), resolusi month via `getMonthResolver`/`resolveMonthLabel`, **cache key building + withCacheAndDedup + envelope response + errorResponse** — pola persis sibling `/api/peer-comparison/route.ts`.
- Generic cache: `type PeerComparisonItemsData = Awaited<ReturnType<typeof queryPeerComparisonItems>>` (= `{ items: GroupedItem[] }`, sama dengan anotasi lama) — pola sibling.
- Import yang dibersihkan (semuanya TIDAK terpakai di route setelah pindah, dibuktikan tsc tetap 0): `Prisma`, `db`, `buildSqlFilters`, `withStatementTimeout`.

`src/lib/queries/index.ts` (+3 baris): `export * from './outlets/peer-comparison-items'` ditambahkan ke barrel — route meng-import via `@/lib/queries` seperti sibling. Cek tabrakan nama dulu: GroupedItem/PeerOutletEntry/queryPeerComparisonItems unik di seluruh src/ (rg). `peer-bucket.ts` SENGAJA tidak masuk barrel mana pun (internal items/*, seperti shared-cte.ts).

`ARCHITECTURE.md` (1 baris): entri #16 `/api/peer-comparison/items` di-update dari "compute di-ekstrak ke computePeerComparisonItems" → "compute di queryPeerComparisonItems — src/lib/queries/outlets/peer-comparison-items.ts sejak MERGE-1-a". Doc-sync 1 baris agar tidak ada referensi mati ke nama fungsi lama.

### Bukti pure-move Bagian 2 (verifikasi mekanis)
- Body fungsi lama (route.ts 147–340, termasuk seluruh SQL template + post-processing) di-diff vs body fungsi baru (peer-comparison-items.ts 83–275) → **satu-satunya beda = tanda `}` penutup fungsi** (artefak batas range ekstraksi); 194 baris lain BYTE-IDENTIK.
- Interface `PeerOutletEntry`+`GroupedItem` di-diff (normalisasi prefix `export `) → IDENTIK.
- Insertion diff route = hanya: ganti 3 import (Prisma/db/queries-shared → queryPeerComparisonItems) + 2 baris generic cache + komentar banner MERGE-1-a.

## Gerbang (semua dijalankan SETELAH semua edit; hasil)

| Gerbang | Hasil |
|---|---|
| `bunx tsc --noEmit` | **0 error** |
| `bun run test` | **473/473 passed** (27 file; `git status tests/` kosong — 0 test berubah) |
| `bunx eslint src/lib/queries/items/peer-bucket.ts src/lib/queries/items/item-peer-comparison.ts src/lib/queries/items/top-items/ src/lib/queries/outlets/peer-comparison-items.ts src/app/api/peer-comparison/items/route.ts` (+ barrel index.ts) | **0 error, 0 warning**. Baseline HEAD di git worktree untuk file-file lama yang sama = juga 0 warning → tidak ada warning yang berpindah (memang tidak ada). Satu-satunya output = notice browserslist (bukan temuan eslint). |
| `git diff --stat` | 5 modified + 2 new, semuanya scope task: ARCHITECTURE.md (1) · route.ts (+9/−239) · queries/index.ts (+3) · item-peer-comparison.ts (+9/−7) · by-deviasi-rank.ts (+3/−2) · peer-bucket.ts (81, new) · peer-comparison-items.ts (276, new). tests/ bersih. |

## Keputusan desain & penyimpangan dari spek
1. **Bounds via `Prisma.raw(String(const))`, bukan interpolasi angka** — interpolasi `${0.5}` pada Prisma.sql menghasilkan bind parameter `$n`, mengubah teks SQL (meski nilainya sama). Literal menjaga SQL identik + konstanta tetap terikat.
2. **Guard >0 tidak ikut fragment** — sesuai batasan "hanya predikat bucket yang diganti sumbernya" + guard berbeda penempatan (WHERE vs JOIN ON) dan berbeda urutan + komentar antar file. Didokumentasikan eksplisit di header/JSDoc modul.
3. **Nama fungsi & parameter posisi** `queryPeerComparisonItems(outletCode, month, week, mode, topItems, kelompok?)` meniru sibling `queryPeerComparison` (pola paling alami di kode existing; route sibling juga memanggilnya posisi).
4. **Barrel**: modul query baru masuk barrel `@/lib/queries` (pola import route sibling); `peer-bucket.ts` internal (tidak di-export publik, seperti shared-cte.ts).
5. **shared-cte.ts TIDAK diubah** — task menyebut "bucket_avg CTE di by-deviasi-rank.ts/shared-cte.ts", namun predikat bucket memang tidak ada di shared-cte.ts (satu-satunya bucket logic di sana adalah kolom `absQtyDeviasi` yang dikonsumsi bucket_avg). File hanya dipakai sebagai referensi pola komposisi.
6. **1 baris doc-sync ARCHITECTURE.md** — di luar daftar file eksplisit spek, dilakukan karena baris itu menyebut nama fungsi lama (akan jadi referensi mati). Mudah di-revert bila Main ingin scope murni kode.
7. Import `db`/`buildSqlFilters`/`Prisma` yang tidak terpakai dihapus dari route (sebelumnya unused import). Bukan perubahan perilaku — tsc/eslint tetap hijau.

## Status
- TIDAK commit / TIDAK push (protokol PAT — Main yang commit).
- Marker NAVLINK-1 (field `code` top-growth / outletCode bom-correlation) tidak tersentuh — tidak ada di file-file scope ini.
