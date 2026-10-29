// ============================================================
//  window-config.test.ts — PERF-FILTER3 ("3 BULAN", 22 Okt 2026)
//  → HIST-WINDOW-5 (29 Okt 2026)
//  --------------------------------------------------------
//  Pins the interactive lookback policy + the export deep-report
//  window + the pure lookbackMonthLabels helper used by the
//  analysis trend wave.
//  [RIWAYAT: PERF-FILTER3 memangkas jendela 12 → 3 per user request
//  "hanya tarik data 3 bulan terakhir agar ringan" saat insiden kartu
//  merah. HIST-WINDOW-5 (opsi B user, 29 Okt 2026): 3 → 5 — jendela
//  3 bulan membuat baseline z-score tab Historical maksimal 2 bulan
//  pembanding same-week (2 < HISTORICAL_MIN_WEEKS 4 → kartu
//  "Data historis belum cukup" menyala permanen). 5 bulan = bulan
//  terpilih + 4 pembanding → z-score hidup; aman karena DB kini
//  us-east-1 (MIGRASI-REGION) + heatmap terhapus + stagger gate
//  PERF-FILTER4 aktif. See window-config.ts.]
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

describe('window-config (PERF-FILTER3 "3 BULAN" → HIST-WINDOW-5)', () => {
  it('interactive lookback = 5 months (incl. selected month); export deep window stays 12', () => {
    expect(DASHBOARD_LOOKBACK_MONTHS).toBe(5);
    expect(DEEP_REPORT_WINDOW_MONTHS).toBe(12);
  });
});

describe('lookbackMonthLabels (analysis trend window)', () => {
  it('returns the 5 most recent monthLabels ending AT the selected month (cap proven: 02 dropped)', () => {
    const rec = fakeRecords(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    const labels = lookbackMonthLabels(rec, 'Bulan 2026-07');
    // 6 months ≤ 2026-07 exist; window keeps the newest 5 → 2026-02 falls off.
    expect(labels).toEqual(['Bulan 2026-03', 'Bulan 2026-04', 'Bulan 2026-05', 'Bulan 2026-06', 'Bulan 2026-07']);
  });

  it('selected month EARLY in history → window is the months up to it (fewer than the window)', () => {
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
    expect(rec.allPeriods.length).toBe(9); // 3 months × 3 weeks — fewer than the 5-month window
  });
});
