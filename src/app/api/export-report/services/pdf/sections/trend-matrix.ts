// ============================================================
//  5 — TREND ITEM MULTI-PERIODE  (EXPORT-PDF — NEW; EXPORT-TRIM: was 9)
// ============================================================
import { fmtIDR } from '../../format-helpers';
import { C, MK_UP, markOf, stripMark } from '../pdf-primitives';
import { heatColor, heatText, shortMonth } from '../pdf-style';
import type { SectionEnv } from '../section-context';

export function drawTrendMatrixSection(env: SectionEnv): void {
  const { rpt, data, hasSection } = env;
  if (!hasSection('itemTrend')) return;
  // BUG-HUNT (numbering continuity): an empty matrix used to skip the
  // whole section → the numbers jumped (…4 → 6…). Header + factual note
  // instead (convention of sections 6/8/9).
  rpt.sectionHeader(5, 'Trend Item Multi-Periode');
  if (data.itemTrendMatrix.length === 0) {
    rpt.noteBox('Tidak ada data trend item multi-periode pada scope ini.');
    return;
  }
  // group rows: item → month → {abs (magnitude), signed (nilai asli)}
  // REFINE-4 (user: "aku pengen data yang ditampilkan nilai asli namun
  // untuk ukuran pemberian warna heat map pakai absolute agar akurat"):
  // the CELLS now display the SIGNED nominal (nilai asli — negative =
  // net loss side), while the ranking / heat scale / Trend % stay on
  // the ABSOLUTE magnitude ("Terbesar" convention + "agar akurat").
  const byMonth = new Map<string, string>(); // monthLabel → monthKey (for sort)
  const byItem = new Map<string, Map<string, { abs: number; signed: number }>>();
  for (const r of data.itemTrendMatrix) {
    byMonth.set(r.monthLabel, r.monthKey ?? '9999-99');
    let m = byItem.get(r.itemName);
    if (!m) { m = new Map(); byItem.set(r.itemName, m); }
    m.set(r.monthLabel, { abs: r.absNominal, signed: r.nominalDeviasi });
  }
  const months = [...byMonth.keys()].sort((a, b2) => {
    const ka = byMonth.get(a) ?? '9999-99';
    const kb = byMonth.get(b2) ?? '9999-99';
    return ka.localeCompare(kb);
  });
  // Months AFTER the exported month (e.g. Agustus rows when the report is
  // for Juli — already imported for the upcoming period) are EXCLUDED: the
  // report's timeline ends at its own period. Fallback: when the exported
  // month itself has no rows for this weekLabel, keep the raw month list.
  const curKey = byMonth.get(data.period.monthLabel) ?? null;
  const monthsUpToCurrent = curKey != null
    ? months.filter((m) => (byMonth.get(m) ?? '9999-99').localeCompare(curKey) <= 0)
    : months;
  // keep the LAST 7 periods (incl. current), in chronological order
  const shownMonths = (monthsUpToCurrent.length > 0 ? monthsUpToCurrent : months).slice(-7);
  // (the exported month is always the LAST shown column — the header row
  // is self-evident, no extra marker needed)

  // BUG-HUNT (ranking): the old itemScore took the item's MAX across ALL
  // shown months, so an item that peaked in an old month but has no
  // current-period rows could crowd out the period's actual biggest
  // deviations — in a report titled by the CURRENT period. Rank by the
  // CURRENT month's absNominal; historical-only items only fill leftover
  // slots (tie-break: their own historical max).
  const curMl = shownMonths.find((ml) => ml === data.period.monthLabel)
    ?? shownMonths[shownMonths.length - 1]
    ?? null;
  const histMax = (m: Map<string, { abs: number; signed: number }>): number =>
    [...m.entries()].filter(([ml]) => shownMonths.includes(ml)).reduce((acc, [, v]) => Math.max(acc, v.abs), 0);
  const topItems = [...byItem.entries()]
    .filter(([_, m]) => shownMonths.some((ml) => m.has(ml)))
    .sort((a, b2) => {
      const ca = curMl != null ? (a[1].get(curMl)?.abs ?? 0) : histMax(a[1]);
      const cb = curMl != null ? (b2[1].get(curMl)?.abs ?? 0) : histMax(b2[1]);
      return cb - ca || histMax(b2[1]) - histMax(a[1]);
    })
    .slice(0, 15);

  // REFINE-1 ("warna heat map buat lebih akurat lagi"): the color scale
  // is anchored at the 90th PERCENTILE of the non-zero cells instead of
  // the global max — one outlier item no longer pushes every other cell
  // into the palest two buckets, and mid-range differences get visible
  // steps (see heatColor: 6-step ramp, saturating above p90).
  const cellVals = topItems
    .flatMap(([, m]) => shownMonths.map((ml) => m.get(ml)?.abs ?? 0))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const heatScale = cellVals.length > 0 ? cellVals[Math.floor((cellVals.length - 1) * 0.9)] : 0;
  // FIX-TERPOTONG: trend % carries the ▲/▼ marker (BARU = item muncul
  // baru → treated as an increase).
  // BUG-HUNT: the % is anchored to the CURRENT month — the old code used
  // the item's LAST APPEARING month, so an item missing from the current
  // period showed an old-period % that read as this period's trend. Such
  // items now show '—' (their current-month cell is '—' too).
  // REFINE-4: the Trend % stays on the ABSOLUTE magnitude ((|cur| − |prev|)
  // / |prev|) so the ▲/▼ marker and red/green color remain accurate when a
  // signed cell crosses zero (a +5.000 → −7.500 swing IS a magnitude GROWTH
  // of +50%, red — a signed formula would print −250% and paint it green).
  const trendPct = (m: Map<string, { abs: number; signed: number }>): string => {
    if (curMl == null || !m.has(curMl)) return '\u2014';
    const curIdx = shownMonths.reduce((acc, ml, i) => (ml === curMl ? i : acc), -1);
    if (curIdx < 1) return '\u2014';
    const cur = m.get(curMl)?.abs ?? 0;
    const prev = m.get(shownMonths[curIdx - 1])?.abs ?? 0;
    if (prev === 0) return cur === 0 ? '= 0%' : MK_UP + 'BARU';
    const pct = ((cur - prev) / Math.abs(prev)) * 100;
    return markOf(pct) + `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };

  const monthLabel = (ml: string): string => shortMonth(ml);
  // REFINE-2: per-item satuan (unit of measure) — MAX across the item's
  // period rows ("section yang belum punya satuan tambahain").
  const satuanByItem = new Map<string, string>();
  for (const r of data.itemTrendMatrix) {
    if (r.satuan != null) satuanByItem.set(r.itemName, r.satuan);
  }
  // REFINE-3 (user: "Trend Item Multi-Periode warna nya konflik dengan
  // warna text"): hoisted heat-fill lookup shared by cellFill + cellColor.
  const heatAt = (row: string[], ci: number): string | undefined => {
    // ci 0 = Item, ci 1 = Satuan, last = Trend — no heat fill; the month
    // columns start at ci 2.
    if (ci <= 1 || ci > shownMonths.length + 1) return undefined;
    const ml = shownMonths[ci - 2];
    // HEAT-SIGN: the fill takes the SIGNED value — heatColor picks the
    // family (red = loss side / green = surplus side) from the sign, and
    // the step from |value| / heatScale (heatScale itself stays the p90
    // of the ABSOLUTE cells — REFINE-4 "ukuran pemberian warna pakai
    // absolute agar akurat").
    const val = byItem.get(row[0])?.get(ml)?.signed ?? 0;
    return heatColor(val, heatScale);
  };
  rpt.table({
    cols: [
      { header: 'Item' },
      { header: 'Satuan' },
      ...shownMonths.map((ml) => ({ header: monthLabel(ml), align: 'right' as const })),
      { header: 'Trend', align: 'right' },
    ],
    rows: topItems.map(([name, m]) => [
      name,
      satuanByItem.get(name) ?? '\u2014',
      // REFINE-4: nilai ASLI (signed) in the cells; the heat fill on the
      // same cell is driven by heatAt → .signed (HEAT-SIGN: family by
      // sign) — see above.
      ...shownMonths.map((ml) => (m.has(ml) ? fmtIDR(m.get(ml)?.signed) : '\u2014')),
      trendPct(m),
    ]),
    cellFill: (row, _ri, ci) => heatAt(row, ci),
    // REFINE-3: the OLD rowText painted the WHOLE row (item name + the
    // heat cells themselves) in the trend's red/green — red-on-red mush
    // on the deeper heat steps. Now ONLY the Trend column carries the
    // semantic color (DESAIN-SIMPEL "only the change column is colored"
    // convention, same as sections 1/2/4), and heat cells pick their ink
    // by the fill's luminance (heatText: white on the deep step, full ink
    // on the light steps).
    cellColor: (row, _ri, ci) => {
      const fill = heatAt(row, ci);
      if (fill != null) return heatText(fill);
      const last = row.length - 1;
      if (ci === last) {
        const t = stripMark(row[last]);
        return t.startsWith('+') || t === 'BARU' ? C.danger : t.startsWith('-') ? C.success : undefined;
      }
      return undefined;
    },
  });
}
