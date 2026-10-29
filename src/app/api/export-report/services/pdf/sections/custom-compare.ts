// ============================================================
//  13 — KOMPARASI PILIHAN  (CUSTOM-COMPARE — NEW)
//  --------------------------------------------------------
//  User request: "misal aku pilih resto mlgpar terus sebagai pembanding
//  nya aku pilih resto lain lagi yaitu bdgsek nah ini bisa export laporan
//  pdf. atau aku juga bisa filter beberapa resto atau filer pakai area
//  gitu maksud nya" — the comparison SET is the user's, not an automatic
//  peer band (section 9) or the whole population (section 11): the focus
//  resto (Filter Resto) side by side with hand-picked comparator restos
//  and/or every resto of a picked area.
//
//    13.1 — KPI table: the SAME columns as 11.1's league (Nominal
//           Deviasi signed minus-red, % Dev/BOM, QTY Deviasi, % Loss to
//           Sales), only the focus + the picked entities; focus row
//           amber + bold (the ITEM-HL-B PDF twin).
//    13.2 — |nominal deviasi| bar chart per entity (the 12.2 pattern,
//           focus label bold, top 14 bars).
//    13.3 — per-item breakdown: focus vs rata-rata pembanding (the 9.2
//           table shape + ABS aggregation convention — reads the same
//           way as "Rata-rata Resto Setara").
//
//  Data: the UNSCOPED q-outlet-agg scan rows shaped by
//  data-fetcher/custom-compare.ts (focus dedupe, area expansion, missing
//  detection) + queryCustomCompareItems for 13.3. Missing picks are
//  LISTED (a comparator with no records ≠ a zero row — silence would
//  masquerade as cleanliness).
//
//  SALES SECRECY (REFINE-1): the sales nominal never prints — only the
//  loss/sales RATIO (same policy as sections 9/11/12).
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { hBarChart } from '../pdf-charts';
import { C, PAGE, CONTENT_W } from '../pdf-primitives';
import { negColor, tickIDR } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawCustomCompareSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, hasSub, currCol } = env;
  if (!hasSection('customCompare')) return;
  rpt.sectionHeader(13, 'Komparasi Pilihan');
  const cc = data.customComparison;
  if (!cc || (cc.compareOutletCodes.length === 0 && cc.compareAreas.length === 0)) {
    // Factual guidance, not narrative (the EXPAND-1 content rule): the
    // URL carried the section without a comparator set — the dialog's
    // picker is where they come from.
    rpt.noteBox(
      'Section ini membandingkan resto fokus dengan pembanding yang dipilih sendiri \u2014 pilih minimal satu resto atau area pembanding di dialog Export (section 13), lalu export ulang.',
    );
    return;
  }

  const showTabel = hasSub('customCompare', 'tabel');
  const showGrafik = hasSub('customCompare', 'grafik');
  const showItems = hasSub('customCompare', 'items');

  // Provenance — factual counts for the subhead (the focus + picks +
  // area-expanded comparators). "X resto pilihan + Y area (Z resto)".
  const pickedCount = cc.entities.filter((e) => e.fromPick).length;
  const areaComparatorCount = cc.entities.filter((e) => e.fromArea).length;
  const provParts: string[] = [];
  if (cc.compareOutletCodes.length > 0)
    provParts.push(`${pickedCount} resto pilihan`);
  if (cc.compareAreas.length > 0)
    provParts.push(`area ${cc.compareAreas.join(', ')} (${areaComparatorCount} resto)`);
  // The focus note must match reality: an amber claim needs an amber ROW
  // (a focus with no records this period is listed in the missing note
  // instead — buildCustomComparison pushes it onto missingOutlets).
  const focusRow = cc.entities.find((e) => e.isFocus);
  const focusNote = focusRow
    ? `, ${focusRow.outletCode} ter-highlight`
    : cc.focusCode
      ? ` (resto fokus ${cc.focusCode} tanpa data di periode ini)`
      : ' (tanpa resto fokus \u2014 pembanding saja)';

  // Missing picks — listed so a silent drop can never masquerade as a
  // zero (the noteBox convention of sections 3/6/8/9 for empty data).
  if (cc.missingOutlets.length > 0 || cc.missingAreas.length > 0) {
    const parts: string[] = [];
    if (cc.missingOutlets.length > 0)
      parts.push(`resto tanpa data di periode ini: ${cc.missingOutlets.join(', ')}`);
    if (cc.missingAreas.length > 0)
      parts.push(`area tidak ditemukan: ${cc.missingAreas.join(', ')}`);
    rpt.noteBox(parts.join(' \u00B7 '));
  }

  // 13.1 — focus + comparators side by side, |nominal| DESC (the shaper's
  // order). Same column set as 11.1 so the two tables read identically.
  if (showTabel) {
    rpt.subhead(
      `13.1 Resto fokus + pembanding terpilih (${cc.entities.length} resto \u2014 ${provParts.join(' + ')}) \u2014 peringkat dari nominal deviasi terbesar (${currCol})${focusNote}`,
      { size: 8.5 },
    );
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Resto' },
        { header: 'Area' },
        { header: 'Nominal Deviasi', align: 'right' },
        { header: '% Deviasi To BOM', align: 'right' },
        { header: 'QTY Deviasi', align: 'right' },
        { header: '% Loss to Sales', align: 'right' },
      ],
      rows: cc.entities.map((r, i) => [
        String(i + 1),
        `${r.outletName} (${r.outletCode})`,
        r.area,
        fmtIDR(r.nominalDeviasi),
        r.totalQtyBom > 0 ? fmtPct(r.totalQtyDeviasi / r.totalQtyBom, false) : '\u2014',
        fmtNum(r.totalQtyDeviasi),
        r.sales > 0 ? fmtPct(r.lossNominal / r.sales, false) : '\u2014',
      ]),
      // Focus row: bold + amber fill (11.1's convention — the ITEM-HL-B
      // PDF twin).
      rowBold: (_row, i) => cc.entities[i]?.isFocus ?? false,
      cellFill: (_row, ri) =>
        cc.entities[ri]?.isFocus ? C.focusRow : undefined,
      // PDFCOLOR-1 (minus-red on the two signed VALUE columns — 11.1's
      // convention).
      cellColor: (row, _ri, ci) =>
        ci === 3 || ci === 5 ? negColor(row[ci]) : undefined,
    });
  }

  // 13.2 — |nominal deviasi| per entity (bars, biggest first). Top 14
  // when the set is bigger (an area pick can bring dozens of restos —
  // the 12.2 precedent); the table above carries every row.
  if (showGrafik && cc.entities.length > 0) {
    const chartRows = cc.entities.slice(0, 14);
    const chartH = 18 * chartRows.length;
    // Reserve subhead (≈14.5) + chart — the BUG-HUNT PAGE RESERVE
    // convention (trend.ts's ensure(160) for h:140 charts).
    rpt.ensure(chartH + 18);
    rpt.subhead('Nominal Deviasi per Resto Terpilih (Rp, nilai absolut)', {
      size: 8.5,
      gapAfter: 2,
    });
    hBarChart(doc, {
      x: PAGE.M,
      y: rpt.y,
      w: CONTENT_W,
      h: chartH,
      labels: chartRows.map((r) => r.outletName),
      values: chartRows.map((r) => Math.abs(r.nominalDeviasi)),
      fmt: tickIDR,
      labelW: 118,
      valW: 52,
      // Current-period bar tone (12.2's convention).
      barColor: C.barCur,
      boldLabels: chartRows.map((r) => r.isFocus),
    });
    rpt.y += chartH + 8;
  }

  // 13.3 — per-item breakdown: focus vs rata-rata pembanding. The 9.2
  // table shape (ABS aggregation convention — "Rata-rata Pembanding"
  // reads exactly like "Rata-rata Resto Setara"); the focus's NAME
  // carries its columns (PEERTOP-R2: no generic "target" term).
  if (showItems) {
    // PEERTOP-R2: the focus-owned columns carry the outlet's NAME (code
    // fallback when the focus has no records — focusName is null there).
    const fn = cc.focusName ?? cc.focusCode ?? '';
    if (!focusRow) {
      rpt.subhead('13.3 Breakdown per Item', { size: 8.5 });
      rpt.noteBox(
        'Breakdown per item membandingkan resto fokus dengan rata-rata pembanding \u2014 pilih satu resto pada Filter Resto (tab Resto Analysis) untuk mengaktifkan tabel ini.',
      );
    } else if (cc.items.length === 0) {
      rpt.subhead(`13.3 Breakdown per Item \u2014 ${fn} vs rata-rata pembanding`, { size: 8.5 });
      rpt.noteBox('Data breakdown per item tidak tersedia untuk kombinasi ini.');
    } else {
      rpt.subhead(
        `13.3 Breakdown per Item (kuantitas, % to BOM) \u2014 ${fn} vs rata-rata pembanding terpilih (${cc.entities.filter((e) => !e.isFocus).length} resto)`,
        { size: 8.5 },
      );
      rpt.table({
        cols: [
          { header: 'Item' },
          // REFINE-2 ("section yang belum punya satuan tambahain"): unit
          // of measure per item — the QTY columns are satuan-denominated.
          { header: 'Satuan' },
          // PEERTOP-R2: the focus-owned columns carry the outlet's NAME.
          { header: `QTY Deviasi (${fn})`, align: 'right' },
          { header: `% Deviasi To BOM (${fn})`, align: 'right' },
          { header: 'Rata-rata QTY Pembanding', align: 'right' },
          { header: 'Rata-rata % Dev/BOM Pembanding', align: 'right' },
          // How many comparators carry the item — a 1-resto pick's
          // "average" is that resto itself; the count keeps the reader
          // honest (the 9.3 "peerCount" spirit, as a column here because
          // the comparator count varies per item).
          { header: 'Resto Pembanding', align: 'center' },
        ],
        rows: cc.items.map((it) => [
          it.itemName,
          it.satuan ?? '\u2014',
          it.target ? fmtNum(it.target.qtyDeviasi) : '\u2014',
          it.target ? fmtPct(it.target.devBom, false) : '\u2014',
          it.compareAvg != null ? fmtNum(it.compareAvg.qtyDeviasi) : '\u2014',
          it.compareAvg != null ? fmtPct(it.compareAvg.devBom, false) : '\u2014',
          String(it.compareCount),
        ]),
        // 9.2's cellColor convention (PDFCOLOR-1): a no-op on the ABS
        // convention's non-negative values, kept so the table styles stay
        // uniform with its 9.2 twin.
        cellColor: (row, _ri, ci) => (ci >= 2 && ci <= 5 ? negColor(row[ci]) : undefined),
      });
    }
  }
}
