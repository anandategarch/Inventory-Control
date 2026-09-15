// ============================================================
//  4 — PERUBAHAN ITEM (MEMBURUK / MEMBAIK)  (EXPORT-TRIM: was 8)
// ============================================================
import { fmtIDR } from '../../format-helpers';
import { hBarChart } from '../pdf-charts';
import { C, PAGE, CONTENT_W, markOf } from '../pdf-primitives';
import { tickIDR } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawVarianceSection(env: SectionEnv): void {
  const { rpt, doc, data, hasSection, currCol, prevCol, cmpFull } = env;
  if (!hasSection('variance')) return;
  const va = data.varianceAnalysis;
  // BUG-HUNT (numbering continuity): the section HEADER itself used to be
  // skipped when both lists were empty — the report's section numbers
  // then jumped (…3 → 5…) because the numbers are FIXED, not
  // re-flowed. Render the header + a factual note instead (same
  // convention as sections 6/8/9).
  rpt.sectionHeader(4, cmpFull ? `Perubahan Item (vs ${cmpFull})` : 'Perubahan Item');
  if (va.topWorsened.length === 0 && va.topImproved.length === 0) {
    rpt.noteBox('Tidak ada perubahan item vs periode pembanding pada scope ini.');
  }
  if (va.topWorsened.length > 0) {
    rpt.subhead(`4.1 Memburuk \u2014 selisih nominal terbesar (${currCol} vs ${prevCol})`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        // REFINE-2 (user: "section yang belum punya satuan tambahain"):
        // per-item unit of measure, same convention as the 3.x tables.
        { header: 'Satuan' },
        { header: 'Resto' },
        { header: 'Area' },
        { header: `Nominal ${currCol}`, align: 'right' },
        { header: `Nominal ${prevCol}`, align: 'right' },
        { header: 'Selisih', align: 'right' },
      ],
      rows: va.topWorsened.map((it, i) => [String(i + 1), it.itemName, it.satuan ?? '\u2014', it.outletCode, it.area, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), markOf(it.selisih) + fmtIDR(it.selisih)]),
      // DESAIN-SIMPEL: only the Selisih column carries the change color
      // (red — worsened); the rest of the row stays neutral ink.
      cellColor: (_row, _ri, ci) => (ci === 7 ? C.danger : undefined),
    });
    const worsened = va.topWorsened.slice(0, 10);
    rpt.ensure(18 * worsened.length + 24);
    rpt.subhead('Selisih Nominal \u2014 Memburuk (Rp)', { size: 8.5, gapAfter: 2 });
    hBarChart(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * worsened.length,
      labels: worsened.map((it) => `${it.itemName} \u00B7 ${it.outletCode}`),
      values: worsened.map((it) => it.selisih),
      fmt: tickIDR,
      labelW: 150, valW: 52,
      colors: worsened.map(() => C.danger),
    });
    rpt.y += 18 * worsened.length + 8;
  }
  if (va.topImproved.length > 0) {
    rpt.subhead(`4.2 Membaik \u2014 penurunan selisih nominal terbesar (${currCol} vs ${prevCol})`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        { header: 'Satuan' },
        { header: 'Resto' },
        { header: 'Area' },
        { header: `Nominal ${currCol}`, align: 'right' },
        { header: `Nominal ${prevCol}`, align: 'right' },
        { header: 'Selisih', align: 'right' },
      ],
      rows: va.topImproved.map((it, i) => [String(i + 1), it.itemName, it.satuan ?? '\u2014', it.outletCode, it.area, fmtIDR(it.currentNominal), fmtIDR(it.previousNominal), markOf(it.selisih) + fmtIDR(it.selisih)]),
      // DESAIN-SIMPEL: only the Selisih column carries the change color
      // (green — improved); the rest of the row stays neutral ink.
      cellColor: (_row, _ri, ci) => (ci === 7 ? C.success : undefined),
    });
  }
}
