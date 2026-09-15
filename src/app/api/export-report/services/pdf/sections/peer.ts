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
//  8.3 (PEERTOP) = the cross-peer union of top items — which items are
//        a SHARED top item at many resto setara (bersama) vs only at the
//        target (khusus), plus target blind spots (top at peers, absent
//        at the target → rank cell "—").
//  8.4 (PEERTOP) = each resto setara's own top items, compact: one row
//        per outlet — the table engine WRAPS left-aligned cells
//        (pdf-primitives isWrap = wrap ?? align==='left'), so the joined
//        item list never overflows.
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
  // peer DAN PDF"): the cross-peer union — items that are top at MANY
  // resto setara (bersama) vs top only at the target (khusus). Rows are
  // server-sorted (peerTopCount desc → target absNominal desc → …), so
  // they render in arrival order; the target is a COLUMN here, not a row
  // (no rowBold). Same guard style as 8.2.
  if (pc.topItems && pc.topItems.length > 0) {
    const topItems = pc.topItems;
    // n = the non-target restos of the SAME band (pc.peers includes the
    // target row) — "m dari n resto setara".
    const peerBandN = pc.peers.filter((p) => !p.isTarget).length;
    // Must match the data-fetcher's queryPeerTopItems topN (5) — the
    // "≤ 5 = inside the top, > 5 = di luar top-N" rank cutoff.
    const TOP_N = 5;
    // No dedicated footnote helper exists in the section modules
    // (noteBox is for empty-data notes), so the definition line rides
    // in the subhead after an em-dash — REFINE-4 terminology ("resto
    // setara", never "peer").
    rpt.subhead(`8.3 Top Item Resto Setara \u2014 bersama vs khusus (top item = jumlah |nominal deviasi| per item; resto setara = penjualan \u00b110%)`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Top di', align: 'right' },
        { header: 'Rank di Target', align: 'right' },
        { header: 'Nominal Target', align: 'right' },
        // REFINE-4/master context: the average is on the ABSOLUTE basis —
        // the header must say "Rata-rata Absolute".
        { header: 'Rata-rata Absolute Resto Setara', align: 'right' },
        { header: 'Arah', align: 'center' },
      ],
      rows: topItems.map((it, i) => [
        String(i + 1),
        it.itemName,
        `${it.peerTopCount} dari ${peerBandN} resto setara`,
        it.target == null ? '\u2014' : it.target.rank <= TOP_N ? `#${it.target.rank}` : `> ${TOP_N}`,
        fmtIDR(it.target?.absNominal),
        it.peerTopCount > 0 ? fmtIDR(it.peerAvgAbsNominal) : '\u2014',
        it.target?.direction ?? '\u2014',
      ]),
      // Direction coloring on the Arah cell only (red = loss side,
      // green = surplus side — same per-cell convention as 6.2; the
      // Nominal Target column stays neutral because it is an ABSOLUTE
      // magnitude, and 8.1's rowText('-') rule never applies to it).
      cellColor: (_row, ri, ci) => {
        if (ci !== 6) return undefined;
        const d = topItems[ri]?.target?.direction;
        return d === 'LOSS' ? C.danger : d === 'SURPLUS' ? C.success : undefined;
      },
    });
  }

  // 8.4 — PEERTOP: each resto setara's own top items (target first, then
  // up to 5 non-target entries in the fetcher's sales-proximity order).
  // WRAP CHECK (pdf-primitives.table, FIX-TERPOTONG): left-aligned cells
  // wrap by default and are never ellipsized → COMPACT layout, one row
  // per outlet with the items joined into a single wrapping cell.
  if (pc.peerTopItems && pc.peerTopItems.length > 0) {
    const peerTopItems = pc.peerTopItems;
    const targetEntry = peerTopItems.find((p) => p.isTarget) ?? null;
    const ordered = [
      ...(targetEntry ? [targetEntry] : []),
      ...peerTopItems.filter((p) => !p.isTarget).slice(0, 5),
    ];
    rpt.subhead('8.4 Top Item per Resto Setara (masing-masing sampai 5 item)', { size: 8.5 });
    rpt.table({
      cols: [
        { header: 'Resto' },
        { header: 'Top Item (nominal, arah)' },
      ],
      rows: ordered.map((p) => [
        `${p.outletName} (${p.outletCode})`,
        p.items.length > 0
          ? p.items.map((it, i) => `${i + 1}. ${it.itemName} (${fmtIDR(it.absNominal)}, ${it.direction})`).join('; ')
          : '\u2014',
      ]),
      rowBold: (_row, i) => ordered[i]?.isTarget ?? false,
    });
  }
}
