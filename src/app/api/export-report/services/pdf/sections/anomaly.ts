// ============================================================
//  7 — ITEM ANOMALI VS RIWAYAT SENDIRI  (REFINE-3 — NEW; W10 renumber:
//      was 6 — section 5 "Analisis Waste" inserted above)
//  --------------------------------------------------------
//  User: "Section Item Anomali vs Riwayat Sendiri". Items whose current
//  QTY deviasi departs most from their OWN same-week historical average
//  ("Rata-rata per Bulan" — the identical window/benchmark as the
//  3.3-3.6 tables, so the sections corroborate each other). Eligibility
//  (querySelfHistoryAnomaly): departure ≥ 50% of the own baseline; ranked
//  by the biggest absolute departure. histCount is surfaced in the
//  subhead so the average's basis is stated (factual, no narrative).
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { C, markOf } from '../pdf-primitives';
import { fmtVsHist, negColor } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawAnomalySection(env: SectionEnv): void {
  const { rpt, data, ctx, hasSection, currCol } = env;
  if (!hasSection('anomali')) return;
  rpt.sectionHeader(7, 'Item Anomali vs Riwayat Sendiri');
  const an = data.selfHistoryAnomaly;
  // VAR12: the old early `return` here also skipped 6.2 AND would have
  // skipped the new 6.3 — whose data (current-period consistency) does
  // NOT depend on historical periods. 6.1 + 6.2 now sit in the else
  // branch (identical render behavior) so 6.3 always renders. (Numbers
  // since renumbered 7.1/7.2/7.3 by W10.)
  if (an.length === 0) {
    // BUG-HUNT (found in render test): '≥' is NOT WinAnsi-encodable —
    // sanitizePdfText maps it to '?' in the PDF. Plain wording instead.
    rpt.noteBox(ctx.historicalPeriods.length === 0
      ? 'Belum ada periode riwayat (bulan sebelumnya dengan minggu yang sama) untuk dibandingkan.'
      : 'Tidak ada item dengan penyimpangan minimal 50% dari rata-rata absolute riwayatnya sendiri pada scope ini.');
  } else {
    const nBulan = an.reduce((mx, it) => Math.max(mx, it.histCount), 0);
    // REFINE-4 (user: "di laporan di beri keterangan Rata-Rata Absolute"):
    // the benchmark column is the ABSOLUTE average of the item's own
    // same-week history — stated in both the subhead and the header.
    rpt.subhead(`7.1 Kuantitas vs Rata-rata Riwayat Sendiri (same-week, maks ${nBulan} bulan; rata-rata absolute)`, { size: 8.5 });
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

    // 7.2 — REFINE-4 (user: "apakah sudah bisa deteksi yang biasanya loss
    // tapi sekarang surplus? kalau belum tambahkan"): items whose
    // direction REVERSED vs their own same-week history. "Rata-rata
    // Riwayat" here is the SIGNED average (it shows the usual direction,
    // e.g. -12.3 = loss side) — a different lens from 7.1's absolute
    // benchmark, hence its own column name. Eligibility (engine):
    // history predominantly one direction + a material current side.
    const flips = data.selfHistoryFlips;
    rpt.subhead('7.2 Item Berganti Arah \u2014 biasanya loss, kini surplus (atau sebaliknya)', { size: 8.5 });
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

  // 7.3 — VAR12 (user: "Analisis Pola item masukin juga ke pdf terutama
  // bagian anomali item"): the dashboard's "Analisis Pola Item" widget
  // (ItemConsistencyAnalysis) carried into the PDF. Per-item outlet-count
  // pattern for the CURRENT period: Massal (10+ outlet) = indikasi
  // masalah produk/QTY BOM, Regional (5-9) = pola area, Lokal (2-4) =
  // anomali outlet spesifik. "Anomali" = the MINORITY direction's outlet
  // count ("2 S" = 2 resto di sisi surplus padahal item mayoritas loss —
  // kandidat drill per-outlet, sama seperti expand baris di dashboard).
  // Top 15 rows by |Nominal Deviasi| (the query's own ranking); the
  // subhead carries the full-population tier counts.
  const ic = data.itemConsistency;
  rpt.subhead('7.3 Analisis Pola Item (Massal / Regional / Lokal)', { size: 8.5 });
  if (ic.length === 0) {
    rpt.noteBox('Tidak ada item dengan deviasi pada scope ini.');
  } else {
    const massal = ic.filter((r) => r.consistency === 'SYSTEMIC').length;
    const regional = ic.filter((r) => r.consistency === 'WIDESPREAD').length;
    const lokal = ic.filter((r) => r.consistency === 'ISOLATED').length;
    const top = ic.slice(0, 15);
    rpt.para(`${massal} massal · ${regional} regional · ${lokal} lokal — Top ${top.length} dari ${ic.length} item berdasarkan |Nominal Deviasi|.`, { size: 7.5, color: C.faint });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Type' },
        { header: 'Outlets', align: 'right' },
        { header: 'LOSS', align: 'right' },
        { header: 'SURPLUS', align: 'right' },
        { header: 'Anomali', align: 'center' },
        { header: '|Nominal Deviasi|', align: 'right' },
        { header: 'Rata-rata % Dev/BOM', align: 'right' },
      ],
      rows: top.map((r, i) => {
        const minorityDirection = r.lossOutlets > r.surplusOutlets ? 'S' : 'L';
        const anomaliCount = Math.min(r.lossOutlets, r.surplusOutlets);
        return [
          String(i + 1),
          r.itemName,
          r.consistency === 'SYSTEMIC' ? 'Massal' : r.consistency === 'WIDESPREAD' ? 'Regional' : 'Lokal',
          fmtNum(r.outletCount),
          fmtNum(r.lossOutlets),
          fmtNum(r.surplusOutlets),
          anomaliCount > 0 ? `${anomaliCount} ${minorityDirection}` : '\u2014',
          fmtIDR(r.totalAbsNominal),
          fmtPct(r.avgDevBom),
        ];
      }),
      // Direction colors on the LOSS/SURPLUS counts (dashboard convention:
      // LOSS red, SURPLUS green) + Massal tier in danger red (the
      // network-wide flag — Regional/Lokal stay neutral ink; no amber in
      // the PDF palette). |Nominal Deviasi| is ABS — negColor no-op.
      cellColor: (_row, ri, ci) => {
        if (ci === 2) return top[ri]?.consistency === 'SYSTEMIC' ? C.danger : undefined;
        if (ci === 4) return C.danger;
        if (ci === 5) return C.success;
        return undefined;
      },
    });
  }
}
