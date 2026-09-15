// ============================================================
//  cover — plain title header + KPI hero cards
//  --------------------------------------------------------
//  (DESAIN-SIMPEL: no TOC — the report is short and every section is
//  numbered; nothing navigational was lost)
//  REFINE-2 (user: "Hapus Bagian Header laporan itu. Cukup buat:
//  Ringkasan Laporan Deviasi / 1042.KWGGAL · September"): the cover
//  header is now ONLY the title + the outlet · month subtitle — the
//  timestamp / "Periode pembanding" / "Rata-rata per bulan" meta lines
//  AND the Area/Kelompok/Resto/Item/PIC filter line are GONE. The named
//  comparator period still lives in every section title + KPI sub where
//  it matters; the week scope stays visible in the table column headers
//  (e.g. "SEP 26 W1").
//
//  KPI hero cards (2 × 2) — only when the kpis row was fetched.
//  DESAIN-SIMPEL: Total LOSS / Total SURPLUS cards REMOVED (user
//  request); % Nominal Deviasi to Sales now shows its own growth sub.
//  FIX-TERPOTONG: every "vs …" sub carries the ▲/▼ marker + a semantic
//  color (green favorable / red unfavorable).
//  REFINE-1: SALES SECRECY (user: "Penjualan merupakan angka yang rahasia
//  jadi tampilkan aja persentasi kenaikan gak perlu nominal nya") — the
//  Penjualan card's VALUE is the ▲/▼ % change itself (no Rp figure),
//  colored green/red. The card's % Nominal Deviasi to Sales dropped its
//  "%-sign" prefix (renamed "Nominal Deviasi to Sales").
// ============================================================
import { calcGrowth } from '@/lib/metrics';
import { fmtIDR, fmtPct } from '../../format-helpers';
import { C, markOf } from '../pdf-primitives';
import { chgColor, titleCase } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawCover(env: SectionEnv): void {
  const { rpt, data, hasSection, cmpFull, restoName } = env;
  const s = data.executiveSummary;
  const pm = s._prevMetrics;
  const kpisAvailable = hasSection('exec') || hasSection('growth');

  rpt.coverBand(
    'Ringkasan Laporan Deviasi',
    `${restoName}  \u00B7  ${titleCase(data.period.monthLabel.split(/\s+/)[0] ?? '')}`,
    [],
  );

  if (kpisAvailable) {
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    const devToSalesG = devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null;
    // Hoisted (TS narrowing through repeated pm?.x ternaries inside one
    // object literal is fragile) — also avoids re-running calcGrowth.
    const bomG = pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null;
    rpt.kpiCards([
      {
        label: 'Penjualan',
        value: s.sales.growth != null ? markOf(s.sales.growth) + fmtPct(s.sales.growth, true) : '\u2014',
        valueColor: chgColor(s.sales.growth, true),
        sub: cmpFull ?? undefined,
        subColor: C.muted,
      },
      {
        label: 'Nominal Deviasi', value: fmtIDR(s.nominalDeviasi.current),
        sub: s.nominalDeviasi.growth != null && cmpFull ? `${markOf(s.nominalDeviasi.growth)}vs ${cmpFull}: ${fmtPct(s.nominalDeviasi.growth, true)}` : undefined,
        subColor: chgColor(s.nominalDeviasi.growth, false) ?? C.muted,
      },
      {
        label: '% Deviasi To BOM', value: fmtPct(s.deviationToBom, false),
        sub: bomG != null && cmpFull ? `${markOf(bomG)}vs ${cmpFull}: ${fmtPct(bomG, true)}` : undefined,
        subColor: chgColor(bomG, false) ?? C.muted,
      },
      {
        label: 'Nominal Deviasi to Sales', value: fmtPct(devToSalesCur, false),
        sub: devToSalesG != null && cmpFull ? `${markOf(devToSalesG)}vs ${cmpFull}: ${fmtPct(devToSalesG, true)}` : undefined,
        subColor: chgColor(devToSalesG, false) ?? C.muted,
      },
    ], { perRow: 2 });
  }
}
