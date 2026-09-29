// ============================================================
//  9 — ITEM YANG KEMUNGKINAN PLUS MINUS ANTAR PERIODE  (REFINE-1 — NEW;
//       REFINE-3: was 8)
//  --------------------------------------------------------
//  User: "Tambahkan juga item yang flip flop namun ganti istilah nya
//  menjadi Item yang kemungkinan Plus Minus antar Periode".
//  Each row shows an item's most BALANCED sign reversal between two
//  consecutive same-week periods (e.g. +100 in Jul W4 → -98 in Agu W4):
//  QTY Deviasi positive = green (plus), negative = red (minus); Net near
//  zero = the reversal is nearly symmetrical.
//  VAR11 (user: "ini juga kok selisih nya banyak ya? harusnya selisih
//  dikit"): the section's row order no longer follows the query's
//  riskScore (volume-of-flips — an item with MANY badly-balanced parsial
//  flips outranked an item with ONE nearly-perfect reversal, so the PDF
//  showed huge Nets like -41.335 next to a "plus minus" title). The
//  export now re-ranks the FULL candidate pool by BALANCE: the item's
//  best pair (topFlips[0] — already lowest-disparity) sorted by
//  disparityPct ASC, tie-broken by |Net| ASC — the displayed rows are
//  the items whose reversal selisih is SMALLEST, which is the pattern
//  the section exists to flag. queryFlipRanking itself (and the
//  frontend's risk panel) still sorts by riskScore — only the PDF's
//  presentation order changed (see query-batch.ts limit 10 → 200).
//  REFINE-4 (user: "SATUAN PERIODE 1 QTY DEVIASI P1 PERIODE 2 QTY
//  DEVIASI P2 gak perlu pakai P1 atau P2 langsung aja tampilkan periode
//  nya di header sama seperti section lainnya"): the rows are GROUPED
//  by their flip pair (each item's most balanced pair is item-specific),
//  and each group's table carries the actual periods in the QTY column
//  headers — "QTY JUL W4" / "QTY AGU W4" — the same `QTY <periode>`
//  convention as sections 3.3-3.6/6.1. No more P1/P2 ordinal jargon.
// ============================================================
import { fmtNum } from '../../format-helpers';
import { C } from '../pdf-primitives';
import type { SectionEnv } from '../section-context';

export function drawFlipSection(env: SectionEnv): void {
  const { rpt, data, hasSection } = env;
  if (!hasSection('flip')) return;
  rpt.sectionHeader(9, 'Item yang Kemungkinan Plus Minus antar Periode');
  const fr = data.flipRanking;
  // VAR11: rank by BALANCE, not risk volume. fr.items arrives sorted by
  // riskScore DESC (the query's/frontend's convention — left untouched);
  // re-sort a copy by the item's best pair: disparityPct ASC (most
  // balanced reversal first), tie-break |net| ASC (smallest absolute
  // selisih), then itemName for a deterministic order. Filtering out
  // topFlips-less items first — they have nothing to display.
  const flipRows = (fr?.items ?? [])
    .filter((it) => it.topFlips.length > 0)
    .slice()
    .sort((a, b) => {
      const fa = a.topFlips[0];
      const fb = b.topFlips[0];
      if (fa.disparityPct !== fb.disparityPct) return fa.disparityPct - fb.disparityPct;
      const na = Math.abs(fa.net);
      const nb = Math.abs(fb.net);
      if (na !== nb) return na - nb;
      return a.itemName.localeCompare(b.itemName);
    })
    .slice(0, 10);
  if (flipRows.length === 0) {
    rpt.noteBox('Tidak ada item dengan pola plus minus antar periode pada scope ini.');
    return;
  }
  // Group the top-10 rows by their (period1, period2) pair, in order of
  // first appearance (flipRows is risk-ranked — a group's position is
  // its best item's rank). REFINE-4b: rows renumber 1..n PER GROUP —
  // the global cross-group ranks (#1,#4 / #2,#3) read as gaps ("where
  // are #2/#3?"); every other table in the report numbers rows from 1.
  const groups = new Map<string, Array<{ rank: number; item: typeof flipRows[number] }>>();
  flipRows.forEach((it, i) => {
    const fp = it.topFlips[0];
    const key = `${fp.period1Label}\u0000${fp.period2Label}`;
    const g = groups.get(key) ?? [];
    g.push({ rank: i + 1, item: it });
    groups.set(key, g);
  });
  let subNo = 0;
  for (const [key, g] of groups) {
    subNo += 1;
    const [p1, p2] = key.split('\u0000');
    // BUG-HUNT #7 class ('≥' → '?'): U+2192 (→) is NOT WinAnsi-encodable
    // either — sanitizePdfText maps it to '?'. En dash U+2013 IS in the
    // WINANSI_EXTRA set; "Jul W1 – Agu W1" reads the same.
    rpt.subhead(`9.${subNo} ${p1} \u2013 ${p2}`, { size: 8.5 });
    rpt.table({
      cols: [
        { header: '#', align: 'center' },
        { header: 'Item' },
        // REFINE-2 ("section yang belum punya satuan tambahain"): the QTY
        // Deviasi / Net columns are satuan-denominated.
        { header: 'Satuan' },
        // REFINE-4: the period lives IN the header — same `QTY <periode>`
        // convention as the other sections (uppercase to match).
        { header: `QTY ${p1.toUpperCase()}`, align: 'right' },
        { header: `QTY ${p2.toUpperCase()}`, align: 'right' },
        { header: 'Net', align: 'right' },
      ],
      rows: g.map(({ item }, gi) => {
        const fp = item.topFlips[0];
        return [String(gi + 1), item.itemName, item.satuan ?? '\u2014', fmtNum(fp.qtyP1), fmtNum(fp.qtyP2), fmtNum(fp.net)];
      }),
      // Plus/minus coloring on the two QTY columns — the visual point of
      // the section: green = plus (surplus side), red = minus (loss side).
      cellColor: (_row, ri, ci) => {
        if (ci !== 3 && ci !== 4) return undefined;
        const fp = g[ri]?.item.topFlips[0];
        if (fp == null) return undefined;
        const v = ci === 3 ? fp.qtyP1 : fp.qtyP2;
        return v < 0 ? C.danger : v > 0 ? C.success : undefined;
      },
    });
  }
}
