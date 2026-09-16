// ============================================================
//  8 — RESTO DENGAN PENJUALAN KURANG LEBIH SAMA  (REFINE-1 — NEW;
//       REFINE-3: was 7)
//  --------------------------------------------------------
//  User: "Tambahkan section Peer to Peer tapi ganti istilah nya menjadi
//  'Dengan Total Penjualan yang kurang lebih sama Resto lain menghasilkan
//  nominal deviasi ini dan ada break down per item nya berapa secara
//  kuantiti, % to bom'".
//  8.1 = the similar-sales restos and the nominal deviations they produce
//  (peer band = sales within ±10% of the target — same-period mode).
//  8.2 = the per-item breakdown for the target's top items: kuantitas +
//        % to BOM, vs the peer average.
//  8.3 (PEERTOP, revised PEERTOP-R1 + PEERTOP-R2) = the cross-peer union
//        of top items — which items are a SHARED top item at many resto
//        setara (bersama) vs only at the target (khusus), plus target
//        blind spots (top at peers, absent at the target → rank cell
//        "—").
//        PEERTOP-R2 (user): "Ganti istilah target jadi nama resto target
//        itu sendiri" — every header that referenced the generic "target"
//        now carries the outlet's own NAME ("Rangking KWGGAL", "Nominal
//        KWGGAL", "QTY Deviasi (KWGGAL)", 8.2's "QTY Deviasi (KWGGAL)"
//        / "% Deviasi To BOM (KWGGAL)" — user example: "QTY DEVIASI
//        (SBMOTI) jadi ada nama resto nya langsung"); the subhead became
//        the user's wording "Item di Resto lain (yang setara penjualan
//        KWGGAL) jika dilihat dari TOP Item nya"; and "Top di" shows
//        the TOP-3 resto names by |nominal deviasi| of the item (user:
//        "TOP DI ini isi top 3 aja resto aja dan jika resto target
//        termasuk masukan juga") — the target's name appears exactly
//        when it ranks among the top 3.
//  8.4 was REMOVED in PEERTOP-R1 (user: "Hapus 8.4 Top Item per Resto
//        Setara (masing-masing sampai 5 item) di laporan PDF") — the FE
//        Peer Table expand-row keeps the per-outlet view.
//  SALES SECRECY: no sales nominal is ever printed here.
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { C } from '../pdf-primitives';
import { negColor } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawPeerSection(env: SectionEnv): void {
  const { rpt, data, hasSection } = env;
  if (!hasSection('peer')) return;
  rpt.sectionHeader(8, 'Resto dengan Penjualan Kurang Lebih Sama');
  const pc = data.peerComparison;
  if (!pc || pc.peers.length === 0) {
    rpt.noteBox('Data pembanding tidak tersedia untuk filter ini \u2014 pilih satu resto pada Filter Resto (tab Resto Analysis) lalu export ulang.');
    return;
  }
  const targetLabel = `${pc.targetOutlet.name} (${pc.targetOutlet.code})`;
  // PEERTOP-R2 (user: "Ganti istilah target jadi nama resto target itu
  // sendiri ... Misal aku lagi filter kwggal berarti pakai nama kwggal
  // aja daripada Resto"): every 8.x header/subhead that referenced the
  // generic "target" carries the outlet's own NAME instead — short form
  // (no code) so the headers stay narrow.
  const tn = pc.targetOutlet.name;
  // 8.1 — peers' nominal deviations, biggest first; the target row is
  // bold (named in the subhead — factual, no legend needed).
  // PEERTOP-R2: the subhead uses the outlet's NAME only (no code — the
  // 8.1 table rows carry "KWGGAL (1042.KWGGAL)" anyway) + a compact
  // auto-target note, so it renders at full size (the old code-label +
  // note combo overflowed the page width — see SUBHEAD-FIT).
  const sortedPeers = [...pc.peers].sort((a, b) => Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi));
  rpt.subhead(`8.1 Nominal Deviasi per Resto (penjualan kurang lebih sama dengan ${tn}${pc.autoTarget ? ' \u2014 terpilih otomatis (deviasi terbesar)' : ''})`, { size: 8.5 });
  rpt.table({
    cols: [
      { header: '#', align: 'center' },
      { header: 'Resto' },
      { header: 'Area' },
      { header: 'Nominal Deviasi', align: 'right' },
      { header: '% Deviasi To BOM', align: 'right' },
      { header: 'QTY Deviasi', align: 'right' },
    ],
    rows: sortedPeers.map((p, i) => [
      String(i + 1),
      `${p.outletName} (${p.outletCode})`,
      p.area,
      fmtIDR(p.nominalDeviasi),
      fmtPct(p.devBom, false),
      fmtNum(p.qtyDeviasi),
    ]),
    rowBold: (_row, i) => sortedPeers[i]?.isTarget ?? false,
    rowText: (row) => (row[3].startsWith('-') ? C.danger : undefined),
  });

  // 8.2 — per-item breakdown: kuantitas + % to BOM, target vs the
  // average of the similar-sales restos.
  // REFINE-4 (user: "jangan pakai istilah peer tapi coba pakai yang
  // lebih mudah. Misalnya resto dengan omzet yang tidak beda jauh"):
  // "Rata-rata … Peer" headers → "Rata-rata … Resto Setara" (the
  // section title "Resto dengan Penjualan Kurang Lebih Sama" defines
  // what "setara" means; the subhead spells it out in the user's own
  // words — omzet tidak jauh berbeda).
  if (pc.items.length > 0) {
    rpt.subhead(`8.2 Breakdown per Item (kuantitas, % to BOM) \u2014 ${targetLabel} vs rata-rata resto dengan omzet tidak jauh berbeda`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: 'Item' },
        // REFINE-2 ("section yang belum punya satuan tambahain"): unit of
        // measure per item — the QTY columns are satuan-denominated.
        { header: 'Satuan' },
        // PEERTOP-R2 (user: "QTY DEVIASI (SBMOTI) jadi ada nama resto nya
        // langsung"): target-owned columns carry the outlet's NAME so
        // whose numbers they are is explicit.
        { header: `QTY Deviasi (${tn})`, align: 'right' },
        { header: `% Deviasi To BOM (${tn})`, align: 'right' },
        { header: 'Rata-rata QTY Resto Setara', align: 'right' },
        { header: 'Rata-rata % Dev/BOM Resto Setara', align: 'right' },
      ],
      rows: pc.items.map((it) => [
        it.itemName,
        it.satuan ?? '\u2014',
        fmtNum(it.target.qtyDeviasi),
        fmtPct(it.target.devBom, false),
        it.peerAvg != null ? fmtNum(it.peerAvg.qtyDeviasi) : '\u2014',
        it.peerAvg != null ? fmtPct(it.peerAvg.devBom, false) : '\u2014',
      ]),
      // PDFCOLOR-1 (user: "terkait minus atau penurunan harusnya warna
      // merah"): the QTY Deviasi columns print SIGNED SUM(qtyDeviasi)
      // (target AND peer average — both sides can sit on the loss side).
      // They were neutral ink while 8.3's identically-named "QTY Deviasi
      // (<tn>)" column was already minus-red (PEERTOP-R1: "langsung aja
      // jika nilai minus merah") — an intra-section contradiction.
      // The % Dev/BOM columns are ABS/ABS — negColor is a no-op there.
      cellColor: (row, _ri, ci) => (ci >= 2 && ci <= 5 ? negColor(row[ci]) : undefined),
    });
  }

  // 8.3 — PEERTOP (user: "tambahkan top item tiap resto setara ke section
  // peer DAN PDF"), revised PEERTOP-R1 per user feedback, re-titled
  // PEERTOP-R2 (user: "8.3 Item di Resto lain (yang setara penjualan Resto
  // Target) jika dilihat dari TOP Item nya" — with "Resto Target" itself
  // replaced by the outlet's name per the same feedback). The cross-peer
  // union — items that are top at MANY resto setara (bersama) vs top only
  // at the target (khusus). Rows are server-sorted (peerTopCount desc →
  // target absNominal desc → …), so they render in arrival order; the
  // target is a COLUMN here, not a row (no rowBold). Same guard style as
  // 8.2. Column notes (PEERTOP-R2):
  //   - "Top di": the TOP-3 resto NAMES by |nominal deviasi| of the item
  //     (target included when it ranks among them — user: "TOP DI ini isi
  //     top 3 aja resto aja dan jika resto target termasuk masukan
  //     juga"); the cell text WRAPS (left-aligned col → pdf-primitives
  //     isWrap); '—' = top nowhere in the band (defensive — cannot happen
  //     with union rows).
  //     PEERTOP-R3 (user: "ada bug di rangking. misal resto target 11/11
  //     tapi juga muncul di top di"): topDiNames now arrives on the SAME
  //     RANK() basis as the "Rangking" column (itemRank <= 3 among ALL
  //     band outlets recording the item) — the target's name shows
  //     exactly when its itemRank <= 3, so "Top di" can never contradict
  //     "Rangking" (values are server pre-computed; rendering unchanged).
  //   - "Rangking <nama>": #peringkat/total — the user's replacement for
  //     the old long header (user: "RANKING RESTO DI ANTARA RESTO YANG
  //     SELEVEL PER ITEM ganti jadi Rangking (Nama Resto Langsung)").
  //   - "QTY Deviasi (<nama>)": signed "nilai asli" — negative → C.danger
  //     (the Arah column was REMOVED in R1; direction rides on the sign).
  //   - "Rata-rata Absolute …": |kuantiti deviasi| basis — wrap: true so
  //     the (QTY Deviasi) suffix never blows the column width.
  if (pc.topItems && pc.topItems.length > 0) {
    const topItems = pc.topItems;
    rpt.subhead(`8.3 Item di Resto lain (yang setara penjualan ${tn}) jika dilihat dari TOP Item nya`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Top di' },
        { header: `Rangking ${tn}`, align: 'center' },
        { header: `Nominal ${tn}`, align: 'right' },
        { header: `QTY Deviasi (${tn})`, align: 'right' },
        { header: 'Rata-rata Absolute Resto Setara (QTY Deviasi)', align: 'right', wrap: true },
      ],
      rows: topItems.map((it, i) => [
        String(i + 1),
        it.itemName,
        // PEERTOP-R2: top-3 resto names by |nominal| of THIS item — the
        // target's own name appears when it ranks among the top 3 (the
        // query pre-computes the list; ties broken deterministically).
        // PEERTOP-R3: the list is computed on the SAME itemRank basis as
        // the "Rangking" cell (itemRank <= 3 among ALL band outlets
        // recording the item) — the two columns can never contradict
        // (bug fix: a #11/11 target used to appear here).
        it.topDiNames.length > 0 ? it.topDiNames.join(', ') : '\u2014',
        it.target == null ? '\u2014' : `#${it.target.itemRank}/${it.target.itemOutletCount}`,
        fmtIDR(it.target?.absNominal),
        it.target?.qtyDeviasi == null ? '\u2014' : fmtNum(it.target.qtyDeviasi),
        it.peerTopCount > 0 ? fmtNum(it.peerAvgAbsQty) : '\u2014',
      ]),
      // PEERTOP-R1 (user: "ARAH gak perlu kolom ini hapus aja. langsung aja
      // jika nilai minus merah"): negative QTY Deviasi (kekurangan side)
      // prints red — same convention as 8.1's rowText('-') rule. The
      // Nominal column stays neutral (ABSOLUTE magnitude).
      cellColor: (_row, ri, ci) => {
        if (ci !== 5) return undefined;
        const q = topItems[ri]?.target?.qtyDeviasi;
        return q != null && q < 0 ? C.danger : undefined;
      },
    });
  }
}
