// ============================================================
//  window-config.test.ts — PERF-FILTER3 ("3 BULAN", 22 Okt 2026)
//  --------------------------------------------------------
//  Pins the interactive lookback policy (user request: "hanya
//  tarik data 3 bulan terakhir dari filter terpilih agar ringan"
//  — insiden kartu merah "Gagal Memuat Analisis" tiap ganti
//  filter) + the export deep-report window + the pure
//  lookbackMonthLabels helper used by the analysis trend wave.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_LOOKBACK_MONTHS,
  DEEP_REPORT_WINDOW_MONTHS,
} from '@/lib/queries/window-config';
import { lookbackMonthLabels } from '@/app/api/analysis/services/run-queries';
import type { FetchedRecords } from '@/app/api/analysis/services/fetch-records';

function fakeRecords(monthKeys: string[]): Pick<FetchedRecords, 'allPeriods' | 'monthKeyByLabel' | 'monthLabelByKey'> {
  const monthKeyByLabel = new Map<string, string>();
  const monthLabelByKey = new Map<string, string>();
  for (const k of monthKeys) {
    const label = `Bulan ${k}`; // label identity is irrelevant to the helper
    monthKeyByLabel.set(label, k);
    monthLabelByKey.set(k, label);
  }
  const allPeriods = monthKeys.flatMap((monthKey) => {
    const label = monthLabelByKey.get(monthKey) ?? `Bulan ${monthKey}`;
    return ['WEEK 1', 'WEEK 2', 'WEEK 4'].map((weekLabel) => ({
      monthLabel: label,
      weekLabel,
      monthKey,
      sortKey: `${monthKey}|${weekLabel.replace(/\D/g, '')}`,
    }));
  });
  return { allPeriods, monthKeyByLabel, monthLabelByKey };
}

describe('window-config (PERF-FILTER3 "3 BULAN")', () => {
  it('interactive lookback = 3 months (incl. selected month); export deep window stays 12', () => {
    expect(DASHBOARD_LOOKBACK_MONTHS).toBe(3);
    expect(DEEP_REPORT_WINDOW_MONTHS).toBe(12);
  });
});

describe('lookbackMonthLabels (analysis trend window)', () => {
  it('returns the 3 most recent monthLabels ending AT the selected month', () => {
    const rec = fakeRecords(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    const labels = lookbackMonthLabels(rec, 'Bulan 2026-07');
    expect(labels).toEqual(['Bulan 2026-05', 'Bulan 2026-06', 'Bulan 2026-07']);
  });

  it('selected month EARLY in history → window is the months up to it (fewer than 3)', () => {
    const rec = fakeRecords(['2026-03', '2026-04', '2026-05']);
    const labels = lookbackMonthLabels(rec, 'Bulan 2026-04');
    expect(labels).toEqual(['Bulan 2026-03', 'Bulan 2026-04']);
  });

  it('months AFTER the selected month are excluded (filter month is the window END)', () => {
    const rec = fakeRecords(['2026-03', '2026-04', '2026-05', '2026-06']);
    const labels = lookbackMonthLabels(rec, 'Bulan 2026-05');
    expect(labels).toEqual(['Bulan 2026-03', 'Bulan 2026-04', 'Bulan 2026-05']);
    expect(labels).not.toContain('Bulan 2026-06');
  });

  it('unknown selected month (no SourceFile row) → null (trend falls back to unbounded legacy scan)', () => {
    const rec = fakeRecords(['2026-03', '2026-04']);
    expect(lookbackMonthLabels(rec, 'Desember 2027')).toBeNull();
  });

  it('dedupes monthKeys across week rows (allPeriods carries 3 weeks per month)', () => {
    const rec = fakeRecords(['2026-06', '2026-07', '2026-08']);
    const labels = lookbackMonthLabels(rec, 'Bulan 2026-08');
    expect(labels).toEqual(['Bulan 2026-06', 'Bulan 2026-07', 'Bulan 2026-08']);
    expect(rec.allPeriods.length).toBe(9); // 3 months × 3 weeks — window stays 3 labels
  });
});
