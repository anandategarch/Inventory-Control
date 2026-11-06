// ============================================================
//  Route-specific schemas — export-report.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema, one consumer route:
//  /api/export-report.
// ============================================================
import { z } from 'zod';
import {
  isExportSectionToken,
  MAX_COMPARE_OUTLETS,
  MAX_COMPARE_AREAS,
} from '@/lib/export-sections';
import {
  monthLabelSchema,
  weekLabelSchema,
  compareWeekSchema,
  areaSchema,
  kelompokSchema,
  outletCodeSchema,
  itemNameSchema,
  picSchema,
  noControlChars,
} from './shared';

// /api/export-report?month=&week=&sections=&area=&kelompok=&outlet=&item=&pic=
// FIX (BUG-3-a C6): unknown section keys used to vanish silently
// (?sections=exec,topitems → section 3 just missing from the report, no
// error). The valid token set now lives in src/lib/export-sections.ts
// (SUBSECTION-1) — the SINGLE registry shared with ExportDialog.tsx,
// section-gates.ts and section-context.ts (kills this file's old
// "keep in sync" copy of the key list).
// SUBSECTION-1 (user request: "sub section ini juga harusnya bisa aku
// centang juga"): tokens are now EITHER a bare section key
// ('topItems' = whole section, the pre-SUBSECTION-1 form) OR a sub
// token ('topItems:nominal' = only that sub-block). Unknown sub keys
// are 400-rejected exactly like unknown section keys were.
// EXPORT-TRIM: user request — report trimmed 13 → 6 sections. Removed:
// 'breakdown', 'area', 'outlets', 'pareto', 'coverage' (the removed keys are
// 400-rejected below). Kept: exec (renamed "Ringkasan"), growth, topItems,
// variance, itemTrend, trend.
// REFINE-1 (user request): + 'peer' (section 7 — Resto dengan Penjualan
// Kurang Lebih Sama) + 'flip' (section 8 — Item yang Kemungkinan Plus Minus
// antar Periode).
// REFINE-3: + 'anomali' (section 6 — Item Anomali vs Riwayat Sendiri);
// trend renumbered 6→7, peer 7→8, flip 8→9 (keys unchanged).
// W10 (Atribusi + Skenario Sensitivitas Residual): + 'waste' (section 5
// — Analisis Waste: atribusi loss W/S/T vs residual + skenario p +
// decile-shift + top-waste snapshot), inserted after the variance
// context; REFINE-3 precedent renumber: itemTrend 5→6, anomali 6→7,
// trend 7→8, peer 8→9, flip 9→10 (keys unchanged).
// LEAGUE-AREA (user: "Export 1 by one 1 resto dan area"): + 'outletLeague'
// (section 11 — Peringkat Resto, every resto in scope one row each) +
// 'areaCompare' (section 12 — Perbandingan Area, every area one row +
// bar chart). Fresh keys (the pre-EXPORT-TRIM 'area'/'outlets' keys stay
// dead — different semantics).
// CUSTOM-COMPARE (user: "pilih resto mlgpar, pembanding bdgsek … atau
// beberapa resto / pakai area"): + 'customCompare' (section 13 — Komparasi
// Pilihan: focus resto vs USER-PICKED comparators via ?compareOutlets /
// ?compareAreas; subs tabel/grafik/items).
const EXPORT_SECTION_KEYS = ['exec', 'growth', 'topItems', 'variance', 'waste', 'itemTrend', 'anomali', 'trend', 'peer', 'flip', 'outletLeague', 'areaCompare', 'customCompare'] as const;

// CUSTOM-COMPARE — comparator selection params. Comma-separated outlet
// codes / area names (neither contains commas in this dataset — codes are
// dot-delimited like "1042.KWGGAL", areas are plain words like
// "JAWA TENGAH 2"). Counts are capped so a hand-edited URL cannot ask the
// pipeline to fan the per-item query over hundreds of outlets; area picks
// legitimately expand to their whole outlet population server-side, so the
// AREA cap is the real guard (14 areas exist today — allow a little slack).
// Caps live in export-sections.ts (COMPCAP-1 single source — shared with
// the FE picker). Duplicates are DEDUPED before the cap count (COMPCAP-1:
// "?compareOutlets=A,A" is 1 effective comparator, not 2 — the raw count
// used to 400 a ≤30-unique set padded with dupes).
// Empty string ("?compareOutlets=" with nothing picked) = NO comparators —
// valid, same convention as ?sections= (BUG-3-a C4): the section renders
// its factual guidance note instead of 400-ing a hand-crafted URL.
const compareOutletsSchema = z.string().refine(noControlChars).refine(
  (v) => {
    if (v.trim() === '') return true;
    const parts = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
    return parts.length <= MAX_COMPARE_OUTLETS
      && parts.every((s) => s.length >= 1 && s.length <= 50);
  },
  { message: `compareOutlets must be 1-${MAX_COMPARE_OUTLETS} comma-separated outlet codes` },
).optional();
const compareAreasSchema = z.string().refine(noControlChars).refine(
  (v) => {
    if (v.trim() === '') return true;
    const parts = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
    return parts.length <= MAX_COMPARE_AREAS
      && parts.every((s) => s.length >= 1 && s.length <= 50);
  },
  { message: `compareAreas must be 1-${MAX_COMPARE_AREAS} comma-separated area names` },
).optional();

// VERSUS-2R — mode "Versus — 1 Resto vs 1 Resto": satu kode outlet
// pembanding untuk seluruh laporan (sections 1-12 jadi A vs B). Format
// validasinya SAMA dengan `outlet` (outletCodeSchema — kode titik-delimited
// seperti "1137.CKGPAH"; an unknown code is the record guard's 404 to
// answer, exactly like ?outlet=). EMPTY string ("?versus=" with nothing
// picked) = mode standar — valid, the same convention as ?sections= /
// ?compareOutlets= (BUG-3-a C4). Cross-field rules (butuh resto fokus,
// tidak boleh sama dengan resto fokus) diperiksa di superRefine di bawah —
// pesan Indonesia karena satu-satunya pengirim param ini adalah dialog
// Export (FE sudah mem-validasi lebih dulu; ini penjaga URL rakitan
// tangan).
const versusSchema = z.string().refine(noControlChars).refine(
  (v) => v.trim() === '' || (v.length >= 1 && v.length <= 50),
  { message: 'versus must be an outlet code (1-50 chars) or empty' },
).optional();

export const exportReportQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  sections: z.string().refine(
    // SUBSECTION-1: bare section keys + 'section:sub' tokens (the full
    // valid set is EXPORT_SECTION_TOKENS in export-sections.ts).
    (v) => v.split(',').every((s) => s === '' || isExportSectionToken(s)),
    { message: `sections must be a comma-separated subset of: ${EXPORT_SECTION_KEYS.join(', ')} (or their sub-section tokens, e.g. topItems:nominal)` },
  ).optional(),
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  item: itemNameSchema,
  pic: picSchema,
  compareWeek: compareWeekSchema,
  compareMonth: monthLabelSchema,
  // CUSTOM-COMPARE — comparator set for section 13 (ignored when the
  // customCompare section is not selected).
  compareOutlets: compareOutletsSchema,
  compareAreas: compareAreasSchema,
  // VERSUS-2R — mode "Versus": satu resto pembanding untuk seluruh
  // laporan (sections 1-12 kepala-kepala).
  versus: versusSchema,
}).superRefine((data, ctx) => {
  // VERSUS-2R cross-field guards — 400 dengan pesan Indonesia (konvensi
  // pesan error route ini; lihat record-guard.ts).
  if (data.versus == null || data.versus.trim() === '') return;
  const focus = data.outlet && data.outlet !== 'all' ? data.outlet : null;
  if (!focus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versus'],
      message: 'Mode versus butuh resto fokus — pilih Filter Resto di tab Resto Analysis terlebih dulu.',
    });
    return;
  }
  if (data.versus === focus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versus'],
      message: 'Resto pembanding versus tidak boleh sama dengan resto fokus.',
    });
  }
});
