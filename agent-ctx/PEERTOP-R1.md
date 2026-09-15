# PEERTOP-R1 — Revisi kolom "Top Items Across Peers" + PDF 8.3 (feedback user)

**Task ID:** PEERTOP-R1
**Agent:** Main (Z.ai Code) — eksekusi langsung tanpa subagent (kontrak data saling terkait ketat lintas query→route→FE→PDF; satu penulis mencegah drift kontrak)
**Baseline:** `bdb7567` (= origin/main, PEERTOP sudah ter-push) → hasil: `acc4f4d` (ter-push)

## Permintaan user (verbatim)

1. "RANK DI TARGET ganti jadi Rangking Resto di antara Resto yang Selevel per Item"
2. "TOP DI ganti jadi Nama Resto nya & TOP Di"
3. "Hapus 8.4 Top Item per Resto Setara (masing-masing sampai 5 item) di laporan PDF"
4. "8.3 Top Item Resto Setara tambah juga kolom Kuantiti deviasi nilai asli"
5. "RATA-RATA ABSOLUTE RESTO SETARA pada 8.3 top item ini pakai kuantiti deviasi aja diabsolute"
6. "ARAH gak perlu kolom ini hapus aja. langsung aja jika nilai minus merah"

## Keputusan desain

- **Semantik ranking baru**: `RANK() OVER (PARTITION BY itemId ORDER BY SUM(absNominal) DESC)` pada CTE `outlet_item_aggs` — peringkat absNominal item target di antara SEMUA outlet band yang mencatat deviasi item itu (window dievaluasi SETELAH GROUP BY, jadi partisi per key grup valid; final SELECT yang memfilter `isTarget OR rn<=topN` tidak memengaruhi nilai window). Denominator = `COUNT(*) OVER (PARTITION BY itemId)` (termasuk target). Ties berbagi rank (semantik RANK standar). Ditampilkan "#3/9". `rank` lama (peringkat di top list resto sendiri) TETAP dikembalikan API untuk styling bold/muted nominal — hanya tidak dirender sebagai kolom.
- **"Top di" = nama resto**: FE memetakan `peerTopCodes` → nama via `perPeer` (truncate + tooltip penuh; '—' = khusus target). PDF: `"m resto: nama, nama"` (left-align → wrap otomatis oleh engine AUTO-FIT). Data-fetcher PDF memetakan kode→nama via peta `perPeer` (peer yang membawa item di top-N pasti punya entri perPeer).
- **QTY Deviasi nilai asli**: `SUM(qtyDeviasi)` signed; NULL (item tanpa catatan qty) → kontrak `number | null` → render '—'. Minus → merah (FE `text-red-600`; PDF `cellColor` → `C.danger`, konvensi yang sama dengan `rowText('-')` di 8.1). Nominal Target tetap ABSOLUTE (user tidak minta diubah; arah sekarang dibaca dari tanda qty).
- **Rata-rata Absolute = |kuantiti deviasi|**: `COALESCE(SUM(ABS(qtyDeviasi)),0)` diakumulasi per peer pembawa top-N → avg. `peerAvgAbsNominal` DIHAPUS dari kontrak (YAGNI; git menyimpan sejarah). Label "Rata-Rata Absolute" dipertahankan (nama kolom yang dirujuk user), basis |qty| dieja eksplisit: FE header "(QTY)", PDF header "(QTY Deviasi)" + definisi di InfoTooltip/komentar.
- **8.4 dihapus dari PDF** — `PeerTopItemOutletRow` + field `peerTopItems` dihapus dari services/types + data-fetcher; expand-row FE TIDAK disentuh (user hanya menyebut PDF). `perPeer` tetap dihasilkan query (dipakai FE + peta nama PDF).
- **Cache**: `cachedSharedQuery 'q-peer-topitems'` sv 1→2 (row shape berubah — kunci baru, entri lama tak terlayani). Route API `/api/peer-comparison/top-items` tidak di-bump (TTL 5 mnt membatasi staleness — pola yang sama diterima pada fix definisi f927969).
- **MASTER_CONTEXT**: route top-items ternyata belum terdokumentasi (tertinggal saat PEERTOP) — ditambahkan + stats disegarkan (35/36 Zod, 21 prefix cache, 32 maxDuration) + catatan revisi R1.

## File yang diubah (7)

| File | Perubahan |
|---|---|
| `src/lib/queries/outlets/peer-top-items.ts` | SQL +qtyDev/absQty/itemRank/itemOutletCount (window RANK/COUNT); kontrak union baru; grouping JS (peerAbsQtySum, target tanpa direction) |
| `src/components/dashboard/peer-comparison/types.ts` | Mirror client-safe kontrak baru |
| `src/components/dashboard/peer-comparison/top-items-card.tsx` | Kolom: Item · Top di (nama) · Ranking … per Item (#3/9) · Nominal (Target) · QTY Deviasi (minus merah) · Rata-Rata Absolute (QTY); Dir dihapus; header tinggi fleksibel (label panjang wrap) |
| `src/app/api/export-report/services/types.ts` | `PeerTopItemRow` baru (+peerTopNames, +peerAvgAbsQty, target baru); `PeerTopItemOutletRow` + `peerTopItems` dihapus |
| `src/app/api/export-report/services/data-fetcher/peer.ts` | Peta kode→nama; mapping row baru; sv:2; blok 8.4 dihapus |
| `src/app/api/export-report/services/pdf/sections/peer.ts` | 8.3 revisi (7 kolom, header Ranking wrap:true, cellColor minus→merah); 8.4 dihapus total |
| `MASTER_CONTEXT.md` | Route spec top-items + revisi R1 + stats |

Tidak diubah: route API (thin shell lolos tanpa edit), `use-peer-queries.ts`, `index.tsx` (prop `totalPeers` tetap — kini dipakai subtitle), expand-row `peer-table-card.tsx`, `validation.ts`, semua test.

## Verifikasi

- `bunx tsc --noEmit --incremental false` → **0 error**
- `bun run lint` → **0 error / 377 warning** (= baseline pasca-PEERTOP)
- `bunx vitest run` → **512/512 PASS** (0 test diedit; memang belum ada test yang menyentuh kontrak PEERTOP)
- Secret-scan staged diff (ghp_/github_pat_/password/secret/api_key/sk-/postgres URL) → **CLEAN**
- Push `bdb7567..acc4f4d` → origin/main ✓
- CATATAN: verifikasi statis (DB produksi tak terjangkau dari sandbox) — perilaku runtime SQL (window RANK) + render PDF perlu dicek saat data live. SQL window-after-GROUP BY adalah konstruksi Postgres standar; `itemRank` hanya dibaca dari baris target sehingga filter `rn<=topN` peer tidak memengaruhi nilainya.
