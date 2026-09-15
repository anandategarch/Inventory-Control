// ============================================================
//  pdf-style — pure formatting / color helpers for the export PDF
//  --------------------------------------------------------
//  SPLIT-GOD-FILE: extracted verbatim from pdf-builder.ts (which was
//  1.341 lines — one file held the orchestrator, all 9 sections and
//  every helper). These are the PURE helpers with no Rpt/doc state:
//  number/percent formatters, period label builders, the two-hue heat
//  ramp, and the semantic change-color rule. Sections import what they
//  need; pdf-builder imports shortMonth/prettyWeek/titleCase for the
//  doc metadata + running header.
// ============================================================
import { fmtPct } from '../format-helpers';
import { C, markOf } from './pdf-primitives';

// ------------------------------------------------------------
//  Local formatters (moved from the deleted docx-builder.ts — identical
//  formatting logic, byte-for-byte parity for the shared ones)
// ------------------------------------------------------------

/** REFINE-4 (user: "itu kok ada PP maksudnya apa? ganti yang lebih
 *  mudah"): the Selisih of two percentage metrics now renders as a
 *  PLAIN percent — "+23.99%" — instead of the analyst term "pp"
 *  (percentage points). 44.92% − 20.92% reading as Selisih "+23.99%" is
 *  self-explanatory, and the neighboring "Growth %" column header keeps
 *  the relative change unambiguous. */
export function fmtPp(v: number | null | undefined): string {
  if (v == null || isNaN(v) || !isFinite(v)) return '\u2014';
  const pp = v * 100;
  const sign = pp > 0 ? '+' : '';
  return `${sign}${pp.toFixed(2)}%`;
}

/** FIX-TERPOTONG: vs-historical delta now carries the ▲/▼ marker.
 *  BUG-HUNT: sign spacing normalized to "+x%"/"-x%" (was "+ x%" with a
 *  space — inconsistent with the "+x%" style of every other change column
 *  in the report: Perubahan, Growth %, Selisih).
 *  REFINE-4: MAGNITUDE semantics — (|current| − |base|) / |base|. The
 *  baselines (Rata-rata Absolute, Rata-rata Area) are ABSOLUTE averages,
 *  so a signed current (e.g. Loss/Surplus rows: −10 vs abs baseline 5)
 *  must be compared magnitude-to-magnitude: the old signed formula
 *  showed "−300%" (green) for a deviation that had DOUBLED. For the
 *  always-≥ 0 categories (Waste/Susut/Trial) this is byte-identical. */
export function fmtVsHist(current: number | null, histAvg: number | null): string {
  if (current == null || histAvg == null || histAvg === 0) return '\u2014';
  const pctChange = (Math.abs(current) - Math.abs(histAvg)) / Math.abs(histAvg);
  if (pctChange === 0) return '= 0%';
  const sign = pctChange > 0 ? '+' : '-';
  return markOf(pctChange) + sign + `${(Math.abs(pctChange) * 100).toFixed(1)}%`;
}

/** "Juli 2026" → "JUL 26" (same short format the docx export used). */
export function shortMonth(label: string): string {
  if (!label) return '\u2014';
  const parts = label.trim().split(/\s+/);
  if (parts.length >= 2) {
    const month = parts[0].substring(0, 3).toUpperCase();
    const year = parts[1].length === 4 ? parts[1].substring(2) : parts[1];
    return `${month} ${year}`;
  }
  return label.substring(0, 10);
}

// ------------------------------------------------------------
//  REFINE-1 period label helpers — the user asked for the comparator to
//  be named as the actual selected period ("Misal Agustus 2026 week 1")
//  instead of the generic word "pembanding", and every period reference
//  now carries its week (the comparison is week-scoped).
// ------------------------------------------------------------

/** "AGUSTUS 2026" / "Agustus 2026" → "Agustus 2026". */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** "WEEK 1" → "Week 1" (digit-less labels pass through). */
export function prettyWeek(wl: string | null | undefined): string {
  if (!wl) return '\u2014';
  const n = wl.replace(/\D/g, '');
  return n ? `Week ${n}` : wl;
}

/** Column-header period: "SEP 26" + "WEEK 1" → "SEP 26 W1". */
export function periodCol(monthLabel: string | null | undefined, weekLabel: string | null | undefined): string {
  const m = monthLabel ? shortMonth(monthLabel) : '\u2014';
  const n = weekLabel ? weekLabel.replace(/\D/g, '') : '';
  return n ? `${m} W${n}` : m;
}

/** Full period: "September 2026" + "WEEK 1" → "September 2026 Week 1". */
export function periodFull(monthLabel: string | null | undefined, weekLabel: string | null | undefined): string {
  if (!monthLabel) return '\u2014';
  return `${titleCase(monthLabel)} ${prettyWeek(weekLabel)}`;
}

/** Heat color for the item-trend matrix cells — DESAIN-SIMPEL: light
 *  intensity scale (deviation magnitude = further into the color; the only
 *  chromatic families besides the change green/red).
 *  REFINE-1 ("warna heat map buat lebih akurat lagi"): the scale max is
 *  now the 90th PERCENTILE of the non-zero cells (computed by the caller),
 *  not the global max — one outlier row no longer compresses every other
 *  cell into the palest bucket — and the ramp has 6 steps instead of 5, so
 *  adjacent magnitudes are easier to tell apart. Values above the p90
 *  saturate at the deepest step.
 *  REFINE-3 (user: "Trend Item Multi-Periode warna nya konflik dengan
 *  warna text"): the top step deepened #EF4444 → #DC2626 so the DEEPEST
 *  cells can carry WHITE text at 4.8:1 contrast (dark ink on #EF4444 was
 *  only 2.7:1 with the old body ink). Every step now pairs with its text
 *  color at ≥ 4.5:1 — see heatText.
 *  HEAT-SIGN (user: "Warna minus di heat map aku pengen diberi warna beda,
 *  jangan sampai konflik"): TWO-HUE ramp — the CELL VALUE's sign picks the
 *  family, |value|/scale picks the step. Negative (net loss side) keeps
 *  the red ramp; positive (net surplus side) goes GREEN — mirroring the
 *  report-wide convention (Loss = red, Surplus = green: section 7's line
 *  chart, 6.2, 9). Before this, a −7.500 and a +7.500 cell rendered the
 *  SAME red at the same intensity — the sign was only in the digits. The
 *  green ramp mirrors the red step-for-step (Tailwind green-50…400, then
 *  green-700 #15803D as the saturating top: white ink lands at 5.0:1,
 *  vs #DC2626's 4.8:1 — heatText's luminance rule handles both). */
export function heatColor(v: number, scale: number): string | undefined {
  if (scale <= 0 || v === 0) return undefined;
  const neg = v < 0;
  const r = Math.min(1, Math.abs(v) / scale);
  if (r < 1 / 6) return neg ? '#FEF2F2' : '#F0FDF4';
  if (r < 2 / 6) return neg ? '#FEE2E2' : '#DCFCE7';
  if (r < 3 / 6) return neg ? '#FECACA' : '#BBF7D0';
  if (r < 4 / 6) return neg ? '#FCA5A5' : '#86EFAC';
  if (r < 5 / 6) return neg ? '#F87171' : '#4ADE80';
  return neg ? '#DC2626' : '#15803D';
}

/** REFINE-3 (user: "warna nya konflik dengan warna text, perbaiki dan cari
 *  opsi terbaik"): contrast-aware ink for a heat cell. Options considered:
 *  (a) soften the ramp so dark ink always works — loses the p90 range the
 *  user asked for in REFINE-1; (b) white text everywhere — 2.8:1 on the
 *  mid steps #F87171/#EF4444, worse than ink; (c) WCAG relative luminance:
 *  white when the fill is dark, FULL ink (#111827, not the softer #374151
 *  body ink) otherwise. Chose (c): every ramp step renders ≥ 4.5:1 —
 *  #FEF2F2…#F87171 with ink = 6.4–16.3:1, #DC2626 with white = 4.8:1 —
 *  and any future darker fill flips to white automatically. (HEAT-SIGN:
 *  the same rule serves the green ramp — only its #15803D top step is
 *  dark enough for white, at 5.0:1.) */
export function heatText(fill: string): string {
  const r = parseInt(fill.slice(1, 3), 16) / 255;
  const g = parseInt(fill.slice(3, 5), 16) / 255;
  const b = parseInt(fill.slice(5, 7), 16) / 255;
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.2 ? C.white : C.ink;
}

/** Signed compact IDR for chart tick labels (no 'Rp' prefix — axis stays narrow). */
export const tickIDR = (v: number): string => {
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
  return v.toFixed(0);
};

/**
 * FIX-TERPOTONG: semantic color for a change value given whether "up" is
 * the favorable direction (goodUp). Neutral (0 / missing) → undefined.
 */
export function chgColor(v: number | null | undefined, goodUp: boolean): string | undefined {
  if (v == null || isNaN(v) || !isFinite(v) || v === 0) return undefined;
  return v > 0 ? (goodUp ? C.success : C.danger) : (goodUp ? C.danger : C.success);
}

/** Marker + signed growth string ("▲+1.23%") — null → '—'. */
export const mkGrowth = (v: number | null | undefined): string =>
  v != null ? markOf(v) + fmtPct(v, true) : '\u2014';
