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
//  8.3 (PEERTOP, revised PEERTOP-R1) = the cross-peer union of top items
//        — which items are a SHARED top item at many resto setara
//        (bersama) vs only at the target (khusus), plus target blind
//        spots (top at peers, absent at the target → rank cell "—").
//        PEERTOP-R1 columns: "Top di" = NAMA resto setara (user: "TOP DI
//        ganti jadi Nama Resto nya & TOP Di"); "Ranking Resto di antara
//        Resto yang Selevel per Item" = #peringkat/total (user wording
//        verbatim); "QTY Deviasi" = kuantiti deviasi NILAI ASLI (signed;
//        minus = kekurangan → merah — user: "ARAH gak perlu kolom ini
//        hapus aja. langsung aja jika nilai minus merah"); "Rata-rata
//        Absolute Resto Setara" = rata-rata |kuantiti deviasi| (user:
//        "pakai kuantiti deviasi aja diabsolute").
//  8.4 was REMOVED in PEERTOP-R1 (user: "Hapus 8.4 Top Item per Resto
//        Setara (masing-masing sampai 5 item) di laporan PDF") — the FE
//        Peer Table expand-row keeps the per-outlet view.
//  SALES SECRECY: no sales nominal is ever printed here.
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { C } from '../pdf-primitives';
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
  // 8.1 — peers' nominal deviations, biggest first; the target row is
  // bold (named in the subhead — factual, no legend needed).
  const sortedPeers = [...pc.peers].sort((a, b) => Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi));
  rpt.subhead(`8.1 Nominal Deviasi per Resto (penjualan kurang lebih sama dengan ${targetLabel}${pc.autoTarget ? ' \u2014 target otomatis: resto deviasi terbesar' : ''})`, { size: 8.5 });
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
        { header: 'QTY Deviasi', align: 'right' },
        { header: '% Deviasi To BOM', align: 'right' },
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
    });
  }

  // 8.3 — PEERTOP (user: "tambahkan top item tiap resto setara ke section
  // peer DAN PDF"), revised PEERTOP-R1 per user feedback: the cross-peer
  // union — items that are top at MANY resto setara (bersama) vs top only
  // at the target (khusus). Rows are server-sorted (peerTopCount desc →
  // target absNominal desc → …), so they render in arrival order; the
  // target is a COLUMN here, not a row (no rowBold). Same guard style as
  // 8.2. Column notes:
  //   - "Top di": NAMA resto setara (was "m dari n resto setara") — the
  //     cell text WRAPS (left-aligned col → pdf-primitives isWrap).
  //   - "Ranking … per Item": #peringkat/total — the long header wraps
  //     (wrap: true beats the right/center non-wrap default).
  //   - "QTY Deviasi": signed "nilai asli" — negative → C.danger (the
  //     Arah column was REMOVED; direction rides on the sign).
  //   - "Rata-rata Absolute …": |kuantiti deviasi| basis — wrap: true so
  //     the (QTY Deviasi) suffix never blows the column width.
  if (pc.topItems && pc.topItems.length > 0) {
    const topItems = pc.topItems;
    rpt.subhead(`8.3 Top Item Resto Setara \u2014 bersama vs khusus (top item = jumlah |nominal deviasi| per item; resto setara = penjualan \u00b110%)`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Top di' },
        // PEERTOP-R1 user label, verbatim: "Rangking Resto di antara Resto
        // yang Selevel per Item" (cells "#3/9" = peringkat di antara resto
        // selevel yang mencatat deviasi item ini, urut |nominal| terbesar).
        { header: 'Ranking Resto di antara Resto yang Selevel per Item', align: 'center', wrap: true },
        { header: 'Nominal Target', align: 'right' },
        // PEERTOP-R1: kuantiti deviasi NILAI ASLI (signed) — replaces the
        // Arah column; minus = kekurangan → merah (cellColor below).
        { header: 'QTY Deviasi', align: 'right' },
        // REFINE-4/master context: the average is on the ABSOLUTE basis —
        // the header must say "Rata-rata Absolute" (PEERTOP-R1: the basis
        // is |kuantiti deviasi| per user request — spelled out inline).
        { header: 'Rata-rata Absolute Resto Setara (QTY Deviasi)', align: 'right', wrap: true },
      ],
      rows: topItems.map((it, i) => [
        String(i + 1),
        it.itemName,
        // PEERTOP-R1: NAMA resto setara where the item is top (count kept
        // as the prefix — "bersama" degree; '—' = khusus resto target).
        it.peerTopCount > 0 ? `${it.peerTopCount} resto: ${it.peerTopNames.join(', ')}` : '\u2014',
        it.target == null ? '\u2014' : `#${it.target.itemRank}/${it.target.itemOutletCount}`,
        fmtIDR(it.target?.absNominal),
        it.target?.qtyDeviasi == null ? '\u2014' : fmtNum(it.target.qtyDeviasi),
        it.peerTopCount > 0 ? fmtNum(it.peerAvgAbsQty) : '\u2014',
      ]),
      // PEERTOP-R1 (user: "ARAH gak perlu kolom ini hapus aja. langsung aja
      // jika nilai minus merah"): negative QTY Deviasi (kekurangan side)
      // prints red — same convention as 8.1's rowText('-') rule. The
      // Nominal Target column stays neutral (ABSOLUTE magnitude).
      cellColor: (_row, ri, ci) => {
        if (ci !== 5) return undefined;
        const q = topItems[ri]?.target?.qtyDeviasi;
        return q != null && q < 0 ? C.danger : undefined;
      },
    });
  }
}
