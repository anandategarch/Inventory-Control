// ============================================================
//  pdf-subsection-render.test.ts — SUBSECTION-1 render smoke
//  --------------------------------------------------------
//  The SPLIT-GOD-FILE refactor was verified by byte-comparing rendered
//  PDFs; this file revives that harness for the sub-section feature:
//  buildPdfReport is run against a FULL mock ReportData with several
//  ?sections= token combos and asserted to (a) not throw, (b) produce
//  progressively smaller output as fewer sub-blocks are selected —
//  the observable signal that hasSub() gating actually changes the
//  rendered document.
//  VERSUS-AUDIT-4: the mock factory + historical fixture moved VERBATIM
//  to ./fixtures/report-data-mock.ts (the versus render tests need the
//  same mock for BOTH sides of the duel — one source of truth).
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildPdfReport } from '@/app/api/export-report/services/pdf/pdf-builder';
import { mockReportData, HISTORICAL_PERIODS } from './fixtures/report-data-mock';

async function renderSize(sections: string[] | null): Promise<number> {
  const { bufferBase64 } = await buildPdfReport(mockReportData(), {
    sections,
    historicalPeriods: HISTORICAL_PERIODS,
  });
  return Buffer.from(bufferBase64, 'base64').length;
}

describe('buildPdfReport — SUBSECTION-1 token rendering', () => {
  it('renders the whole report (sections=null) without throwing', async () => {
    await expect(renderSize(null)).resolves.toBeGreaterThan(0);
  });

  it('renders all-bare-keys without throwing (pre-SUBSECTION-1 URL form)', async () => {
    await expect(
      renderSize([
        'exec',
        'growth',
        'topItems',
        'variance',
        'waste',
        'itemTrend',
        'anomali',
        'trend',
        'peer',
        'flip',
        'outletLeague',
        'areaCompare',
      ]),
    ).resolves.toBeGreaterThan(0);
  });

  it('renders a broad sub-token mix without throwing', async () => {
    await expect(
      renderSize([
        'exec',
        'growth:grafik',
        'topItems:nominal',
        'topItems:waste',
        'variance:memburuk',
        'waste:komposisi',
        'waste:topsnapshot',
        'itemTrend',
        'anomali:pola',
        'trend:akumulasi',
        'peer:deviasi',
        'flip',
      ]),
    ).resolves.toBeGreaterThan(0);
  });

  it('renders the empty list (BUG-3-a C4 — cover-only) without throwing', async () => {
    await expect(renderSize([])).resolves.toBeGreaterThan(0);
  });

  it('a single-sub export is SMALLER than its full section (sub gating changes output)', async () => {
    const fullTopItems = await renderSize(['topItems']);
    const oneSub = await renderSize(['topItems:nominal']);
    expect(oneSub).toBeLessThan(fullTopItems);
  });

  it('waste:topsnapshot alone is smaller than the full waste section', async () => {
    const fullWaste = await renderSize(['waste']);
    const snapshotOnly = await renderSize(['waste:topsnapshot']);
    expect(snapshotOnly).toBeLessThan(fullWaste);
  });

  it('a partial selection is smaller than the full report', async () => {
    const all = await renderSize(null);
    const partial = await renderSize([
      'exec',
      'topItems:nominal',
      'trend:tabel',
    ]);
    expect(partial).toBeLessThan(all);
  });

  // LEAGUE-AREA — sections 11 "Peringkat Resto" + 12 "Perbandingan Area".
  it('renders the two LEAGUE-AREA sections without throwing', async () => {
    await expect(renderSize(['outletLeague'])).resolves.toBeGreaterThan(0);
    await expect(renderSize(['areaCompare'])).resolves.toBeGreaterThan(0);
  });

  it('areaCompare:tabel alone is smaller than the full areaCompare section (sub gating)', async () => {
    const full = await renderSize(['areaCompare']);
    const tabelOnly = await renderSize(['areaCompare:tabel']);
    expect(tabelOnly).toBeLessThan(full);
  });

  it('the LEAGUE-AREA sections add bytes over a cover-only document', async () => {
    const coverOnly = await renderSize([]);
    const league = await renderSize(['outletLeague']);
    const areas = await renderSize(['areaCompare']);
    expect(league).toBeGreaterThan(coverOnly);
    expect(areas).toBeGreaterThan(coverOnly);
  });

  // CUSTOM-COMPARE — section 13 "Komparasi Pilihan" (focus resto vs
  // user-picked comparators; the mock carries a picked resto + an
  // area-expanded comparator + blind-spot 13.3 rows).
  it('renders the CUSTOM-COMPARE section without throwing', async () => {
    await expect(renderSize(['customCompare'])).resolves.toBeGreaterThan(0);
  });

  it('customCompare:tabel alone is smaller than the full customCompare section (sub gating)', async () => {
    const full = await renderSize(['customCompare']);
    const tabelOnly = await renderSize(['customCompare:tabel']);
    expect(tabelOnly).toBeLessThan(full);
  });

  it('the CUSTOM-COMPARE section adds bytes over a cover-only document', async () => {
    const coverOnly = await renderSize([]);
    const cc = await renderSize(['customCompare']);
    expect(cc).toBeGreaterThan(coverOnly);
  });

  it('customCompare without comparator data renders the guidance note, not a crash', async () => {
    // The server sends customComparison = null when the section is on but
    // no comparator rode the URL — the section must print its factual
    // noteBox and keep the document renderable.
    const data = mockReportData();
    data.customComparison = null;
    const { bufferBase64 } = await buildPdfReport(data, {
      sections: ['customCompare'],
      historicalPeriods: HISTORICAL_PERIODS,
    });
    expect(Buffer.from(bufferBase64, 'base64').length).toBeGreaterThan(0);
  });
});
