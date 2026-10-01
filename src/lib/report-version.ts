// ============================================================
//  report-version — PDF report design version (`rv`)
//  --------------------------------------------------------
//  GODSPLIT-W2-A: single source of truth untuk rv — sebelumnya
//  disalin manual di useDashboardActions.ts (client) +
//  export-report/route.ts (server cache key).
//
//  `rv` forks BOTH cache layers on every report design change:
//    • Client — URL param `?rv=` (useDashboardActions handleExport):
//      busts the CDN/edge cache. Ignored server-side (Zod strips
//      unknown params); its only job is a fresh URL.
//    • Server — cache-key `extra.rv` (/api/export-report route):
//      forks the SWR/DB cache namespace (swr.ts 3b serves EXPIRED
//      rows unbounded, so a forgotten bump = a pre-deploy PDF served
//      forever under the old key — see the STALE-PDF note there).
//  Bump this ONE const and both layers fork together — the old
//  two-site "keep in sync" ritual (and its missed-bump incidents,
//  see the changelog below) is gone for good.
//
//  Import-safe from BOTH client components and server routes —
//  pure constants only, no server-only imports.
// ============================================================

/**
 * Current PDF report design version. String on purpose: it is spliced
 * verbatim into the export URL param and the server cache-key `extra`
 * (both were the literal '15' before GODSPLIT-W2-A) — both sites must
 * keep producing the identical string.
 */
export const REPORT_DESIGN_VERSION = '16';

// ============================================================
//  rv changelog — full history (GODSPLIT-W2-A moved it here so the
//  two former in-file copies die together with the manual sync).
//  Entries are verbatim from those copies; the trailing "Keep in sync
//  with the rv extra in /api/export-report" sentences are dropped
//  (the sync is now this module). PDFCOLOR-8 and the VAR12 scope note
//  existed only in the old export-report/route.ts copy.
// ============================================================
// REFINE-3: rv 5 — heat text fix, section 6 anomali, vs Rata-rata
// Area column, weekly composition + accumulation charts, renumbering.
// REFINE-4: rv 6 — Rata-rata Absolute + magnitude comparisons, 6.2
// flip detection, section 5 signed cells + abs heat, section 9
// per-pair grouping, 8.2 resto setara terms, plain-percent Selisih.
// HEAT-SIGN: rv 7 — section 5 heat cells encode the SIGN (red ramp =
// loss side, green ramp = surplus side; magnitude picks the step).
// PEERTOP/PEERTOP-R1: rv 8 — NEW PDF section 8.3 (Top Item Resto
// Setara — bersama vs khusus; Ranking Resto di antara Resto yang
// Selevel per Item; QTY Deviasi signed; Rata-rata Absolute |QTY|) +
// 8.4 removed. This bump was MISSING when PEERTOP landed — same URL
// hit the CDN's old cached response AND the server's stale SWR row
// (user: "kok di laporan PDF tidak ada perubahan?").
// PEERTOP-R2: rv 9 — 8.3 re-titled "Item di Resto lain (yang setara
// penjualan <nama resto>) jika dilihat dari TOP Item nya"; headers
// pakai NAMA resto (Rangking/Nominal/QTY Deviasi (KWGGAL), 8.2 juga);
// "Top di" = top-3 resto by |nominal|, target ikut bila termasuk.
// PEERTOP-R3: rv 10 — bug fix "Top di" (user: "misal resto target
// 11/11 tapi juga muncul di top di"): basis kini RANK() yang sama
// dengan kolom Rangking — target muncul di Top di persis ketika
// itemRank ≤ 3.
// BUGHUNT-Q1: rv 11 — "Rata-rata Historical" tabel 3.3-3.6 kini
// per-periode (SUM per periode lalu AVG, bukan AVG per baris mentah
// yang understated k× untuk multi-record per periode); angka kolom
// historis + persentase fmtVsHist berubah.
// PDFCOLOR-1: rv 12 — minus-RED on VALUE columns (user: "terkait
// minus atau penurunan harusnya warna merah"): KPI hero cards,
// current/previous columns of sections 1/2/7, 3.3-3.6 QTY columns,
// 4.1/4.2 nominal columns, 6.1/6.2 signed columns, 8.2 QTY columns
// (8.3 already was minus-red). The S7 trend table now agrees with
// its own red diverging bars. Render-only — no data change.
// PDFCOLOR-8: "Nominal Deviasi to Sales" change columns (S1/S2/
// cover) kini MAGNITUDE growth (calcGrowthAbs) — signed formula
// + goodUp=false membalik warna di sisi loss (rasio memburuk
// dicetak hijau ▼). Included in the same rv 12 bump.
// VAR10: rv 13 — tabel 4.1 Memburuk & 4.2 Membaik kini 10 item per
// sisi (was 5; user request). Data + render change (q-variance sv
// 2→3).
// VAR11: rv 14 — (a) chart "Akumulasi Mingguan — Total Deviasi" kini
// akumulasi SIGNED nominalDeviasi (user: "aku mau sum nilai asli /
// signed" — was absTotal magnitude); (b) section 9 Plus Minus kini
// re-ranked by pair BALANCE (disparityPct ASC — Net kecil, user:
// "harusnya selisih dikit") + q-flip-rank limit 10→200 (limit is in
// the cache key; sv stays 2).
// VAR12: rv 15 — section 6.3 "Analisis Pola Item (Massal / Regional /
// Lokal)" baru di PDF (user: "Analisis Pola item masukin juga ke pdf
// terutama bagian anomali item"; queryItemConsistency langsung — no
// new q-* namespace). (Penghapusan "Peluang Perbaikan (Rp)" +
// "Action Plan" adalah perubahan dashboard — bukan bagian cache PDF.)
// W10: rv 16 — NEW PDF section 5 "Analisis Waste" (atribusi loss W/S/T
// vs residual + skenario p HIPOTESIS + decile-shift + snapshot top waste
// dari q-topcat) + sat baris atribusi di ExecutiveStatus; tail renumbered
// (itemTrend 5→6, anomali 6→7, trend 7→8, peer 8→9, flip 9→10 — keys
// unchanged). Data + render change (new q-waste-network sv 1; q-topcat sv
// stays 2 — row shape unchanged, only the fetch gate widened).
// GODSPLIT-W2-A: bumping THIS ONE const forks both cache layers (the
// client's ?rv= param + the server cache-key extra import the SAME const
// — the old two-site "keep in sync" ritual IS this module).
