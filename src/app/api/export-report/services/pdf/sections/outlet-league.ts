// ============================================================
//  11 — PERINGKAT RESTO  (LEAGUE-AREA — NEW)
//  --------------------------------------------------------
//  User request: "Export 1 by one 1 resto dan area" — a league table
//  where EVERY resto in the filter scope gets ONE row ("satu per
//  satu"), ranked by |nominal deviasi| DESC. Complements section 9
//  (which stays target-centric: 1 resto vs its ±10% similar-sales
//  band) with the full-population view the FE's OutletHealthRanking /
//  peer table only show on screen.
//
//  Data: queryOutletHealthRanking over the shared q-outlet-agg scan
//  (populationFilters — the outlet filter is deliberately STRIPPED at
//  the fetch: a league scoped to the focus resto would be one row;
//  the focus row is instead highlighted here, the PDF twin of the
//  FE's ITEM-HL-B amber highlight). Long tables auto-paginate with
//  repeated headers (pdf-primitives).
//
//  SALES SECRECY (REFINE-1): the sales nominal is never printed —
//  only the loss/sales RATIO (a percentage, same policy as the peer
//  section; OutletHealthRow.sales feeds the ratio alone).
// ============================================================
import { fmtIDR, fmtNum, fmtPct } from '../../format-helpers';
import { C } from '../pdf-primitives';
import { negColor } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawOutletLeagueSection(env: SectionEnv): void {
  const { rpt, data, hasSection, currCol } = env;
  if (!hasSection('outletLeague')) return;
  rpt.sectionHeader(11, 'Peringkat Resto');
  const rows = data.outletLeague;
  if (rows.length === 0) {
    rpt.noteBox('Data peringkat resto tidak tersedia untuk kombinasi filter ini.');
    return;
  }
  const focusCode =
    data.filters.outletCode && data.filters.outletCode !== 'all'
      ? data.filters.outletCode
      : null;
  rpt.subhead(
    `11.1 Semua resto satu per satu (${rows.length} resto) \u2014 peringkat dari nominal deviasi terbesar (${currCol})` +
      (focusCode ? `, ${focusCode} ter-highlight` : ''),
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
    rows: rows.map((r, i) => [
      String(i + 1),
      `${r.outletName} (${r.outletCode})`,
      r.area,
      fmtIDR(r.nominalDeviasi),
      r.totalQtyBom > 0 ? fmtPct(r.totalQtyDeviasi / r.totalQtyBom, false) : '\u2014',
      fmtNum(r.totalQtyDeviasi),
      r.sales > 0 ? fmtPct(r.lossNominal / r.sales, false) : '\u2014',
    ]),
    // Focus-resto row: bold (peer.ts 9.1's target convention) + light
    // amber fill (C.focusRow — the PDF twin of the FE's ITEM-HL-B
    // bg-amber-50 highlight).
    rowBold: (_row, i) => rows[i]?.outletCode === focusCode,
    cellFill: (_row, ri) =>
      focusCode && rows[ri]?.outletCode === focusCode ? C.focusRow : undefined,
    // PDFCOLOR-1 (minus-red on VALUE columns — the league's two signed
    // columns only; the rest of the row stays neutral ink).
    cellColor: (row, _ri, ci) =>
      ci === 3 || ci === 5 ? negColor(row[ci]) : undefined,
  });
}
