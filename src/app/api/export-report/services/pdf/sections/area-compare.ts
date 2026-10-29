// ============================================================
//  12 — PERBANDINGAN AREA  (LEAGUE-AREA — NEW)
//  --------------------------------------------------------
//  User request: "Export 1 by one 1 resto dan area" — the FE's
//  AreaComparison card (tab Area) carried into the PDF: EVERY area
//  gets ONE row — jumlah resto, |nominal deviasi|, % Dev/BOM, % Loss
//  to Sales — plus a bar chart of the deviation magnitude per area.
//
//  Data: queryAreaAnalysis under the SAME 'q-area' cache row the
//  analysis pipeline builds (identical period + filters → one scan
//  for both). The area filter is nulled INSIDE the query (all areas
//  always shown — dashboard parity); the outlet filter was stripped
//  at the fetch (populationFilters) so the area table keeps its full
//  population even when the export targets one resto. The selected
//  area (FilterBar, when aktif) is highlighted amber + bold.
//
//  SALES SECRECY (REFINE-1): totalSales feeds only the loss/sales
//  RATIO — the sales nominal itself is never printed.
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { hBarChart } from '../pdf-charts';
import { C, PAGE, CONTENT_W } from '../pdf-primitives';
import { tickIDR } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawAreaCompareSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, hasSub, currCol } = env;
  if (!hasSection('areaCompare')) return;
  rpt.sectionHeader(12, 'Perbandingan Area');
  const rows = data.areaComparison;
  if (rows.length === 0) {
    rpt.noteBox('Data perbandingan area tidak tersedia untuk kombinasi filter ini.');
    return;
  }
  const focusArea =
    data.filters.area && data.filters.area !== 'all' ? data.filters.area : null;
  const showTabel = hasSub('areaCompare', 'tabel');
  const showGrafik = hasSub('areaCompare', 'grafik');

  // 12.1 — every area, one row each, ranked by |nominal deviasi| DESC
  // (the query's own sort order).
  if (showTabel) {
    rpt.subhead(
      `12.1 Semua area satu per satu (${rows.length} area) \u2014 peringkat dari nominal deviasi terbesar (${currCol})` +
        (focusArea ? `, ${focusArea} ter-highlight` : ''),
      { size: 8.5 },
    );
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Area' },
        { header: 'Resto', align: 'right' },
        { header: 'Nominal Deviasi (Rp, nilai absolut)', align: 'right' },
        { header: '% Deviasi To BOM', align: 'right' },
        { header: '% Loss to Sales', align: 'right' },
      ],
      rows: rows.map((r, i) => [
        String(i + 1),
        r.area,
        fmtNum(r.outletCount),
        fmtIDR(r.totalAbsNominal),
        fmtPct(r.avgDevBom, false),
        r.lossToSales != null ? fmtPct(r.lossToSales, false) : '\u2014',
      ]),
      // Selected-area row: bold + light amber fill (same convention as
      // the focus resto in section 11).
      rowBold: (_row, i) => rows[i]?.area === focusArea,
      cellFill: (_row, ri) =>
        focusArea && rows[ri]?.area === focusArea ? C.focusRow : undefined,
    });
  }

  // 12.2 — |nominal deviasi| per area (bars, biggest first). All areas
  // when they fit one block (14 areas today), else the top 14 — the
  // table above already carries every row "satu per satu".
  if (showGrafik && rows.length > 0) {
    const chartRows = rows.slice(0, 14);
    const chartH = 18 * chartRows.length;
    // Reserve subhead (≈14.5) + chart — the BUG-HUNT PAGE RESERVE
    // convention (trend.ts's ensure(160) for h:140 charts).
    rpt.ensure(chartH + 18);
    rpt.subhead('Nominal Deviasi per Area (Rp, nilai absolut)', {
      size: 8.5,
      gapAfter: 2,
    });
    hBarChart(doc, {
      x: PAGE.M,
      y: rpt.y,
      w: CONTENT_W,
      h: chartH,
      labels: chartRows.map((r) => r.area),
      values: chartRows.map((r) => r.totalAbsNominal),
      fmt: tickIDR,
      labelW: 118,
      valW: 52,
      // Current-period bar tone (pdf-style's C.barCur semantics — the
      // neutral darker gray reserved for the exported period).
      barColor: C.barCur,
      boldLabels: chartRows.map((r) => r.area === focusArea),
    });
    rpt.y += chartH + 8;
  }
}
