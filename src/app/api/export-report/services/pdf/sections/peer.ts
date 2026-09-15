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
}
