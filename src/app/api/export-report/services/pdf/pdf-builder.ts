// ============================================================
//  pdf-builder — Stage 2 of /api/export-report GET pipeline (PDF)
//  --------------------------------------------------------
//  EXPORT-PDF: replaces docx-builder.ts (deleted). Output switched from
//  .docx → .pdf with a full report design: cover band, KPI hero cards,
//  numbered sections, zebra tables with repeated headers, and vector
//  charts (bars / lines / heat matrix).
//
//  SPLIT-GOD-FILE (user request: "split god file"): this file was
//  1.341 lines — the orchestrator, all 9 sections and every helper in
//  one drawReport() closure. It is now the SLIM orchestrator (~250
//  lines incl. this changelog); the rest moved verbatim:
//     ./pdf-style.ts          — pure helpers (fmtPp, fmtVsHist,
//                               shortMonth/titleCase/prettyWeek/
//                               periodCol/periodFull, heatColor,
//                               heatText, tickIDR, chgColor, mkGrowth)
//     ./section-context.ts    — SectionEnv (rpt/doc/data/ctx/labels) +
//                               createSectionEnv factory
//     ./sections/cover.ts     — cover band + KPI hero cards
//     ./sections/exec.ts      — 1 Ringkasan
//     ./sections/growth.ts    — 2 Perubahan vs <pembanding dinamai>
//     ./sections/top-items.ts — 3 Item Prioritas (3.1-3.6)
//     ./sections/variance.ts  — 4 Perubahan Item: Memburuk/Membaik
//     ./sections/trend-matrix.ts — 5 Trend Item Multi-Periode (heat)
//     ./sections/anomaly.ts   — 6 Item Anomali vs Riwayat Sendiri
//     ./sections/trend.ts     — 7 Trend Antar Periode (4 charts)
//     ./sections/peer.ts      — 8 Resto dengan Penjualan Kurang Lebih
//                               Sama
//     ./sections/flip.ts      — 9 Item yang Kemungkinan Plus Minus
//  (pdf-primitives.ts / pdf-charts.ts were already separate.)
//  The split is a pure code motion — verified by rendering the full
//  9-section mock before/after and byte-comparing the PDFs (identical
//  after normalizing pdfkit's /CreationDate + random trailer /ID).
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
//  HEAT-SIGN (user: "Warna minus di heat map aku pengen diberi warna beda,
//  jangan sampai konflik"): section 5's heat cells encode the SIGN —
//  red ramp for the loss side, green ramp for the surplus side (see
//  pdf-style.ts heatColor; magnitude still picks the step, scale still
//  p90 of the abs cells). rv 6 → 7 both sides.
//
//  STALE-PDF (user: "kok di laporan PDF tidak ada perubahan?" — after
//  PEERTOP/PEERTOP-R1 deployed): the `rv` bump was MISSING on both
//  PEERTOP commits, so the export URL stayed `rv=7` → (a) the CDN kept
//  serving its cached response (s-maxage=300 + swr=600) and (b) the
//  DB-level SWR store kept serving the EXPIRED pre-PEERTOP PDF row
//  under the unchanged key (swr.ts serves stale unbounded). Fix: rv
//  7 → 8 both sides + a `deploy` (VERCEL_GIT_COMMIT_SHA) component in
//  the route's cache key so EVERY deploy forks a fresh cache namespace —
//  a forgotten rv bump can never again serve a pre-deploy PDF.
//
//  Section map (FIXED numbers — stable across ?sections= selections;
//  keep in sync with EXPORT_SECTION_KEYS in validation.ts + the
//  SECTIONS list in ExportDialog.tsx):
//     1 exec        — Ringkasan (hero cards + KPI table)         sections/exec.ts
//     2 growth      — Perubahan vs <periode pembanding>          sections/growth.ts
//     3 topItems    — Item Prioritas (6 sub-tables)              sections/top-items.ts
//     4 variance    — Perubahan Item: Memburuk / Membaik         sections/variance.ts
//     5 itemTrend   — Trend Item Multi-Periode (heat matrix)     sections/trend-matrix.ts
//     6 anomali     — Item Anomali vs Riwayat Sendiri            sections/anomaly.ts
//     7 trend       — Trend Antar Periode (table + 4 charts)     sections/trend.ts
//     8 peer        — Resto dengan Penjualan Kurang Lebih Sama   sections/peer.ts
//     9 flip        — Item yang Kemungkinan Plus Minus           sections/flip.ts
//
//  Content rule (user request, EXPAND-1): EVERY rendered line is a SQL
//  aggregate, a factual label, or a formula definition — no generated
//  narrative sentences.
//
//  Returns { bufferBase64, fileName } for the route's cache wrapper
//  (P3-HYG-4: base64 keeps the cache row compact + JSON-serializable).
// ============================================================
import PDFDocument from 'pdfkit';
import type { ReportData, ReportContext } from '../types';
import { Rpt } from './pdf-primitives';
import { shortMonth, prettyWeek, titleCase } from './pdf-style';
import { createSectionEnv } from './section-context';
import { drawCover } from './sections/cover';
import { drawExecSection } from './sections/exec';
import { drawGrowthSection } from './sections/growth';
import { drawTopItemsSection } from './sections/top-items';
import { drawVarianceSection } from './sections/variance';
import { drawTrendMatrixSection } from './sections/trend-matrix';
import { drawAnomalySection } from './sections/anomaly';
import { drawTrendSection } from './sections/trend';
import { drawPeerSection } from './sections/peer';
import { drawFlipSection } from './sections/flip';

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
//  drawReport — orchestrates every section in FIXED order.
//  (SPLIT-GOD-FILE: the section bodies now live in ./sections/*.ts;
//  each draw* function early-returns when its ?sections= key is off.)
// ============================================================
function drawReport(doc: PDFKit.PDFDocument, data: ReportData, ctx: ReportContext): void {
  const rpt = new Rpt(doc);
  const env = createSectionEnv(rpt, doc, data, ctx);

  drawCover(env);               // cover band + KPI hero cards
  drawExecSection(env);         // 1 — Ringkasan
  drawGrowthSection(env);       // 2 — Perubahan vs <pembanding dinamai>
  drawTopItemsSection(env);     // 3 — Item Prioritas (3.1-3.6)
  drawVarianceSection(env);     // 4 — Perubahan Item (Memburuk/Membaik)
  drawTrendMatrixSection(env);  // 5 — Trend Item Multi-Periode (heat)
  drawAnomalySection(env);      // 6 — Item Anomali vs Riwayat Sendiri
  drawTrendSection(env);        // 7 — Trend Antar Periode
  drawPeerSection(env);         // 8 — Resto dengan Penjualan Kurang Lebih Sama
  drawFlipSection(env);         // 9 — Item yang Kemungkinan Plus Minus
}
