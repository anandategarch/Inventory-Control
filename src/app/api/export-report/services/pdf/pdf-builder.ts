// ============================================================
//  pdf-builder — Stage 2 of /api/export-report GET pipeline (PDF)
//  --------------------------------------------------------
//  EXPORT-PDF: replaces docx-builder.ts (deleted). Output switched from
//  .docx → .pdf with a full report design: cover band, KPI hero cards,
//  numbered sections, zebra tables with repeated headers, and vector
//  charts (bars / lines / heat matrix).
//
//  EXPORT-TRIM (user request): report trimmed 13 → 6 sections. Removed:
//  breakdown (Rincian Komposisi), area (Analisis per Area), outlets (Resto
//  Prioritas), pareto (Konsentrasi & Pareto), flip (Analisis Flip-Flop),
//  peer (Pembanding Peer-to-Peer), coverage (Lampiran). Explanatory
//  caption/legend lines under tables were removed per the same request.
//
//  FIX-TERPOTONG (user request: "laporan banyak yang terpotong … untuk
//  persen peningkatan beri tanda, penurunan juga"):
//    - NO truncation anywhere: tables use the auto-fit engine in
//      pdf-primitives (content-derived column widths + word-wrap +
//      variable row height); fixed-width slots (KPI cards, cover band,
//      chart labels) SHRINK the font instead of ellipsizing; filter
//      chips wrap onto extra lines instead of being dropped.
//    - ▲ / ▼ markers (MK_UP/MK_DN vector triangles) + semantic colors
//      on EVERY change column: Perubahan (section 1), Selisih & Growth %
//      (section 2), vs Hist (3.3-3.6), Selisih (4.1/4.2), Trend
//      (section 5) and the KPI hero card deltas. Green = favorable
//      direction, red = unfavorable (goodUp per metric — e.g. sales up
//      is green, deviation up is red).
//
//  DESAIN-SIMPEL (user request: "tidak kelihatan seperti buatan AI,
//  natural buatan manusia — simpel, sedikit warna, tetap merah/hijau
//  untuk perubahan"):
//    - Plain cover (no dark band), plain numbered section headers
//      ("1. Ringkasan" + thin rule — NO caption lines per request), no
//      page footer, light-gray table headers, neutral chart bars.
//    - Removed: Total LOSS / Total SURPLUS metrics (KPI cards, Ringkasan
//      rows, growth rows + bars, line-chart legend renamed Loss/Surplus).
//    - Title: "Ringkasan Laporan Deviasi" (was "LAPORAN AUDIT INVENTORY").
//    - Colors kept: ▲/▼ + red/green change markers, light-red heat scale.
//
//  REFINE-1 (user request round 4):
//    - SALES SECRECY: "Penjualan merupakan angka yang rahasia jadi
//      tampilkan aja persentasi kenaikan gak perlu nominal nya" — the
//      Penjualan KPI card shows ONLY the ▲/▼ % change (no Rp figure),
//      and the Penjualan rows are gone from the section 1/2 tables
//      (their % change lives on the card + the growth bars).
//    - "% Loss to Sales" / "% Surplus to Sales" rows + bars REMOVED
//      ("gak perlu jadi hapus aja").
//    - "% Nominal Deviasi to Sales" → renamed "Nominal Deviasi to Sales"
//      ("rename sesuai headernya").
//    - The word "pembanding" is replaced by the actual selected period
//      ("Misal Agustus 2026 week 1"): section titles, KPI subs and the
//      table column headers now carry the comparator's month + week
//      (e.g. "AGU 26 W1" in headers, "Agustus 2026 Week 1" in titles).
//    - 3.1 gains a "% Deviasi To BOM" column; 3.2 gains a "Nominal
//      Deviasi" column on its right.
//    - 3.3-3.6: "HIST (…)" + "vs Hist" renamed to "Rata-rata per Bulan" /
//      "vs Rata-rata" ("istilah rata-rata tiap bulannya"), a NEW
//      "Rata-rata Area" column (average of the area where the row's
//      resto is located), and the "Nominal (Rp)" column is REMOVED
//      ("hapus nominal nya biar fit").
//    - Heat map colors: percentile-scaled (p90 of the non-zero cells)
//      + a finer 6-step ramp — one outlier no longer flattens the whole
//      matrix to near-white ("warna heat map buat lebih akurat lagi").
//    - Section 6 table: Loss/Surplus columns REMOVED
//      ("trend antar periode hapuss kolom loss dan surplus").
//    - NEW section 7 "Resto dengan Penjualan Kurang Lebih Sama"
//      (peer-to-peer, renamed per request): peers' nominal deviations +
//      a per-item breakdown (kuantitas, % to BOM) vs the peer average.
//      Sales nominals are never printed.
//    - NEW section 8 "Item yang Kemungkinan Plus Minus antar Periode"
//      (flip-flop items, renamed per request).
//
//  REFINE-2 (user request, 3 items):
//    - Minimal cover header ("Hapus Bagian Header laporan itu. Cukup buat:
//      Ringkasan Laporan Deviasi / 1042.KWGGAL · September") — the
//      timestamp, "Periode pembanding", "Rata-rata per bulan" meta lines
//      and the Area/Kelompok/Resto/Item/PIC filter line are GONE; the
//      running header on pages 2+ mirrors the same minimal form.
//    - "Section yang belum punya satuan tambahain" — tables 4.1, 4.2, 5,
//      7.2 and 8 gain the per-item "Satuan" column (SQL: MAX(satuan) on
//      variance / item-trend-matrix / flip-ranking / peer-comparison-items;
//      cache sv forked so pre-deploy rows can't render '—').
//    - "Data yang terpotong di laporan sama" — root cause of the awkward
//      subhead wrap ("3.3 QTY Waste Terbesar (SEP 26 / W1)") fixed in
//      pdf-primitives Rpt.text: pdfkit's LineWrapper measures per-word
//      WITHOUT cross-word kerning, so some strings exceeded the passed
//      `width: tw + 2` by a fraction and wrapped their last word. No width
//      is passed anymore (see the note there) — single-line draws stay
//      single-line, deterministically.
//
//  REFINE-3 (user request, 5 items):
//    - HEAT TEXT CONFLICT ("Trend Item Multi-Periode warna nya konflik
//      dengan warna text"): the top heat step deepened to #DC2626 and
//      heat cells now pick their ink by fill luminance (heatText — white
//      on the deep step, full ink on the light ones; every step ≥ 4.5:1).
//      The old rowText that painted WHOLE rows red/green (readable mush
//      on the deeper heat fills) is gone — only the Trend column carries
//      the semantic color now.
//    - 3.3-3.6 gain a "vs Rata-rata Area" column (QTY as a % of the area
//      average — mirrors "vs Rata-rata"; data via the existing q-area-catavg
//      fetch, no new SQL).
//    - NEW section 6 "Item Anomali vs Riwayat Sendiri" (querySelfHistoryAnomaly:
//      current QTY vs the item-outlet's OWN same-week historical average,
//      eligibility departure ≥ 50% of the baseline, ranked by biggest
//      absolute departure; trend renumbered 6→7, peer 7→8, flip 8→9).
//    - NEW chart in section 7: "Komposisi Deviasi per Minggu" (stacked
//      Waste/Susut/Trial/Loss-Surplus magnitudes per week of the exported
//      month — queryWeeklyComposition, weeks after the exported week
//      excluded like the itemTrend matrix's future months).
//    - NEW chart in section 7: "Akumulasi Mingguan" (running total of the
//      month's deviation magnitude, "Week 1+2+…" labels — the last bar is
//      the month-to-date total as of the exported week).
//
//  BUG-HUNT (detailed pass over the whole report pipeline):
//    - CACHE VERSION: the `rv` cache-key bump was missing for REFINE-3 —
//      users would keep downloading the PREVIOUS design's PDF for up to
//      5 min (+ stale-while-revalidate) after the deploy. rv 4 → 5, both
//      sides (route.ts + useDashboardActions.ts).
//    - SIGNED-VS-ABS: the "Nominal Deviasi per Periode" bar chart passed
//      ABS values while its own table column (and sections 1/2 + the KPI
//      card) render SIGNED — a net-negative period drew an UP bar next to
//      a "-Rp …" row. Same class of bug in the trend table's "Nominal
//      Deviasi to Sales" (ABS — inconsistent with sections 1/2). Both now
//      signed; barChartV gained a diverging axis (negative bars grow DOWN
//      from the zero baseline, danger red).
//    - SECTION 5 RANKING: topItems scored each item by its MAX across all
//      shown months — an item that peaked in an old month but has no
//      current-period rows could crowd out the period's actual biggest
//      deviations. Ranked by the CURRENT month now (historical-only items
//      only fill leftover slots). trendPct anchored to the CURRENT month
//      too (an old-period % no longer masquerades as this period's trend).
//    - NUMBERING CONTINUITY: sections 4/5/7 skipped their HEADER when their
//      data was empty — the FIXED numbers then jumped (…3 → 5…). Headers
//      now always render when the section is selected, with a factual
//      noteBox when empty (convention of sections 6/8/9). Section 3 gains
//      the same note when all 6 top lists are empty.
//    - PAGE RESERVE: the four h:140 charts in section 7 reserved
//      ensure(150) but their block (subhead ≈14.5 + chart 140) is ≈154.5
//      — the chart's bottom edge spilled ~4.5pt into the bottom margin.
//      ensure(160) now.
//    - fmtVsHist: "+ x%" → "+x%" (spacing inconsistent with the +x% style
//      of every other change column in the report).
//
//  REFINE-4 (user pass — absolute benchmarks, flip detection, plain terms):
//    - RATA-RATA ABSOLUTE: querySelfHistoryAnomaly's historical average is
//      now AVG of per-period |SUM| (engine) — 3.3-3.6's q-hist-catavg was
//      already ABS. Report headers renamed "Rata-rata per Bulan" →
//      "Rata-rata Absolute" (3.3-3.6 + 6.1) per "di laporan di beri
//      keterangan Rata-Rata Absolute". "vs Rata-rata" / "vs Rata-rata Area"
//      now compare MAGNITUDE-to-magnitude ((|cur|−|base|)/|base|) — the old
//      signed formula painted 3.6's Loss/Surplus rows green when the
//      deviation had actually DOUBLED (−10 vs abs baseline 5 → "−300%").
//    - SECTION 6.2 (NEW — "deteksi yang biasanya loss tapi sekarang
//      surplus"): items whose direction REVERSED vs their own same-week
//      history (engine: sign reversal + history predominantly one
//      direction + material current side; separate flipRows list so flips
//      cannot be crowded out by magnitude rows). Shows the SIGNED
//      "Rata-rata Riwayat" + the "Pola" label (Biasanya Loss, Kini
//      Surplus / sebaliknya).
//    - SECTION 5 (user: "data yang ditampilkan nilai asli namun untuk ukuran
//      pemberian warna heat map pakai absolute"): month cells display the
//      SIGNED nominal (nilai asli) while the ranking / heat scale / Trend %
//      stay on the ABSOLUTE magnitude ("agar akurat").
//    - SECTION 9 (user: "gak perlu pakai P1 atau P2"): rows grouped by
//      their flip pair; each group's QTY headers carry the actual periods
//      ("QTY JUL W4" / "QTY AGU W4" — same `QTY <periode>` convention as
//      sections 3.3-3.6/6.1). Global # across groups keeps the risk order.
//    - 8.2 (user: "jangan pakai istilah peer"): "Rata-rata QTY Peer" /
//      "Rata-rata % Dev/BOM Peer" → "… Resto Setara" + the subhead spells
//      it out ("resto dengan omzet tidak jauh berbeda").
//    - fmtPp (user: "itu kok ada PP maksudnya apa?"): the Selisih of two
//      percentage metrics renders a PLAIN percent ("+23.99%") instead of
//      the analyst term "pp".
//
//  Section map (FIXED numbers — stable across ?sections= selections;
//  keep in sync with EXPORT_SECTION_KEYS in validation.ts + the
//  SECTIONS list in ExportDialog.tsx):
//     1 exec        — Ringkasan (hero cards + KPI table)
//     2 growth      — Perubahan vs <periode pembanding> (table + growth bars)
//     3 topItems    — Item Prioritas (6 sub-tables)
//     4 variance    — Perubahan Item: Memburuk / Membaik (tables + bars)
//     5 itemTrend   — Trend Item Multi-Periode (heat matrix)
//     6 anomali     — Item Anomali vs Riwayat Sendiri (REFINE-3 — NEW;
//                     trend renumbered 6→7, peer 7→8, flip 8→9; REFINE-4:
//                     6.1 magnitude vs Rata-rata Absolute + 6.2 flip table)
//     7 trend       — Trend Antar Periode (table + bar + line charts +
//                     weekly composition + weekly accumulation)
//     8 peer        — Resto dengan Penjualan Kurang Lebih Sama (REFINE-1)
//     9 flip        — Item yang Kemungkinan Plus Minus antar Periode (REFINE-1)
//
//  Content rule (user request, EXPAND-1): EVERY rendered line is a SQL
//  aggregate, a factual label, or a formula definition — no generated
//  narrative sentences.
//
//  Returns { bufferBase64, fileName } for the route's cache wrapper
//  (P3-HYG-4: base64 keeps the cache row compact + JSON-serializable).
// ============================================================
import PDFDocument from 'pdfkit';
import { calcGrowth } from '@/lib/metrics';
import { fmtIDR, fmtNum, fmtPct } from '../format-helpers';
import type { ReportData, ReportContext } from '../types';
import { Rpt, C, PAGE, CONTENT_W, MK_UP, markOf, stripMark } from './pdf-primitives';
import {
  barChartV, hBarChart, lineChart, stackedBarChartV,
} from './pdf-charts';

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
function fmtPp(v: number | null | undefined): string {
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
function fmtVsHist(current: number | null, histAvg: number | null): string {
  if (current == null || histAvg == null || histAvg === 0) return '\u2014';
  const pctChange = (Math.abs(current) - Math.abs(histAvg)) / Math.abs(histAvg);
  if (pctChange === 0) return '= 0%';
  const sign = pctChange > 0 ? '+' : '-';
  return markOf(pctChange) + sign + `${(Math.abs(pctChange) * 100).toFixed(1)}%`;
}

/** "Juli 2026" → "JUL 26" (same short format the docx export used). */
function shortMonth(label: string): string {
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
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** "WEEK 1" → "Week 1" (digit-less labels pass through). */
function prettyWeek(wl: string | null | undefined): string {
  if (!wl) return '\u2014';
  const n = wl.replace(/\D/g, '');
  return n ? `Week ${n}` : wl;
}

/** Column-header period: "SEP 26" + "WEEK 1" → "SEP 26 W1". */
function periodCol(monthLabel: string | null | undefined, weekLabel: string | null | undefined): string {
  const m = monthLabel ? shortMonth(monthLabel) : '\u2014';
  const n = weekLabel ? weekLabel.replace(/\D/g, '') : '';
  return n ? `${m} W${n}` : m;
}

/** Full period: "September 2026" + "WEEK 1" → "September 2026 Week 1". */
function periodFull(monthLabel: string | null | undefined, weekLabel: string | null | undefined): string {
  if (!monthLabel) return '\u2014';
  return `${titleCase(monthLabel)} ${prettyWeek(weekLabel)}`;
}

/** Heat color for the item-trend matrix cells — DESAIN-SIMPEL: light-red
 *  intensity scale (deviation magnitude = further into the red; the only
 *  chromatic family besides the change green).
 *  REFINE-1 ("warna heat map buat lebih akurat lagi"): the scale max is
 *  now the 90th PERCENTILE of the non-zero cells (computed by the caller),
 *  not the global max — one outlier row no longer compresses every other
 *  cell into the palest bucket — and the ramp has 6 steps instead of 5, so
 *  adjacent magnitudes are easier to tell apart. Values above the p90
 *  saturate at the deepest red.
 *  REFINE-3 (user: "Trend Item Multi-Periode warna nya konflik dengan
 *  warna text"): the top step deepened #EF4444 → #DC2626 so the DEEPEST
 *  cells can carry WHITE text at 4.8:1 contrast (dark ink on #EF4444 was
 *  only 2.7:1 with the old body ink). Every step now pairs with its text
 *  color at ≥ 4.5:1 — see heatText. */
function heatColor(v: number, scale: number): string | undefined {
  if (scale <= 0 || v <= 0) return undefined;
  const r = Math.min(1, v / scale);
  if (r < 1 / 6) return '#FEF2F2';
  if (r < 2 / 6) return '#FEE2E2';
  if (r < 3 / 6) return '#FECACA';
  if (r < 4 / 6) return '#FCA5A5';
  if (r < 5 / 6) return '#F87171';
  return '#DC2626';
}

/** REFINE-3 (user: "warna nya konflik dengan warna text, perbaiki dan cari
 *  opsi terbaik"): contrast-aware ink for a heat cell. Options considered:
 *  (a) soften the ramp so dark ink always works — loses the p90 range the
 *  user asked for in REFINE-1; (b) white text everywhere — 2.8:1 on the
 *  mid steps #F87171/#EF4444, worse than ink; (c) WCAG relative luminance:
 *  white when the fill is dark, FULL ink (#111827, not the softer #374151
 *  body ink) otherwise. Chose (c): every ramp step renders ≥ 4.5:1 —
 *  #FEF2F2…#F87171 with ink = 6.4–16.3:1, #DC2626 with white = 4.8:1 —
 *  and any future darker fill flips to white automatically. */
function heatText(fill: string): string {
  const r = parseInt(fill.slice(1, 3), 16) / 255;
  const g = parseInt(fill.slice(3, 5), 16) / 255;
  const b = parseInt(fill.slice(5, 7), 16) / 255;
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.2 ? C.white : C.ink;
}

/** Signed compact IDR for chart tick labels (no 'Rp' prefix — axis stays narrow). */
const tickIDR = (v: number): string => {
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}Jt`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
  return v.toFixed(0);
};

/**
 * FIX-TERPOTONG: semantic color for a change value given whether "up" is
 * the favorable direction (goodUp). Neutral (0 / missing) → undefined.
 */
function chgColor(v: number | null | undefined, goodUp: boolean): string | undefined {
  if (v == null || isNaN(v) || !isFinite(v) || v === 0) return undefined;
  return v > 0 ? (goodUp ? C.success : C.danger) : (goodUp ? C.danger : C.success);
}

/** Marker + signed growth string ("▲+1.23%") — null → '—'. */
const mkGrowth = (v: number | null | undefined): string =>
  v != null ? markOf(v) + fmtPct(v, true) : '\u2014';

// ============================================================
//  Main entry — buildPdfReport
// ============================================================
export async function buildPdfReport(
  data: ReportData,
  ctx: ReportContext,
): Promise<{ bufferBase64: string; fileName: string }> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    // bufferPages: keep every page addressable until end() — without it
    // pdfkit flushes the page buffer on every addPage(), so the post-hoc
    // running-header pass below saw bufferedPageRange() = { start: N-1,
    // count: 1 } and rendered the header ONLY... on the last page (and the
    // old footer read "Halaman N dari 1" — the exact bug in the user's
    // screenshot "Halaman 8 dari 1").
    bufferPages: true,
    info: {
      Title: `Ringkasan Laporan Deviasi ${shortMonth(data.period.monthLabel)} ${prettyWeek(data.period.weekLabel)}`,
      Author: 'Inventory Control',
      Creator: 'Inventory Control',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  return new Promise<{ bufferBase64: string }>((resolve, reject) => {
    doc.on('end', () => resolve({ bufferBase64: Buffer.concat(chunks).toString('base64') }));
    doc.on('error', reject);
    try {
      drawReport(doc, data, ctx);
      // Post-hoc pass: small running header on pages 2+ only — no footer
      // (DESAIN-SIMPEL: user asked to remove the page footer entirely).
      // REFINE-2: mirrors the new minimal cover header —
      // "Ringkasan Laporan Deviasi · <resto> · <bulan>".
      const range = doc.bufferedPageRange();
      const outletLabel = data.filters.outletCode && data.filters.outletCode !== 'all'
        ? data.filters.outletCode
        : 'Semua Resto';
      const headerLabel = `Ringkasan Laporan Deviasi  \u00B7  ${outletLabel}  \u00B7  ${titleCase(data.period.monthLabel.split(/\s+/)[0] ?? '')}`;
      for (let i = range.start; i < range.start + range.count; i++) {
        if (i === range.start) continue;
        doc.switchToPage(i);
        Rpt.runningHeader(doc, headerLabel);
      }
      doc.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  }).then((r) => {
    // fileName — sanitized to the RFC 2183/5987-safe charset (BUG-3-a C5
    // convention): outlet + month + week + compare suffix.
    const outletLabel = data.filters.outletCode && data.filters.outletCode !== 'all'
      ? data.filters.outletCode
      : 'Semua_Resto';
    const vs = data.period.comparisonWeek ? `_vs_${data.period.comparisonWeek}` : '';
    const raw = `Ringkasan_Laporan_Deviasi_${outletLabel}_${shortMonth(data.period.monthLabel).replace(/\s+/g, '_')}_${data.period.weekLabel}${vs}.pdf`;
    return { bufferBase64: r.bufferBase64, fileName: raw.replace(/[^A-Za-z0-9._-]/g, '_') };
  });
}

// ============================================================
//  drawReport — all pages/sections
// ============================================================
function drawReport(doc: PDFKit.PDFDocument, data: ReportData, ctx: ReportContext): void {
  const rpt = new Rpt(doc);
  const hasSection = (key: string): boolean => !ctx.sections || ctx.sections.includes(key);

  // ---- dynamic labels ------------------------------------------------
  const currLabel = shortMonth(data.period.monthLabel);
  // REFINE-1: the comparator is NAMED, not called "pembanding" — full form
  // for titles/subs ("Agustus 2026 Week 1"), column form for table headers
  // ("AGU 26 W1"). Every period reference also carries its week now (the
  // comparison is week-scoped).
  const currCol = periodCol(data.period.monthLabel, data.period.weekLabel);
  const prevCol = data.period.comparisonMonth ? periodCol(data.period.comparisonMonth, data.period.comparisonWeek) : '\u2014';
  const cmpFull = data.period.comparisonMonth ? periodFull(data.period.comparisonMonth, data.period.comparisonWeek) : null;
  const restoName = data.filters.outletCode && data.filters.outletCode !== 'all' ? data.filters.outletCode : 'Semua Resto';
  const s = data.executiveSummary;
  const pm = s._prevMetrics;
  const kpisAvailable = hasSection('exec') || hasSection('growth');

  // ============================================================
  //  COVER — plain title header + KPI cards
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
  // ============================================================
  rpt.coverBand(
    'Ringkasan Laporan Deviasi',
    `${restoName}  \u00B7  ${titleCase(data.period.monthLabel.split(/\s+/)[0] ?? '')}`,
    [],
  );

  // KPI hero cards (2 × 2) — only when the kpis row was fetched.
  // DESAIN-SIMPEL: Total LOSS / Total SURPLUS cards REMOVED (user
  // request); % Nominal Deviasi to Sales now shows its own growth sub.
  // FIX-TERPOTONG: every "vs …" sub carries the ▲/▼ marker + a semantic
  // color (green favorable / red unfavorable).
  // REFINE-1: SALES SECRECY (user: "Penjualan merupakan angka yang rahasia
  // jadi tampilkan aja persentasi kenaikan gak perlu nominal nya") — the
  // Penjualan card's VALUE is the ▲/▼ % change itself (no Rp figure),
  // colored green/red. The card's % Nominal Deviasi to Sales dropped its
  // "%-sign" prefix (renamed "Nominal Deviasi to Sales").
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

  // ============================================================
  //  1 — RINGKASAN  (EXPORT-TRIM: renamed from "Ringkasan Eksekutif")
  // ============================================================
  if (hasSection('exec')) {
    rpt.sectionHeader(1, 'Ringkasan');
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    // [label, current, change value (marker + color source), previous, goodUp]
    // REFINE-1: the Penjualan row is GONE (sales nominal is confidential —
    // its ▲/▼ % change lives on the cover KPI card + the growth bars);
    // % Loss to Sales / % Surplus to Sales rows REMOVED ("gak perlu jadi
    // hapus aja"); "% Nominal Deviasi to Sales" renamed "Nominal Deviasi
    // to Sales" ("rename sesuai headernya").
    const defs: Array<[string, string, number | null, string, boolean]> = [
      ['Nominal Deviasi', fmtIDR(s.nominalDeviasi.current), s.nominalDeviasi.growth, fmtIDR(s.nominalDeviasi.previous), false],
      ['Nominal Deviasi to Sales', fmtPct(devToSalesCur, false), devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null, fmtPct(devToSalesPrev, false), false],
      ['QTY BOM', fmtNum(s.qtyBom.current), s.qtyBom.growth, fmtNum(s.qtyBom.previous), true],
      ['QTY Deviasi', fmtNum(s.qtyDeviasi.current), s.qtyDeviasi.growth, fmtNum(s.qtyDeviasi.previous), false],
      ['% Deviasi To BOM', fmtPct(s.deviationToBom, false), pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, pm?.deviationToBom != null ? fmtPct(pm.deviationToBom, false) : '\u2014', false],
      ['QTY Waste', fmtNum(s.qtyWaste.current), s.qtyWaste.growth, fmtNum(s.qtyWaste.previous), false],
      ['QTY Susut', fmtNum(s.qtySusut.current), s.qtySusut.growth, fmtNum(s.qtySusut.previous), false],
      ['QTY Trial', fmtNum(s.qtyTrial.current), s.qtyTrial.growth, fmtNum(s.qtyTrial.previous), false],
      ['QTY Loss/Surplus', fmtNum(s.qtyLossSurplus.current), s.qtyLossSurplus.growth, fmtNum(s.qtyLossSurplus.previous), false],
      ['Loss/Surplus Qty', fmtNum(s.residualLossQty), pm?.residualLossQty != null ? calcGrowth(s.residualLossQty, pm.residualLossQty) : null, pm?.residualLossQty != null ? fmtNum(pm.residualLossQty) : '\u2014', false],
      ['Loss/Surplus %', fmtPct(s.residualLossPct, false), pm?.residualLossPct != null ? calcGrowth(s.residualLossPct, pm.residualLossPct) : null, pm?.residualLossPct != null ? fmtPct(pm.residualLossPct, false) : '\u2014', false],
    ];
    rpt.table({
      cols: [
        { header: 'Metrik' },
        { header: currCol, align: 'right' },
        { header: 'Perubahan', align: 'right' },
        { header: prevCol, align: 'right' },
      ],
      boldFirst: true,
      rows: defs.map((d) => [d[0], d[1], mkGrowth(d[2]), d[3]]),
      // FIX-TERPOTONG: ▲/▼ + semantic color on the Perubahan column only
      // (the rest of the row stays neutral ink).
      cellColor: (row, ri, ci) => (ci === 2 ? chgColor(defs[ri]?.[2], defs[ri]?.[4] ?? false) : undefined),
    });
  }

  // ============================================================
  //  2 — PERUBAHAN VS <PERIODE PEMBANDING DINAMAI>
  // REFINE-1: the title names the actual selected comparator period
  // ("Perubahan vs Agustus 2026 Week 1") — user: "Kata pembanding jadi Kata
  // periode yang terpilih menjadi pembanding. Misal Agustus 2026 week 1".
  // ============================================================
  if (hasSection('growth')) {
    rpt.sectionHeader(2, cmpFull ? `Perubahan vs ${cmpFull}` : 'Perubahan');
    const devToSalesCur = s.sales.current > 0 ? s.nominalDeviasi.current / s.sales.current : null;
    const devToSalesPrev = (s.sales.previous != null && s.sales.previous > 0 && s.nominalDeviasi.previous != null)
      ? s.nominalDeviasi.previous / s.sales.previous
      : null;
    type GRow = { cells: string[]; g: number | null; goodUp: boolean };
    const vr = (label: string, cur: number | null, prev: number | null, fmt: typeof fmtIDR, growth: number | null, goodUp: boolean): GRow => ({
      cells: [
        label, fmt(cur), fmt(prev),
        cur != null && prev != null ? markOf(cur - prev) + fmt(cur - prev) : '\u2014',
        mkGrowth(growth),
      ],
      g: growth, goodUp,
    });
    const rr = (label: string, cur: number | null, prev: number | null, growth: number | null, goodUp: boolean): GRow => ({
      cells: [
        label, fmtPct(cur, false), fmtPct(prev, false),
        cur != null && prev != null ? markOf(cur - prev) + fmtPp(cur - prev) : '\u2014',
        mkGrowth(growth),
      ],
      g: growth, goodUp,
    });
    // REFINE-1: Penjualan (Rp) row REMOVED (sales nominal confidential — the
    // % change lives on the cover card + the growth bars below); % Loss to
    // Sales / % Surplus to Sales rows REMOVED; "% Nominal Deviasi to Sales"
    // renamed "Nominal Deviasi to Sales".
    const defs: GRow[] = [
      vr('Nominal Deviasi (Rp)', s.nominalDeviasi.current, s.nominalDeviasi.previous, fmtIDR, s.nominalDeviasi.growth, false),
      vr('QTY BOM', s.qtyBom.current, s.qtyBom.previous, fmtNum, s.qtyBom.growth, true),
      vr('QTY Deviasi', s.qtyDeviasi.current, s.qtyDeviasi.previous, fmtNum, s.qtyDeviasi.growth, false),
      vr('QTY Waste', s.qtyWaste.current, s.qtyWaste.previous, fmtNum, s.qtyWaste.growth, false),
      vr('QTY Susut', s.qtySusut.current, s.qtySusut.previous, fmtNum, s.qtySusut.growth, false),
      vr('QTY Trial', s.qtyTrial.current, s.qtyTrial.previous, fmtNum, s.qtyTrial.growth, false),
      rr('% Deviasi To BOM', s.deviationToBom, pm?.deviationToBom ?? null, pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, false),
      rr('Nominal Deviasi to Sales', devToSalesCur, devToSalesPrev, devToSalesCur != null && devToSalesPrev != null ? calcGrowth(devToSalesCur, devToSalesPrev) : null, false),
    ];
    rpt.table({
      cols: [
        { header: 'Metrik' },
        { header: currCol, align: 'right' },
        { header: prevCol, align: 'right' },
        { header: 'Selisih', align: 'right' },
        { header: 'Growth %', align: 'right' },
      ],
      boldFirst: true,
      rows: defs.map((d) => d.cells),
      // ▲/▼ + semantic color on the Selisih and Growth % columns.
      cellColor: (row, ri, ci) => (ci === 3 || ci === 4 ? chgColor(defs[ri]?.g, defs[ri]?.goodUp ?? false) : undefined),
    });

    // growth % horizontal bars — sales/BOM up = green (good); deviation
    // metrics up = red (bad). Factual coloring by metric direction.
    // REFINE-1: the Penjualan BAR stays — it IS "tampilkan aja persentasi
    // kenaikan" (a % change, not a nominal). % Loss/% Surplus bars REMOVED.
    const withGrowth = [
      { label: 'Penjualan', g: s.sales.growth, goodUp: true },
      { label: 'Nominal Deviasi', g: s.nominalDeviasi.growth, goodUp: false },
      { label: 'QTY BOM', g: s.qtyBom.growth, goodUp: true },
      { label: 'QTY Deviasi', g: s.qtyDeviasi.growth, goodUp: false },
      { label: 'QTY Waste', g: s.qtyWaste.growth, goodUp: false },
      { label: 'QTY Susut', g: s.qtySusut.growth, goodUp: false },
      { label: 'QTY Trial', g: s.qtyTrial.growth, goodUp: false },
      { label: '% Dev/BOM', g: pm?.deviationToBom != null ? calcGrowth(s.deviationToBom, pm.deviationToBom) : null, goodUp: false },
    ].filter((r) => r.g != null) as Array<{ label: string; g: number; goodUp: boolean }>;
    if (withGrowth.length > 0) {
      rpt.ensure(18 * withGrowth.length + 24);
      rpt.subhead('Growth % per Metrik', { size: 8.5, gapAfter: 2 });
      hBarChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 18 * withGrowth.length,
        labels: withGrowth.map((r) => r.label),
        values: withGrowth.map((r) => r.g * 100),
        fmt: (v) => markOf(v) + `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
        colors: withGrowth.map((r) => (r.g > 0 ? (r.goodUp ? C.success : C.danger) : r.goodUp ? C.danger : C.success)),
        labelW: 118, valW: 52,
      });
      rpt.y += 18 * withGrowth.length + 6;
    }
  }

  // ============================================================
  //  3 — ITEM PRIORITAS (TOP ITEMS)  (EXPORT-TRIM: was 7)
  // ============================================================
  if (hasSection('topItems')) {
    rpt.sectionHeader(3, 'Item Prioritas (Top Items)');
    // BUG-HUNT (numbering continuity): when EVERY top list is empty the
    // section used to render as a bare header with nothing under it — now a
    // factual note states why (same convention as sections 6/8/9).
    if (data.topItemsByNominal.length === 0 && data.topItemsByDevBom.length === 0
      && data.topItemsByWaste.length === 0 && data.topItemsBySusut.length === 0
      && data.topItemsByTrial.length === 0 && data.topItemsByLossSurplus.length === 0) {
      rpt.noteBox('Tidak ada item dengan deviasi pada scope ini.');
    }

    // 3.1 nominal — REFINE-1: + "% Deviasi To BOM" column (user: "3.1
    // Nominal Deviasi Terbesar tambahkan % Deviasi to bom nya juga").
    if (data.topItemsByNominal.length > 0) {
      rpt.subhead(`3.1 Nominal Deviasi Terbesar (${currCol})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Resto' },
          { header: 'Satuan' },
          { header: `Nominal Deviasi`, align: 'right' },
          { header: '% Deviasi To BOM', align: 'right' },
        ],
        rows: data.topItemsByNominal.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtIDR(it.nominalDeviasi), fmtPct(it.devBom, false)]),
        rowText: (row) => (stripMark(row[4]).startsWith('-') ? C.danger : undefined),
      });
    }
    // 3.2 devBom — REFINE-1: + "Nominal Deviasi" column on the right (user:
    // "3.2 % Deviasi To BOM Terbesar tambahkan Nominal Deviasi juga di
    // sebelah kanan nya").
    if (data.topItemsByDevBom.length > 0) {
      rpt.subhead(`3.2 % Deviasi To BOM Terbesar (${currCol})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Resto' },
          { header: 'Satuan' },
          { header: '% Deviasi To BOM', align: 'right' },
          { header: 'Nominal Deviasi', align: 'right' },
        ],
        rows: data.topItemsByDevBom.map((it, i) => [String(i + 1), it.itemName, it.outletCode, it.satuan ?? '\u2014', fmtPct(it.devBom, false), fmtIDR(it.nominalDeviasi)]),
        rowText: (row) => (stripMark(row[5]).startsWith('-') ? C.danger : undefined),
      });
    }
    // 3.3-3.6 category tables
    // REFINE-1: "HIST (…)"/"vs Hist" → "Rata-rata per Bulan"/"vs Rata-rata";
    // + NEW "Rata-rata Area" column (avg across the area where the row's
    // resto is located); "Nominal (Rp)" column REMOVED ("hapus nominal nya
    // biar fit").
    const catTables: Array<{ title: string; items: Array<{ itemName: string; outletCode: string; satuan?: string | null; area: string; qty: number; nominal: number; prevQty: number | null; histAvgQty: number | null; areaAvgQty: number | null }> }> = [
      { title: `3.3 QTY Waste Terbesar (${currCol})`, items: data.topItemsByWaste.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyWaste, nominal: r.nominalWaste, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
      { title: `3.4 QTY Susut Terbesar (${currCol})`, items: data.topItemsBySusut.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtySusut, nominal: r.nominalSusut, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
      { title: `3.5 QTY Trial Terbesar (${currCol})`, items: data.topItemsByTrial.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyTrial, nominal: r.nominalTrial, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
      { title: `3.6 QTY Loss/Surplus Terbesar (${currCol})`, items: data.topItemsByLossSurplus.map((r) => ({ itemName: r.itemName, outletCode: r.outletCode, satuan: r.satuan, area: r.area, qty: r.qtyLossSurplus, nominal: r.nominalLossSurplus, prevQty: r.prevQty, histAvgQty: r.histAvgQty, areaAvgQty: r.areaAvgQty })) },
    ];
    for (const ct2 of catTables) {
      if (ct2.items.length === 0) continue;
      rpt.subhead(ct2.title, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Satuan' },
          { header: 'Resto' },
          { header: `QTY ${currCol}`, align: 'right' },
          { header: `QTY ${prevCol}`, align: 'right' },
          { header: 'Rata-rata Absolute', align: 'right' },
          { header: 'vs Rata-rata', align: 'right' },
          { header: 'Rata-rata Area', align: 'right' },
          // REFINE-3 (user: "Kolom 'vs Rata-rata Area'"): the item's QTY as
          // a % of the area average — mirrors the "vs Rata-rata" column so
          // the two benchmarks read side by side.
          { header: 'vs Rata-rata Area', align: 'right' },
        ],
        rows: ct2.items.map((it, i) => [
          String(i + 1),
          it.itemName,
          it.satuan ?? '\u2014',
          it.outletCode,
          fmtNum(it.qty),
          it.prevQty != null ? fmtNum(it.prevQty) : '\u2014',
          it.histAvgQty != null ? fmtNum(it.histAvgQty) : '\u2014',
          fmtVsHist(it.qty, it.histAvgQty),
          it.areaAvgQty != null ? fmtNum(it.areaAvgQty) : '\u2014',
          fmtVsHist(it.qty, it.areaAvgQty),
        ]),
        // ▲/▼ semantic color on the two "vs …" delta columns (up = bad —
        // these are all deviation-magnitude rankings). REFINE-3: the vs
        // Rata-rata Area column (ci 9) follows the same rule.
        // REFINE-4: MAGNITUDE comparison — the baselines are ABSOLUTE
        // averages, and 3.6's qtyLossSurplus is SIGNED, so a −10 current
        // vs a 5 abs baseline is a GROWN deviation (red), not a smaller
        // one. (Waste/Susut/Trial are always ≥ 0 — unchanged behavior.)
        cellColor: (row, ri, ci) => {
          if (ci !== 7 && ci !== 9) return undefined;
          const it = ct2.items[ri];
          if (it == null) return undefined;
          const base = ci === 7 ? it.histAvgQty : it.areaAvgQty;
          if (base == null || base === 0) return undefined;
          const mag = Math.abs(it.qty);
          return mag > base ? C.danger : mag < base ? C.success : undefined;
        },
      });
    }
  }

  // ============================================================
  //  4 — PERUBAHAN ITEM (MEMBURUK / MEMBAIK)  (EXPORT-TRIM: was 8)
  // ============================================================
  if (hasSection('variance')) {
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

  // ============================================================
  //  5 — TREND ITEM MULTI-PERIODE  (EXPORT-PDF — NEW; EXPORT-TRIM: was 9)
  // ============================================================
  if (hasSection('itemTrend')) {
    // BUG-HUNT (numbering continuity): an empty matrix used to skip the
    // whole section → the numbers jumped (…4 → 6…). Header + factual note
    // instead (convention of sections 6/8/9).
    rpt.sectionHeader(5, 'Trend Item Multi-Periode');
    if (data.itemTrendMatrix.length === 0) {
      rpt.noteBox('Tidak ada data trend item multi-periode pada scope ini.');
    } else {
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
      const val = byItem.get(row[0])?.get(ml)?.abs ?? 0;
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
        // same cell is driven by heatAt → .abs (see above).
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
    } // else (matrix non-empty)
  }

  // ============================================================
  //  6 — ITEM ANOMALI VS RIWAYAT SENDIRI  (REFINE-3 — NEW)
  //  --------------------------------------------------------
  //  User: "Section Item Anomali vs Riwayat Sendiri". Items whose current
  //  QTY deviasi departs most from their OWN same-week historical average
  //  ("Rata-rata per Bulan" — the identical window/benchmark as the
  //  3.3-3.6 tables, so the sections corroborate each other). Eligibility
  //  (querySelfHistoryAnomaly): departure ≥ 50% of the own baseline; ranked
  //  by the biggest absolute departure. histCount is surfaced in the
  //  subhead so the average's basis is stated (factual, no narrative).
  // ============================================================
  if (hasSection('anomali')) {
    rpt.sectionHeader(6, 'Item Anomali vs Riwayat Sendiri');
    const an = data.selfHistoryAnomaly;
    if (an.length === 0) {
      // BUG-HUNT (found in render test): '≥' is NOT WinAnsi-encodable —
      // sanitizePdfText maps it to '?' in the PDF. Plain wording instead.
      rpt.noteBox(ctx.historicalPeriods.length === 0
        ? 'Belum ada periode riwayat (bulan sebelumnya dengan minggu yang sama) untuk dibandingkan.'
        : 'Tidak ada item dengan penyimpangan minimal 50% dari rata-rata absolute riwayatnya sendiri pada scope ini.');
    } else {
      const nBulan = an.reduce((mx, it) => Math.max(mx, it.histCount), 0);
      // REFINE-4 (user: "di laporan di beri keterangan Rata-Rata Absolute"):
      // the benchmark column is the ABSOLUTE average of the item's own
      // same-week history — stated in both the subhead and the header.
      rpt.subhead(`6.1 Kuantitas vs Rata-rata Riwayat Sendiri (same-week, maks ${nBulan} bulan; rata-rata absolute)`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Item' },
          { header: 'Resto' },
          { header: 'Area' },
          { header: 'Satuan' },
          { header: `QTY ${currCol}`, align: 'right' },
          { header: 'Rata-rata Absolute', align: 'right' },
          { header: 'Selisih', align: 'right' },
          { header: 'vs Riwayat', align: 'right' },
          { header: 'Nominal Deviasi', align: 'right' },
        ],
        rows: an.map((it, i) => [
          String(i + 1),
          it.itemName,
          it.outletCode,
          it.area,
          it.satuan ?? '\u2014',
          fmtNum(it.qty),
          fmtNum(it.histAvgQty),
          markOf(it.deltaQty) + fmtNum(it.deltaQty),
          fmtVsHist(it.qty, it.histAvgQty),
          fmtIDR(it.nominal),
        ]),
        // ▲/▼ semantic color on the Selisih + vs Riwayat columns, judged by
        // MAGNITUDE (REFINE-4: histAvgQty is now the ABSOLUTE average and
        // deltaQty is |qty| − histAvg, so the comparison is already
        // magnitude-to-magnitude): |cur| > histAvg = red (the deviation
        // widened), |cur| < histAvg = green.
        cellColor: (_row, ri, ci) => {
          if (ci !== 7 && ci !== 8) return undefined;
          const it = an[ri];
          if (it == null) return undefined;
          return Math.abs(it.qty) > it.histAvgQty
            ? C.danger
            : Math.abs(it.qty) < it.histAvgQty ? C.success : undefined;
        },
      });

      // 6.2 — REFINE-4 (user: "apakah sudah bisa deteksi yang biasanya loss
      // tapi sekarang surplus? kalau belum tambahkan"): items whose
      // direction REVERSED vs their own same-week history. "Rata-rata
      // Riwayat" here is the SIGNED average (it shows the usual direction,
      // e.g. -12.3 = loss side) — a different lens from 6.1's absolute
      // benchmark, hence its own column name. Eligibility (engine):
      // history predominantly one direction + a material current side.
      const flips = data.selfHistoryFlips;
      rpt.subhead('6.2 Item Berganti Arah \u2014 biasanya loss, kini surplus (atau sebaliknya)', { size: 8.5 });
      if (flips.length === 0) {
        rpt.noteBox('Tidak ada item yang berganti arah (loss menjadi surplus atau sebaliknya) dibanding riwayatnya sendiri pada scope ini.');
      } else {
        rpt.table({
          cols: [
            { header: '#', align: 'center' },
            { header: 'Item' },
            { header: 'Resto' },
            { header: 'Area' },
            { header: 'Satuan' },
            { header: 'Rata-rata Riwayat', align: 'right' },
            { header: `QTY ${currCol}`, align: 'right' },
            { header: 'Pola', align: 'center' },
            { header: 'Nominal Deviasi', align: 'right' },
          ],
          rows: flips.map((it, i) => [
            String(i + 1),
            it.itemName,
            it.outletCode,
            it.area,
            it.satuan ?? '\u2014',
            fmtNum(it.histSignedAvgQty),
            fmtNum(it.qty),
            it.flip === 'lossToSurplus' ? 'Biasanya Loss, Kini Surplus' : 'Biasanya Surplus, Kini Loss',
            fmtIDR(it.nominal),
          ]),
          // Direction coloring on the two QTY columns (green = surplus side,
          // red = loss side — same convention as section 9); the Pola text
          // stays neutral ink (a flip is a pattern to investigate, not a
          // good/bad verdict — DESAIN-SIMPEL).
          cellColor: (_row, ri, ci) => {
            if (ci !== 5 && ci !== 6) return undefined;
            const it = flips[ri];
            if (it == null) return undefined;
            const v = ci === 5 ? it.histSignedAvgQty : it.qty;
            return v < 0 ? C.danger : v > 0 ? C.success : undefined;
          },
        });
      }
    }
  }

  // ============================================================
  //  7 — TREND ANTAR PERIODE  (EXPORT-TRIM: was 12; REFINE-3: was 6)
  //  REFINE-1: Loss / Surplus table columns REMOVED (user: "Trend antar
  //  periode hapuss kolom loss dan surplus") — the loss-vs-surplus line
  //  chart below still carries that composition per period.
  //  REFINE-3: + the current month's weekly composition chart (user:
  //  "Grafik komposisi Waste/Susut/Trial/Loss-Surplus") + the weekly
  //  accumulation chart (user: "Tren akumulasi mingguan (Week 1+2+)").
  // ============================================================
  if (hasSection('trend')) {
    // BUG-HUNT (numbering continuity): empty trend data used to skip the
    // whole section → the numbers jumped. Header + factual note instead.
    rpt.sectionHeader(7, 'Trend Antar Periode');
    if (data.trend.length === 0) {
      rpt.noteBox('Tidak ada data trend antar periode pada scope ini.');
    } else {
    rpt.table({
      cols: [
        { header: 'Periode' },
        { header: 'Nominal Deviasi', align: 'right' },
        { header: '% Dev/BOM', align: 'right' },
        { header: 'Nominal Deviasi to Sales', align: 'right' },
      ],
      rows: data.trend.map((t) => [
        t.weekLabel,
        fmtIDR(t.nominal),
        fmtPct(t.devBom, false),
        // BUG-HUNT: SIGNED (was Math.abs — the same metric renders signed
        // in sections 1/2 + the KPI card; an ABS here contradicted the
        // signed "Nominal Deviasi" column right next to it).
        t.sales && t.sales > 0 ? fmtPct(t.nominal / t.sales, false) : '\u2014',
      ]),
    });

    const labels = data.trend.map((t) => t.weekLabel.replace(` ${currLabel.split(' ')[0]}`, '').replace(/\s*$/, '')).map((l, i) => (data.trend.length > 8 && i % 2 === 1 ? '' : l));
    // bar — nominal per period
    // BUG-HUNT: SIGNED values (was Math.abs) + barChartV's new diverging
    // axis — a net-negative period now draws a red bar DOWN from the zero
    // baseline, matching the signed table instead of contradicting it.
    rpt.ensure(160);
    rpt.subhead('Nominal Deviasi per Periode (Rp)', { size: 8.5, gapAfter: 2 });
    barChartV(doc, {
      x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
      labels,
      values: data.trend.map((t) => t.nominal),
      fmt: tickIDR,
    });
    rpt.y += 140 + 16;

    // line — loss vs surplus
    if (data.trend.length >= 2) {
      rpt.ensure(160);
      rpt.subhead('Loss vs Surplus per Periode (Rp)', { size: 8.5, gapAfter: 2 });
      lineChart(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
        xLabels: labels,
        series: [
          // DESAIN-SIMPEL: per-period legend labels — no "Total" wording
          // (the Total LOSS/SURPLUS metrics were removed by user request).
          { name: 'Loss', values: data.trend.map((t) => t.lossNominal), color: C.danger },
          { name: 'Surplus', values: data.trend.map((t) => t.surplusNominal), color: C.success },
        ],
        yFmt: tickIDR,
      });
      rpt.y += 140 + 16;
    }

    // REFINE-3 (user: "Grafik komposisi Waste/Susut/Trial/Loss-Surplus"):
    // per-week composition of the CURRENT month's deviation magnitude —
    // ABS nominal per category (their stack = the week's total deviation
    // magnitude). Weeks after the exported week are already excluded
    // upstream (data-fetcher — same rule as the itemTrend matrix's future
    // months). Palette: 3 neutral grays + danger red on the Loss/Surplus
    // residual (the unexplained remainder is the flag-worthy category).
    const wc = data.weeklyComposition;
    if (wc.length > 0) {
      // BUG-HUNT: reserve subhead (≈14.5) + chart (140) — the old 150 let
      // the chart's bottom edge spill ~4.5pt into the bottom margin.
      rpt.ensure(160);
      rpt.subhead(`Komposisi Deviasi per Minggu — ${titleCase(data.period.monthLabel)} (Rp)`, { size: 8.5, gapAfter: 2 });
      stackedBarChartV(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
        labels: wc.map((r) => `W${r.weekNo}`),
        series: [
          { name: 'Waste', values: wc.map((r) => r.nominalWaste), color: C.inkSoft },
          { name: 'Susut', values: wc.map((r) => r.nominalSusut), color: C.muted },
          { name: 'Trial', values: wc.map((r) => r.nominalTrial), color: C.faint },
          { name: 'Loss/Surplus', values: wc.map((r) => r.nominalLossSurplus), color: C.danger },
        ],
        fmt: tickIDR,
      });
      rpt.y += 140 + 16;

      // REFINE-3 (user: "Tren akumulasi mingguan (Week 1+2+…)"): running
      // total of the month's deviation magnitude — bar j is the cumulative
      // absTotal of weeks 1..j ("W1+2+…"), so the last bar is the
      // month-to-date total as of the exported week (highlighted by
      // barChartV's default last-bar emphasis).
      let acc = 0;
      const cum = wc.map((r) => { acc += r.absTotal; return acc; });
      const cumLabels = wc.map((_r, j) => 'W' + wc.slice(0, j + 1).map((r) => r.weekNo).join('+'));
      rpt.ensure(160);
      rpt.subhead('Akumulasi Mingguan — Total Deviasi (Rp)', { size: 8.5, gapAfter: 2 });
      barChartV(doc, {
        x: PAGE.M, y: rpt.y, w: CONTENT_W, h: 140,
        labels: cumLabels,
        values: cum,
        fmt: tickIDR,
      });
      rpt.y += 140 + 16;
    }
    } // else (trend rows exist)
  }

  // ============================================================
  //  8 — RESTO DENGAN PENJUALAN KURANG LEBIH SAMA  (REFINE-1 — NEW;
  //       REFINE-3: was 7)
  //  --------------------------------------------------------
  //  User: "Tambahkan section Peer to Peer tapi ganti istilah nya menjadi
  //  'Dengan Total Penjualan yang kurang lebih sama Resto lain menghasilkan
  //  nominal deviasi ini dan ada break down per item nya berapa secara
  //  kuantiti, % to bom'".
  //  8.1 = the similar-sales restos and the nominal deviations they produce
  //  (peer band = sales within ±10% of the target — same-period mode).
  //  8.2 = the per-item breakdown for the target's top items: kuantitas +
  //        % to BOM, vs the peer average.
  //  SALES SECRECY: no sales nominal is ever printed here.
  // ============================================================
  if (hasSection('peer')) {
    rpt.sectionHeader(8, 'Resto dengan Penjualan Kurang Lebih Sama');
    const pc = data.peerComparison;
    if (!pc || pc.peers.length === 0) {
      rpt.noteBox('Data pembanding tidak tersedia untuk filter ini \u2014 pilih satu resto pada Filter Resto (tab Resto Analysis) lalu export ulang.');
    } else {
      const targetLabel = `${pc.targetOutlet.name} (${pc.targetOutlet.code})`;
      // 8.1 — peers' nominal deviations, biggest first; the target row is
      // bold (named in the subhead — factual, no legend needed).
      const sortedPeers = [...pc.peers].sort((a, b) => Math.abs(b.nominalDeviasi) - Math.abs(a.nominalDeviasi));
      rpt.subhead(`8.1 Nominal Deviasi per Resto (penjualan kurang lebih sama dengan ${targetLabel}${pc.autoTarget ? ' \u2014 target otomatis: resto deviasi terbesar' : ''})`, { size: 8.5 });
      rpt.table({
        cols: [
          { header: '#', align: 'center' },
          { header: 'Resto' },
          { header: 'Area' },
          { header: 'Nominal Deviasi', align: 'right' },
          { header: '% Deviasi To BOM', align: 'right' },
          { header: 'QTY Deviasi', align: 'right' },
        ],
        rows: sortedPeers.map((p, i) => [
          String(i + 1),
          `${p.outletName} (${p.outletCode})`,
          p.area,
          fmtIDR(p.nominalDeviasi),
          fmtPct(p.devBom, false),
          fmtNum(p.qtyDeviasi),
        ]),
        rowBold: (_row, i) => sortedPeers[i]?.isTarget ?? false,
        rowText: (row) => (row[3].startsWith('-') ? C.danger : undefined),
      });

      // 8.2 — per-item breakdown: kuantitas + % to BOM, target vs the
      // average of the similar-sales restos.
      // REFINE-4 (user: "jangan pakai istilah peer tapi coba pakai yang
      // lebih mudah. Misalnya resto dengan omzet yang tidak beda jauh"):
      // "Rata-rata … Peer" headers → "Rata-rata … Resto Setara" (the
      // section title "Resto dengan Penjualan Kurang Lebih Sama" defines
      // what "setara" means; the subhead spells it out in the user's own
      // words — omzet tidak jauh berbeda).
      if (pc.items.length > 0) {
        rpt.subhead(`8.2 Breakdown per Item (kuantitas, % to BOM) \u2014 ${targetLabel} vs rata-rata resto dengan omzet tidak jauh berbeda`, { size: 8.5 });
        rpt.table({
          cols: [
            { header: 'Item' },
            // REFINE-2 ("section yang belum punya satuan tambahain"): unit of
            // measure per item — the QTY columns are satuan-denominated.
            { header: 'Satuan' },
            { header: 'QTY Deviasi', align: 'right' },
            { header: '% Deviasi To BOM', align: 'right' },
            { header: 'Rata-rata QTY Resto Setara', align: 'right' },
            { header: 'Rata-rata % Dev/BOM Resto Setara', align: 'right' },
          ],
          rows: pc.items.map((it) => [
            it.itemName,
            it.satuan ?? '\u2014',
            fmtNum(it.target.qtyDeviasi),
            fmtPct(it.target.devBom, false),
            it.peerAvg != null ? fmtNum(it.peerAvg.qtyDeviasi) : '\u2014',
            it.peerAvg != null ? fmtPct(it.peerAvg.devBom, false) : '\u2014',
          ]),
        });
      }
    }
  }

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
  //  REFINE-4 (user: "SATUAN PERIODE 1 QTY DEVIASI P1 PERIODE 2 QTY
  //  DEVIASI P2 gak perlu pakai P1 atau P2 langsung aja tampilkan periode
  //  nya di header sama seperti section lainnya"): the rows are GROUPED
  //  by their flip pair (each item's most balanced pair is item-specific),
  //  and each group's table carries the actual periods in the QTY column
  //  headers — "QTY JUL W4" / "QTY AGU W4" — the same `QTY <periode>`
  //  convention as sections 3.3-3.6/6.1. No more P1/P2 ordinal jargon.
  // ============================================================
  if (hasSection('flip')) {
    rpt.sectionHeader(9, 'Item yang Kemungkinan Plus Minus antar Periode');
    const fr = data.flipRanking;
    const flipRows = (fr?.items ?? []).filter((it) => it.topFlips.length > 0).slice(0, 10);
    if (flipRows.length === 0) {
      rpt.noteBox('Tidak ada item dengan pola plus minus antar periode pada scope ini.');
    } else {
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
  }
}
