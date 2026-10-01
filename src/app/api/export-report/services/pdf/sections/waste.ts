// ============================================================
//  5 — ANALISIS WASTE  (W10 — NEW)
//  --------------------------------------------------------
//  The deferred DEEP-WASTE Fase-3 PDF piece (findings-DEEPWASTE2-A
//  §1e: EXPORT_SECTION_KEYS had no 'waste'): the network-level loss
//  attribution + residual sensitivity view of the Waste tab, carried
//  into the report. Three blocks:
//    5.1 Komposisi Loss — measured (TERUKUR) W/S/T shares vs the
//        loss-side residual + a horizontal bar chart (same palette as
//        the trend section's composition chart: 3 neutral grays +
//        danger red on the residual).
//    5.2 Skenario Atribusi Residual (HIPOTESIS) — the p grid
//        (0/30/50/70%): true waste, implied waste/sales + share of
//        loss, and the decile-shift count. Every row is a HYPOTHESIS
//        ("p × residual adalah waste tak tercatat"), never a
//        measurement — the spec's presentation guard.
//    5.3 Top Waste Items snapshot — the current period's top rows
//        from the EXISTING q-topcat payload (the full ranking lives
//        in the topItems section's 3.3 table; no share column here on
//        purpose — the q-topcat slice is capped, so a share of the
//        window's total waste would be a wrong denominator).
//  The MANDATORY structural disclosure (residual ≈ NET loss by
//  construction — W/S/T explain GROSS, not NET) closes the section:
//  the residualShare figure near 1 is a property of the data model
//  (live: TLGTEU residual 43.925.875,94 vs totalLoss 43.925.875,95),
//  not evidence that the loss "vanished".
//
//  Numbering: W10 inserted this section AFTER the variance context;
//  the REFINE-3 precedent renumbered the tail — itemTrend 5→6,
//  anomali 6→7, trend 7→8, peer 8→9, flip 9→10 (keys unchanged; see
//  lib/validation/export.ts).
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { hBarChart } from '../pdf-charts';
import { C, PAGE, CONTENT_W } from '../pdf-primitives';
import { tickIDR } from '../pdf-style';
import type { SectionEnv } from '../section-context';

/** Rows shown in the 5.3 snapshot (small by design — the full ranking is 3.3). */
const TOP_WASTE_SNAPSHOT_ROWS = 5;

/**
 * WinAnsi-safe transcription of the shared disclosure constant. The PDF's
 * standard fonts cannot encode \u2248 (≈) / \u2212 (−) — sanitizePdfText
 * would map them to '?' (the same class as the BUG-HUNT '≥' finding in
 * anomaly.ts). The UI keeps the typographic glyphs; the PDF prints the
 * ASCII-safe equivalents ('~' / '-'), wording unchanged.
 */
function pdfSafeDisclosure(disclosure: string): string {
  return disclosure
    .replace(/\u2248/g, '~')
    .replace(/\u2212/g, '-');
}

export function drawWasteSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, currCol, restoName } = env;
  if (!hasSection('waste')) return;
  // BUG-HUNT (numbering continuity) convention: the FIXED section header
  // always renders; empty data degrades to a factual noteBox.
  rpt.sectionHeader(5, 'Analisis Waste');
  const wa = data.wasteAttribution;
  if (!wa || wa.attribution.totalLoss <= 0) {
    rpt.noteBox('Tidak ada loss pada scope window waste ini — atribusi loss W/S/T vs residual tidak dapat dihitung.');
    return;
  }
  const a = wa.attribution;
  // Sensitivity row index (computed once — the 50% row's label carries the
  // watch hue in the scenario table below).
  const headlineIdx = a.scenarios.findIndex((s) => s.p === a.decile.p);

  // ---- Window provenance (same-week convention, factual labels only) ----
  const first = wa.months[0]?.monthLabel;
  const last = wa.months.length > 0 ? wa.months[wa.months.length - 1]?.monthLabel : undefined;
  const windowLabel = first && last
    ? `${wa.months.length} bulan same-week (${first} \u2013 ${last})`
    : `${wa.months.length} bulan same-week`;
  rpt.para(
    `Window: ${windowLabel} \u00B7 minggu ${data.period.weekLabel} \u00B7 ${wa.kpis.outlets} outlet \u00B7 ${restoName}. ` +
    'Semua angka nominal; residual dihitung sisi LOSS (baris nominalLossSurplus < 0), sama dengan denominator total loss.',
    { size: 8, color: C.muted },
  );

  // ---- 5.1 Komposisi Loss (TERUKUR) ----
  rpt.subhead('5.1 Komposisi Loss \u2014 Terjelaskan W/S/T vs Residual (TERUKUR)', { size: 8.5 });
  // Table + bar chart share ONE palette with the (renumbered) trend
  // section's composition chart: 3 neutral grays + danger red on the
  // residual — the unexplained remainder stays the flag-worthy category.
  const compRows = [
    ...a.components.map((c) => [c.label, fmtIDR(c.nominal), fmtPct(c.shareOfLoss, false)]),
    ['Residual', fmtIDR(a.residual), fmtPct(a.residualShare, false)],
    ['Total Loss', fmtIDR(a.totalLoss), fmtPct(1, false)],
  ];
  rpt.table({
    cols: [
      { header: 'Komponen' },
      { header: 'Nominal (window)', align: 'right' },
      { header: '% dari Total Loss', align: 'right' },
    ],
    boldFirst: true,
    rows: compRows,
    // The residual row (and its near-100% share) is the flag-worthy line —
    // danger ink ties it to the bar chart below + the disclosure box.
    cellColor: (row, ri) => (ri === 3 ? C.danger : undefined),
  });
  const compLabels = [...a.components.map((c) => c.label), 'Residual'];
  const compValues = [...a.components.map((c) => c.nominal), a.residual];
  const compColors = [C.inkSoft, C.muted, C.faint, C.danger];
  rpt.ensure(18 * compLabels.length + 24);
  rpt.subhead('Komposisi Loss per Komponen (Rp, window)', { size: 8.5, gapAfter: 2 });
  hBarChart(doc, {
    x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * compLabels.length,
    labels: compLabels,
    values: compValues,
    fmt: tickIDR,
    labelW: 118, valW: 52,
    colors: compColors,
  });
  rpt.y += 18 * compLabels.length + 8;
  // explainedShare callout — the section's headline decision number
  // (DoD W10: "headline 74,6% loss tanpa keterangan" becomes explained %).
  rpt.para(
    `Loss terjelaskan W/S/T: ${fmtPct(a.explainedShare)} (${fmtIDR(a.explainedNominal)} dari ${fmtIDR(a.totalLoss)} total loss). ` +
    `Residual ${fmtPct(a.residualShare)} dari total loss \u2014 lihat catatan identitas di bawah.`,
    { size: 8, color: C.inkSoft },
  );

  // ---- 5.2 Skenario Atribusi Residual (HIPOTESIS) ----
  rpt.subhead('5.2 Skenario Atribusi Residual \u2014 p \u00D7 residual dianggap waste tak tercatat (HIPOTESIS)', { size: 8.5 });
  rpt.table({
    cols: [
      { header: 'Asumsi p' },
      { header: 'True Waste', align: 'right' },
      { header: 'Waste/Sales implisit', align: 'right' },
      { header: 'Share of Loss implisit', align: 'right' },
      { header: 'Pindah decile', align: 'right' },
    ],
    boldFirst: true,
    rows: a.scenarios.map((s) => [
      // The 50% row is the headline sensitivity (WASTE_ATTRIBUTION_DECILE_P).
      // (fmtPct here is the PDF format-helper: 2 decimals fixed, no digits param.)
      `${fmtPct(s.p)}${s.p === a.decile.p ? ' (sensitivitas)' : ''}`,
      fmtIDR(s.trueWaste),
      fmtPct(s.impliedWasteToSales),
      fmtPct(s.impliedWasteShareOfLoss),
      `${s.decileShifts}/${a.decile.outletsRanked} outlet`,
    ]),
    cellColor: (row, ri, ci) => {
      // Hypothesis rows are visually quiet: the sensitivity row's p label
      // carries the watch hue; scenario VALUES stay neutral ink so they can
      // never be misread as measured figures.
      if (ri === headlineIdx && ci === 0) return C.dangerDark;
      return undefined;
    },
  });
  rpt.para(
    `True waste(p) = Waste + p \u00D7 residual. Decile: ranking waste/sales outlet (populasi ${a.decile.outletsRanked} outlet ber-sales positif` +
    (a.decile.outletsExcluded > 0 ? `, ${a.decile.outletsExcluded} outlet sales = 0 dikecualikan \u2014 rasio tak terdefinisi` : '') +
    `); pindah decile = perubahan minimal 1 decile bila waste tiap outlet diestimasi ulang pada p. Pada p = 50%: ${a.decile.outletsMoved} outlet berpindah (${fmtPct(a.decile.movedShare)} populasi).`,
    { size: 8, color: C.muted },
  );

  // ---- 5.3 Top Waste Items snapshot (current period, q-topcat reuse) ----
  // Cheap by design: reuses the topItems section's q-topcat rows (the fetch
  // gate was widened to needTopItems || needWaste — one shared cache row).
  // Per (item, resto) rows, top by nominal — the FULL ranking (with satuan,
  // prev qty, rata-rata) stays in the topItems section's 3.3 table.
  const topWaste = [...data.topItemsByWaste]
    .sort((x, y) => y.nominalWaste - x.nominalWaste)
    .slice(0, TOP_WASTE_SNAPSHOT_ROWS);
  if (topWaste.length > 0) {
    rpt.subhead(`5.3 Top Waste Items \u2014 snapshot periode ${currCol} (lihat tabel 3.3 untuk ranking lengkap)`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Resto' },
        { header: 'Area' },
        { header: 'Nominal Waste', align: 'right' },
        { header: 'QTY Waste', align: 'right' },
      ],
      rows: topWaste.map((it, i) => [
        String(i + 1),
        it.itemName,
        it.outletCode,
        it.area,
        fmtIDR(it.nominalWaste),
        fmtNum(it.qtyWaste),
      ]),
    });
  }

  // ---- MANDATORY structural disclosure (W10 guard) ----
  // pdfSafeDisclosure: ASCII-safe transcription for the two glyphs the
  // PDF's standard fonts cannot encode (see the helper above).
  rpt.noteBox(
    pdfSafeDisclosure(a.disclosure) + ' Bacaan yang benar untuk "residualShare mendekati 100%": porsi NET loss yang tidak ditutup W/S/T ' +
    '\u2014 properti struktur data, buktinya residual TLGTEU (43.925.875,94) identik dengan totalLoss-nya (43.925.875,95).',
  );
}
