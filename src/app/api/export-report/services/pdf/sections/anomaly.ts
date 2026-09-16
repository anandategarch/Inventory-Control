// ============================================================
//  6 — ITEM ANOMALI VS RIWAYAT SENDIRI  (REFINE-3 — NEW)
//  --------------------------------------------------------
//  User: "Section Item Anomali vs Riwayat Sendiri". Items whose current
//  QTY deviasi departs most from their OWN same-week historical average
//  ("Rata-rata per Bulan" — the identical window/benchmark as the
//  3.3-3.6 tables, so the sections corroborate each other). Eligibility
//  (querySelfHistoryAnomaly): departure ≥ 50% of the own baseline; ranked
//  by the biggest absolute departure. histCount is surfaced in the
//  subhead so the average's basis is stated (factual, no narrative).
// ============================================================
import { fmtIDR, fmtNum } from '../../format-helpers';
import { C, markOf } from '../pdf-primitives';
import { fmtVsHist, negColor } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawAnomalySection(env: SectionEnv): void {
  const { rpt, data, ctx, hasSection, currCol } = env;
  if (!hasSection('anomali')) return;
  rpt.sectionHeader(6, 'Item Anomali vs Riwayat Sendiri');
  const an = data.selfHistoryAnomaly;
  if (an.length === 0) {
    // BUG-HUNT (found in render test): '≥' is NOT WinAnsi-encodable —
    // sanitizePdfText maps it to '?' in the PDF. Plain wording instead.
    rpt.noteBox(ctx.historicalPeriods.length === 0
      ? 'Belum ada periode riwayat (bulan sebelumnya dengan minggu yang sama) untuk dibandingkan.'
      : 'Tidak ada item dengan penyimpangan minimal 50% dari rata-rata absolute riwayatnya sendiri pada scope ini.');
    return;
  }
  const nBulan = an.reduce((mx, it) => Math.max(mx, it.histCount), 0);
  // REFINE-4 (user: "di laporan di beri keterangan Rata-Rata Absolute"):
  // the benchmark column is the ABSOLUTE average of the item's own
  // same-week history — stated in both the subhead and the header.
  rpt.subhead(`6.1 Kuantitas vs Rata-rata Riwayat Sendiri (same-week, maks ${nBulan} bulan; rata-rata absolute)`, { size: 8.5 });
  rpt.table({
    cols: [
      { header: '#', align: 'center' },
      { header: 'Item' },
      { header: 'Resto' },
      { header: 'Area' },
      { header: 'Satuan' },
      { header: `QTY ${currCol}`, align: 'right' },
      { header: 'Rata-rata Absolute', align: 'right' },
      { header: 'Selisih', align: 'right' },
      { header: 'vs Riwayat', align: 'right' },
      { header: 'Nominal Deviasi', align: 'right' },
    ],
    rows: an.map((it, i) => [
      String(i + 1),
      it.itemName,
      it.outletCode,
      it.area,
      it.satuan ?? '\u2014',
      fmtNum(it.qty),
      fmtNum(it.histAvgQty),
      markOf(it.deltaQty) + fmtNum(it.deltaQty),
      fmtVsHist(it.qty, it.histAvgQty),
      fmtIDR(it.nominal),
    ]),
    // ▲/▼ semantic color on the Selisih + vs Riwayat columns, judged by
    // MAGNITUDE (REFINE-4: histAvgQty is now the ABSOLUTE average and
    // deltaQty is |qty| − histAvg, so the comparison is already
    // magnitude-to-magnitude): |cur| > histAvg = red (the deviation
    // widened), |cur| < histAvg = green.
    // PDFCOLOR-1 (user: "terkait minus atau penurunan harusnya warna
    // merah"): the QTY column prints SIGNED SUM(qtyDeviasi) and the
    // Nominal Deviasi column SIGNED SUM(nominalDeviasi) — minus digits
    // are red now. Rata-rata Absolute is ABS — negColor is a no-op.
    cellColor: (row, ri, ci) => {
      if (ci === 7 || ci === 8) {
        const it = an[ri];
        if (it == null) return undefined;
        return Math.abs(it.qty) > it.histAvgQty
          ? C.danger
          : Math.abs(it.qty) < it.histAvgQty ? C.success : undefined;
      }
      if (ci === 5 || ci === 6 || ci === 9) return negColor(row[ci]);
      return undefined;
    },
  });

  // 6.2 — REFINE-4 (user: "apakah sudah bisa deteksi yang biasanya loss
  // tapi sekarang surplus? kalau belum tambahkan"): items whose
  // direction REVERSED vs their own same-week history. "Rata-rata
  // Riwayat" here is the SIGNED average (it shows the usual direction,
  // e.g. -12.3 = loss side) — a different lens from 6.1's absolute
  // benchmark, hence its own column name. Eligibility (engine):
  // history predominantly one direction + a material current side.
  const flips = data.selfHistoryFlips;
  rpt.subhead('6.2 Item Berganti Arah \u2014 biasanya loss, kini surplus (atau sebaliknya)', { size: 8.5 });
  if (flips.length === 0) {
    rpt.noteBox('Tidak ada item yang berganti arah (loss menjadi surplus atau sebaliknya) dibanding riwayatnya sendiri pada scope ini.');
  } else {
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Resto' },
        { header: 'Area' },
        { header: 'Satuan' },
        { header: 'Rata-rata Riwayat', align: 'right' },
        { header: `QTY ${currCol}`, align: 'right' },
        { header: 'Pola', align: 'center' },
        { header: 'Nominal Deviasi', align: 'right' },
      ],
      rows: flips.map((it, i) => [
        String(i + 1),
        it.itemName,
        it.outletCode,
        it.area,
        it.satuan ?? '\u2014',
        fmtNum(it.histSignedAvgQty),
        fmtNum(it.qty),
        it.flip === 'lossToSurplus' ? 'Biasanya Loss, Kini Surplus' : 'Biasanya Surplus, Kini Loss',
        fmtIDR(it.nominal),
      ]),
      // Direction coloring on the two QTY columns (green = surplus side,
      // red = loss side — same convention as section 9); the Pola text
      // stays neutral ink (a flip is a pattern to investigate, not a
      // good/bad verdict — DESAIN-SIMPEL).
      // PDFCOLOR-1: the SIGNED Nominal Deviasi column is minus-red too
      // (it printed "-Rp …" in neutral ink while its own row's QTY cells
      // were already sign-colored).
      cellColor: (row, ri, ci) => {
        if (ci === 5 || ci === 6) {
          const it = flips[ri];
          if (it == null) return undefined;
          const v = ci === 5 ? it.histSignedAvgQty : it.qty;
          return v < 0 ? C.danger : v > 0 ? C.success : undefined;
        }
        if (ci === 8) return negColor(row[8]);
        return undefined;
      },
    });
  }
}
