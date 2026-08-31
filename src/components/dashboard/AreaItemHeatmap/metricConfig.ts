// ============================================================
//  AreaItemHeatmap — Metric Configuration
//  --------------------------------------------------------
//  Pure data: labels + formatters + descriptions per metric.
//  No React, no 'use client', tree-shakeable.
// ============================================================

import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import type { HeatmapMetric } from './types';

export const METRIC_CONFIG: Record<
  HeatmapMetric,
  { label: string; format: (v: number) => string; description: string }
> = {
  absNominalDeviasi: {
    label: 'Total Deviasi (Rp)',
    format: (v) => fmtIDR(v),
    description: 'Total absolute nominal deviasi per area+item. Warna merah = deviasi tinggi.',
  },
  nominalWaste: {
    label: 'Total Waste (Rp)',
    format: (v) => fmtIDR(v),
    description: 'Total absolute nominal waste per area+item. Warna merah = waste tinggi.',
  },
  nominalSusut: {
    label: 'Total Susut (Rp)',
    format: (v) => fmtIDR(v),
    description: 'Total absolute nominal susut per area+item. Warna merah = susut tinggi.',
  },
  pctQtyDeviasiToBom: {
    label: 'Avg Dev/BOM (%)',
    format: (v) => fmtPctAbs(v),
    description: 'Rata-rata persentase deviasi terhadap BOM per area+item. Warna merah = % tinggi.',
  },
  recordCount: {
    label: 'Jumlah Record',
    format: (v) => fmtNum(v),
    description: 'Jumlah record yang deviasi per area+item. Warna merah = record banyak.',
  },
};
