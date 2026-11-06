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
//  CC-NAMES-1 (user request: "mode compare 2 resto di laporan pdf
//  header nya pakai nama resto nya aja jangan kaya misal resto
//  pembanding"): when the comparison set is EXACTLY the focus + ONE
//  comparator outlet, every header/subhead/column carries the two
//  NAMES ("13. Komparasi BKSGOL vs CKGPAH" — no generic "fokus vs
//  pembanding" terms; the comparator's columns say its name too, and
//  the per-item "Rata-rata ... Pembanding" columns become plain
//  "QTY Deviasi (CKGPAH)" — with one comparator there IS no average).
//  Any bigger set (multi-resto and/or area picks) keeps the generic
//  wording — a name list does not fit a header.
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
import { C } from '../pdf-primitives';
import { negColor, tickIDR } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawCustomCompareSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, hasSub, currCol } = env;
  if (!hasSection('customCompare')) return;
  // CC-NAMES-1 — the 2-resto compare mode: focus WITH records + exactly
  // ONE comparator entity (a direct pick or a 1-outlet area — either
  // way the comparison is literally two restos). Resolved BEFORE the
  // section header so the title itself carries the names.
  const cc = data.customComparison;
  const focusRow = cc ? (cc.entities.find((e) => e.isFocus) ?? null) : null;
  const comparatorRow =
    cc && focusRow && cc.entities.length === 2
      ? (cc.entities.find((e) => !e.isFocus) ?? null)
      : null;
  const duo =
    focusRow != null && comparatorRow != null
      ? { focus: focusRow, comp: comparatorRow }
      : null;
  rpt.sectionHeader(
    13,
    duo ? `Komparasi ${duo.focus.outletName} vs ${duo.comp.outletName}` : 'Komparasi Pilihan',
  );
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
  // The counts are DISJOINT (BUGHUNT-COMPARE P3): an outlet that is
  // BOTH directly picked and area-expanded is ONE entity row and now
  // counts once (picked wins) — "3 resto pilihan + area JAKARTA (3
  // resto)" can no longer sum past the entity total printed beside it.
  const pickedCount = cc.entities.filter((e) => e.fromPick).length;
  const areaComparatorCount = cc.entities.filter(
    (e) => e.fromArea && !e.fromPick,
  ).length;
  const provParts: string[] = [];
  if (cc.compareOutletCodes.length > 0)
    provParts.push(`${pickedCount} resto pilihan`);
  if (cc.compareAreas.length > 0)
    provParts.push(`area ${cc.compareAreas.join(', ')} (${areaComparatorCount} resto)`);
  // The focus note must match reality: an amber claim needs an amber ROW
  // (a focus with no records this period is listed in the missing note
  // instead — buildCustomComparison pushes it onto missingOutlets).
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
    // BUGHUNT-COMPARE P3: missingAreas covers BOTH a typo AND an area
    // whose whole population has no records this period — the label says
    // so instead of the misleading "tidak ditemukan" alone.
    if (cc.missingAreas.length > 0)
      parts.push(`area tanpa data di periode ini / tidak ditemukan: ${cc.missingAreas.join(', ')}`);
    rpt.noteBox(parts.join(' \u00B7 '));
  }

  // 13.1 — focus + comparators side by side, |nominal| DESC (the shaper's
  // order). Same column set as 11.1 so the two tables read identically.
  if (showTabel) {
    rpt.subhead(
      // CC-NAMES-1: the 2-resto mode subhead carries the two NAMES —
      // no generic "resto fokus + pembanding" wording.
      duo
        ? `13.1 ${duo.focus.outletName} vs ${duo.comp.outletName} \u2014 peringkat dari nominal deviasi terbesar (${currCol}), ${duo.focus.outletName} ter-highlight`
        : `13.1 Resto fokus + pembanding terpilih (${cc.entities.length} resto \u2014 ${provParts.join(' + ')}) \u2014 peringkat dari nominal deviasi terbesar (${currCol})${focusNote}`,
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
    rpt.subhead(
      // CC-NAMES-1: names in the 2-resto mode.
      duo
        ? `Nominal Deviasi \u2014 ${duo.focus.outletName} vs ${duo.comp.outletName} (Rp, nilai absolut)`
        : 'Nominal Deviasi per Resto Terpilih (Rp, nilai absolut)',
      {
        size: 8.5,
        gapAfter: 2,
      },
    );
    hBarChart(doc, {
      x: rpt.leftX,
      y: rpt.y,
      w: rpt.contentW,
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
      // BUGHUNT-COMPARE P3: `!focusRow` is ALSO true when the user DID
      // pick a focus that simply has no records this period — the note
      // must say THAT, not tell them to pick a resto they already
      // picked (the missing-outlets note above carries the code).
      rpt.noteBox(
        cc.focusCode
          ? `Resto fokus ${cc.focusCode} tidak memiliki data di periode ini \u2014 tabel breakdown per item tidak tersedia.`
          : 'Breakdown per item membandingkan resto fokus dengan rata-rata pembanding \u2014 pilih satu resto pada Filter Resto (tab Resto Analysis) untuk mengaktifkan tabel ini.',
      );
    } else if (cc.items.length === 0) {
      rpt.subhead(
        duo
          ? `13.3 Breakdown per Item \u2014 ${duo.focus.outletName} vs ${duo.comp.outletName}`
          : `13.3 Breakdown per Item \u2014 ${fn} vs rata-rata pembanding`,
        { size: 8.5 },
      );
      rpt.noteBox('Data breakdown per item tidak tersedia untuk kombinasi ini.');
    } else {
      rpt.subhead(
        // CC-NAMES-1: "BKSGOL vs CKGPAH" — with one comparator there is
        // no "rata-rata" to speak of.
        duo
          ? `13.3 Breakdown per Item (kuantitas, % to BOM) \u2014 ${duo.focus.outletName} vs ${duo.comp.outletName}`
          : `13.3 Breakdown per Item (kuantitas, % to BOM) \u2014 ${fn} vs rata-rata pembanding terpilih (${cc.entities.filter((e) => !e.isFocus).length} resto)`,
        { size: 8.5 },
      );
      rpt.table({
        // CC-NAMES-1: in the 2-resto mode the comparator's columns carry
        // its NAME (a single comparator's "average" IS its own numbers)
        // and the always-1 "Resto Pembanding" count column is dropped.
        // Either layout keeps the value columns at indices 2-5, so the
        // negColor pass below stays correct for both.
        cols: duo
          ? [
              { header: 'Item' },
              { header: 'Satuan' },
              { header: `QTY Deviasi (${fn})`, align: 'right' },
              { header: `% Deviasi To BOM (${fn})`, align: 'right' },
              { header: `QTY Deviasi (${duo.comp.outletName})`, align: 'right' },
              { header: `% Deviasi To BOM (${duo.comp.outletName})`, align: 'right' },
            ]
          : [
              { header: 'Item' },
              { header: 'Satuan' },
              { header: `QTY Deviasi (${fn})`, align: 'right' },
              { header: `% Deviasi To BOM (${fn})`, align: 'right' },
              { header: 'Rata-rata QTY Pembanding', align: 'right' },
              { header: 'Rata-rata % Dev/BOM Pembanding', align: 'right' },
              // How many comparators carry the item — a 1-resto pick's
              // "average" is that resto itself; the count keeps the reader
              // honest (the 9.3 "peerCount" spirit, as a column here
              // because the comparator count varies per item).
              { header: 'Resto Pembanding', align: 'center' },
            ],
        rows: cc.items.map((it) =>
          duo
            ? [
                it.itemName,
                it.satuan ?? '\u2014',
                it.target ? fmtNum(it.target.qtyDeviasi) : '\u2014',
                it.target ? fmtPct(it.target.devBom, false) : '\u2014',
                it.compareAvg != null ? fmtNum(it.compareAvg.qtyDeviasi) : '\u2014',
                it.compareAvg != null ? fmtPct(it.compareAvg.devBom, false) : '\u2014',
              ]
            : [
                it.itemName,
                it.satuan ?? '\u2014',
                it.target ? fmtNum(it.target.qtyDeviasi) : '\u2014',
                it.target ? fmtPct(it.target.devBom, false) : '\u2014',
                it.compareAvg != null ? fmtNum(it.compareAvg.qtyDeviasi) : '\u2014',
                it.compareAvg != null ? fmtPct(it.compareAvg.devBom, false) : '\u2014',
                String(it.compareCount),
              ],
        ),
        // 9.2's cellColor convention (PDFCOLOR-1): a no-op on the ABS
        // convention's non-negative values, kept so the table styles stay
        // uniform with its 9.2 twin. Value columns are 2-5 in BOTH
        // layouts (see the cols note above).
        cellColor: (row, _ri, ci) => (ci >= 2 && ci <= 5 ? negColor(row[ci]) : undefined),
      });
    }
  }
}
