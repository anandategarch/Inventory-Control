// ============================================================
//  3 — ITEM PRIORITAS (TOP ITEMS)  (EXPORT-TRIM: was 7)
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { C, stripMark } from '../pdf-primitives';
import { fmtVsHist, negColor } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawTopItemsSection(env: SectionEnv): void {
  const { rpt, data, hasSection, currCol, prevCol } = env;
  if (!hasSection('topItems')) return;
  rpt.sectionHeader(3, 'Item Prioritas (Top Items)');
  // BUG-HUNT (numbering continuity): when EVERY top list is empty the
  // section used to render as a bare header with nothing under it — now a
  // factual note states why (same convention as sections 6/8/9).
  if (data.topItemsByNominal.length === 0 && data.topItemsByDevBom.length === 0
    && data.topItemsByWaste.length === 0 && data.topItemsBySusut.length === 0
    && data.topItemsByTrial.length === 0 && data.topItemsByLossSurplus.length === 0) {
    rpt.noteBox('Tidak ada item dengan deviasi pada scope ini.');
  }

  // 3.1 nominal — REFINE-1: + "% Deviasi To BOM" column (user: "3.1
  // Nominal Deviasi Terbesar tambahkan % Deviasi to bom nya juga").
  if (data.topItemsByNominal.length > 0) {
    rpt.subhead(`3.1 Nominal Deviasi Terbesar (${currCol})`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Resto' },
        { header: 'Satuan' },
        { header: `Nominal Deviasi`, align: 'right' },
        { header: '% Deviasi To BOM', align: 'right' },
      ],
      rows: data.topItemsByNominal.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtIDR(it.nominalDeviasi), fmtPct(it.devBom, false)]),
      rowText: (row) => (stripMark(row[4]).startsWith('-') ? C.danger : undefined),
    });
  }
  // 3.2 devBom — REFINE-1: + "Nominal Deviasi" column on the right (user:
  // "3.2 % Deviasi To BOM Terbesar tambahkan Nominal Deviasi juga di
  // sebelah kanan nya").
  if (data.topItemsByDevBom.length > 0) {
    rpt.subhead(`3.2 % Deviasi To BOM Terbesar (${currCol})`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Resto' },
        { header: 'Satuan' },
        { header: '% Deviasi To BOM', align: 'right' },
        { header: 'Nominal Deviasi', align: 'right' },
      ],
      rows: data.topItemsByDevBom.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtPct(it.devBom, false), fmtIDR(it.nominalDeviasi)]),
      rowText: (row) => (stripMark(row[5]).startsWith('-') ? C.danger : undefined),
    });
  }
  // 3.3-3.6 category tables
  // REFINE-1: "HIST (…)"/"vs Hist" → "Rata-rata per Bulan"/"vs Rata-rata";
  // + NEW "Rata-rata Area" column (avg across the area where the row's
  // resto is located); "Nominal (Rp)" column REMOVED ("hapus nominal nya
  // biar fit").
  const catTables: Array<{ title: string; items: Array<{ itemName: string; outletCode: string; satuan?: string | null; area: string; qty: number; nominal: number; prevQty: number | null; histAvgQty: number | null; areaAvgQty: number | null }> }> = [
    { title: `3.3 QTY Waste Terbesar (${currCol})`, items: data.topItemsByWaste.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyWaste, nominal: r.nominalWaste, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
    { title: `3.4 QTY Susut Terbesar (${currCol})`, items: data.topItemsBySusut.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtySusut, nominal: r.nominalSusut, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
    { title: `3.5 QTY Trial Terbesar (${currCol})`, items: data.topItemsByTrial.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyTrial, nominal: r.nominalTrial, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
    { title: `3.6 QTY Loss/Surplus Terbesar (${currCol})`, items: data.topItemsByLossSurplus.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyLossSurplus, nominal: r.nominalLossSurplus, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
  ];
  for (const ct2 of catTables) {
    if (ct2.items.length === 0) continue;
    rpt.subhead(ct2.title, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Satuan' },
        { header: 'Resto' },
        { header: `QTY ${currCol}`, align: 'right' },
        { header: `QTY ${prevCol}`, align: 'right' },
        { header: 'Rata-rata Absolute', align: 'right' },
        { header: 'vs Rata-rata', align: 'right' },
        { header: 'Rata-rata Area', align: 'right' },
        // REFINE-3 (user: "Kolom 'vs Rata-rata Area'"): the item's QTY as
        // a % of the area average — mirrors the "vs Rata-rata" column so
        // the two benchmarks read side by side.
        { header: 'vs Rata-rata Area', align: 'right' },
      ],
      rows: ct2.items.map((it, i) => [
        String(i + 1),
        it.itemName,
        it.satuan ?? '\u2014',
        it.outletCode,
        fmtNum(it.qty),
        it.prevQty != null ? fmtNum(it.prevQty) : '\u2014',
        it.histAvgQty != null ? fmtNum(it.histAvgQty) : '\u2014',
        fmtVsHist(it.qty, it.histAvgQty),
        it.areaAvgQty != null ? fmtNum(it.areaAvgQty) : '\u2014',
        fmtVsHist(it.qty, it.areaAvgQty),
      ]),
      // ▲/▼ semantic color on the two "vs …" delta columns (up = bad —
      // these are all deviation-magnitude rankings). REFINE-3: the vs
      // Rata-rata Area column (ci 9) follows the same rule.
      // REFINE-4: MAGNITUDE comparison — the baselines are ABSOLUTE
      // averages, and 3.6's qtyLossSurplus is SIGNED, so a −10 current
      // vs a 5 abs baseline is a GROWN deviation (red), not a smaller
      // one. (Waste/Susut/Trial are always ≥ 0 — unchanged behavior.)
      // PDFCOLOR-1 (user: "terkait minus atau penurunan harusnya warna
      // merah"): the QTY value columns are minus-red — 3.6's QTY columns
      // print SIGNED digits (SUM(qtyLossSurplus)), and a "-45.6" cell in
      // neutral ink contradicted the minus-red rule already applied to
      // the nominal twin tables (3.1/3.2 rowText). The two benchmark
      // columns are ABS — negColor is a no-op there.
      cellColor: (row, ri, ci) => {
        if (ci === 7 || ci === 9) {
          const it = ct2.items[ri];
          if (it == null) return undefined;
          const base = ci === 7 ? it.histAvgQty : it.areaAvgQty;
          if (base == null || base === 0) return undefined;
          const mag = Math.abs(it.qty);
          return mag > base ? C.danger : mag < base ? C.success : undefined;
        }
        if (ci === 4 || ci === 5 || ci === 6 || ci === 8) return negColor(row[ci]);
        return undefined;
      },
    });
  }
}
