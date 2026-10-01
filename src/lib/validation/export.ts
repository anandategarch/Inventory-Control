// ============================================================
//  Route-specific schemas — export-report.
//  GODSPLIT-W1-A: moved verbatim from the monolithic
//  src/lib/validation.ts (483 LOC). One schema, one consumer route:
//  /api/export-report.
// ============================================================
import { z } from 'zod';
import {
  monthLabelSchema,
  weekLabelSchema,
  compareWeekSchema,
  areaSchema,
  kelompokSchema,
  outletCodeSchema,
  itemNameSchema,
  picSchema,
} from './shared';

// /api/export-report?month=&week=&sections=&area=&kelompok=&outlet=&item=&pic=
// FIX (BUG-3-a C6): unknown section keys used to vanish silently
// (?sections=exec,topitems → section 3 just missing from the report, no
// error). Keep this list in sync with SECTIONS in ExportDialog.tsx and the
// hasSection() keys in pdf/pdf-builder.ts.
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
const EXPORT_SECTION_KEYS = ['exec', 'growth', 'topItems', 'variance', 'waste', 'itemTrend', 'anomali', 'trend', 'peer', 'flip'] as const;
export const exportReportQuerySchema = z.object({
  month: monthLabelSchema,
  week: weekLabelSchema,
  sections: z.string().refine(
    (v) => v.split(',').every((s) => s === '' || (EXPORT_SECTION_KEYS as readonly string[]).includes(s)),
    { message: `sections must be a comma-separated subset of: ${EXPORT_SECTION_KEYS.join(', ')}` },
  ).optional(),
  area: areaSchema,
  kelompok: kelompokSchema,
  outlet: outletCodeSchema,
  item: itemNameSchema,
  pic: picSchema,
  compareWeek: compareWeekSchema,
  compareMonth: monthLabelSchema,
});
