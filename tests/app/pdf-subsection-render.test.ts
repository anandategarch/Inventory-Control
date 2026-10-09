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
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildPdfReport } from '@/app/api/export-report/services/pdf/pdf-builder';
import type {
  ReportData,
  ReportContext,
} from '@/app/api/export-report/services/types';

// ---- Full mock (every field the section draw* functions read) ----
function mockData(): ReportData {
  return {
    period: {
      monthLabel: 'September 2026',
      weekLabel: 'WEEK 1',
      comparisonWeek: 'WEEK 1',
      comparisonMonth: 'Agustus 2026',
    },
    filters: {
      area: null,
      kelompok: null,
      outletCode: null,
      itemName: null,
      pic: null,
    },
    executiveSummary: {
      sales: { current: 1_000_000, previous: 900_000, growth: 0.111 },
      nominalDeviasi: { current: -450_000, previous: -300_000, growth: 0.5 },
      qtyBom: { current: 100, previous: 90, growth: 0.11 },
      qtyDeviasi: { current: -12, previous: -8, growth: 0.5 },
      qtyWaste: { current: 5, previous: 4, growth: 0.25 },
      qtySusut: { current: 3, previous: 2, growth: 0.5 },
      qtyTrial: { current: 2, previous: 1, growth: 1 },
      qtyLossSurplus: { current: -10, previous: -6, growth: 0.66 },
      deviationToBom: 0.12,
      residualLossQty: -7,
      residualLossPct: 0.08,
      _prevMetrics: {
        deviationToBom: 0.1,
        residualLossQty: -5,
        residualLossPct: 0.06,
      },
    },
    topItemsByNominal: [
      {
        itemName: 'Ayam Fillet',
        outletCode: '1042.KWGGAL',
        satuan: 'KG',
        nominalDeviasi: -450_000,
        devBom: 0.25,
      },
    ],
    topItemsByDevBom: [
      {
        itemName: 'Ayam Fillet',
        outletCode: '1042.KWGGAL',
        satuan: 'KG',
        devBom: 0.25,
        nominalDeviasi: -450_000,
      },
    ],
    topItemsByWaste: [
      {
        itemName: 'Ayam Fillet',
        outletCode: '1042.KWGGAL',
        satuan: 'KG',
        area: 'JABODETABEK',
        qtyWaste: 5,
        nominalWaste: 250_000,
        prevQty: 4,
        histAvgQty: 3.5,
        areaAvgQty: 3.2,
      },
    ],
    topItemsBySusut: [
      {
        itemName: 'Tepung',
        outletCode: '1042.KWGGAL',
        satuan: 'KG',
        area: 'JABODETABEK',
        qtySusut: 3,
        nominalSusut: 90_000,
        prevQty: 2,
        histAvgQty: 2.5,
        areaAvgQty: 2.2,
      },
    ],
    topItemsByTrial: [
      {
        itemName: 'Sambal',
        outletCode: '1042.KWGGAL',
        satuan: 'PCS',
        area: 'JABODETABEK',
        qtyTrial: 2,
        nominalTrial: 40_000,
        prevQty: 1,
        histAvgQty: 1.5,
        areaAvgQty: 1.2,
      },
    ],
    topItemsByLossSurplus: [
      {
        itemName: 'Minyak',
        outletCode: '1042.KWGGAL',
        satuan: 'LTR',
        area: 'JABODETABEK',
        qtyLossSurplus: -10,
        nominalLossSurplus: -100_000,
        prevQty: -6,
        histAvgQty: 5,
        areaAvgQty: 4.5,
      },
    ],
    varianceAnalysis: {
      topWorsened: [
        {
          itemName: 'Ayam Fillet',
          satuan: 'KG',
          outletCode: '1042.KWGGAL',
          area: 'JABODETABEK',
          currentNominal: -450_000,
          previousNominal: -300_000,
          selisih: -150_000,
        },
      ],
      topImproved: [
        {
          itemName: 'Tepung',
          satuan: 'KG',
          outletCode: '1042.KWGGAL',
          area: 'JABODETABEK',
          currentNominal: -10_000,
          previousNominal: -60_000,
          selisih: 50_000,
        },
      ],
    },
    trend: [
      {
        weekLabel: 'Juli 2026 WEEK 1',
        nominal: -100_000,
        devBom: 0.1,
        sales: 1_000_000,
        lossNominal: 150_000,
        surplusNominal: 50_000,
      },
      {
        weekLabel: 'Agustus 2026 WEEK 1',
        nominal: -300_000,
        devBom: 0.3,
        sales: 950_000,
        lossNominal: 350_000,
        surplusNominal: 50_000,
      },
      {
        weekLabel: 'September 2026 WEEK 1',
        nominal: -450_000,
        devBom: 0.45,
        sales: 1_000_000,
        lossNominal: 500_000,
        surplusNominal: 50_000,
      },
    ],
    itemTrendMatrix: [
      {
        monthLabel: 'Juli 2026',
        monthKey: '2026-07',
        itemName: 'Ayam Fillet',
        absNominal: 100_000,
        nominalDeviasi: -100_000,
        satuan: 'KG',
      },
      {
        monthLabel: 'Agustus 2026',
        monthKey: '2026-08',
        itemName: 'Ayam Fillet',
        absNominal: 300_000,
        nominalDeviasi: -300_000,
        satuan: 'KG',
      },
      {
        monthLabel: 'September 2026',
        monthKey: '2026-09',
        itemName: 'Ayam Fillet',
        absNominal: 450_000,
        nominalDeviasi: -450_000,
        satuan: 'KG',
      },
    ],
    selfHistoryAnomaly: [
      {
        histCount: 3,
        itemName: 'Ayam Fillet',
        outletCode: '1042.KWGGAL',
        area: 'JABODETABEK',
        satuan: 'KG',
        qty: -12,
        histAvgQty: 5,
        deltaQty: -7,
        nominal: -450_000,
      },
    ],
    selfHistoryFlips: [
      {
        histCount: 3,
        itemName: 'Daging Sapi',
        outletCode: '1042.SBMOTI',
        area: 'JABAR',
        satuan: 'KG',
        histSignedAvgQty: -8,
        qty: 5,
        flip: 'lossToSurplus',
        nominal: 200_000,
      },
    ],
    weeklyComposition: [
      {
        weekNo: 1,
        nominalWaste: 100_000,
        nominalSusut: 50_000,
        nominalTrial: 20_000,
        nominalLossSurplus: 80_000,
        nominalDeviasi: -250_000,
      },
    ],
    itemConsistency: [
      {
        consistency: 'SYSTEMIC',
        itemName: 'Ayam Fillet',
        outletCount: 12,
        lossOutlets: 10,
        surplusOutlets: 2,
        totalAbsNominal: 900_000,
        avgDevBom: 0.3,
      },
    ],
    peerComparison: {
      targetOutlet: { name: 'KWGGAL', code: '1042.KWGGAL' },
      autoTarget: false,
      peers: [
        {
          nominalDeviasi: -450_000,
          outletName: 'KWGGAL',
          outletCode: '1042.KWGGAL',
          area: 'JABODETABEK',
          devBom: 0.25,
          qtyDeviasi: -12,
          isTarget: true,
        },
        {
          nominalDeviasi: -200_000,
          outletName: 'SBMOTI',
          outletCode: '1042.SBMOTI',
          area: 'JABAR',
          devBom: 0.18,
          qtyDeviasi: -8,
          isTarget: false,
        },
      ],
      items: [
        {
          itemName: 'Ayam Fillet',
          satuan: 'KG',
          target: { qtyDeviasi: -12, devBom: 0.25 },
          peerAvg: { qtyDeviasi: -8, devBom: 0.18 },
        },
      ],
      topItems: [
        {
          itemName: 'Ayam Fillet',
          topDiNames: ['KWGGAL', 'SBMOTI'],
          target: {
            itemRank: 2,
            itemOutletCount: 11,
            absNominal: 450_000,
            qtyDeviasi: -12,
          },
          peerTopCount: 4,
          peerAvgAbsQty: 6.5,
        },
      ],
    },
    flipRanking: {
      items: [
        {
          itemName: 'Daging Sapi',
          satuan: 'KG',
          topFlips: [
            {
              period1Label: 'Jul 2026 W1',
              period2Label: 'Agu 2026 W1',
              qtyP1: 100,
              qtyP2: -98,
              net: 2,
              disparityPct: 2,
            },
          ],
        },
      ],
    },
    wasteAttribution: {
      attribution: {
        totalLoss: 43_925_875,
        components: [
          { label: 'Waste', nominal: 5_000_000, shareOfLoss: 0.11 },
          { label: 'Susut', nominal: 3_000_000, shareOfLoss: 0.07 },
          { label: 'Trial', nominal: 2_000_000, shareOfLoss: 0.05 },
        ],
        residual: 33_925_875,
        residualShare: 0.77,
        explainedShare: 0.23,
        explainedNominal: 10_000_000,
        scenarios: [
          {
            p: 0,
            trueWaste: 5_000_000,
            impliedWasteToSales: 0.01,
            impliedWasteShareOfLoss: 0.11,
            decileShifts: 0,
          },
          {
            p: 0.5,
            trueWaste: 21_962_937,
            impliedWasteToSales: 0.04,
            impliedWasteShareOfLoss: 0.5,
            decileShifts: 5,
          },
          {
            p: 0.7,
            trueWaste: 28_748_112,
            impliedWasteToSales: 0.06,
            impliedWasteShareOfLoss: 0.65,
            decileShifts: 8,
          },
        ],
        decile: {
          p: 0.5,
          outletsRanked: 100,
          outletsExcluded: 3,
          outletsMoved: 5,
          movedShare: 0.05,
        },
        disclosure:
          'Residual ~ NET loss by construction. W/S/T menjelaskan sisi GROSS, bukan NET.',
      },
      months: [
        { monthLabel: 'Juli 2026' },
        { monthLabel: 'Agustus 2026' },
        { monthLabel: 'September 2026' },
      ],
      kpis: { outlets: 100 },
    },
    durationMs: 123,
  } as unknown as ReportData;
}

const HISTORICAL: ReportContext['historicalPeriods'] = [
  { monthLabel: 'Juli 2026', weekLabel: 'WEEK 1', sortKey: '2026-07-1' },
  { monthLabel: 'Agustus 2026', weekLabel: 'WEEK 1', sortKey: '2026-08-1' },
];

async function renderSize(sections: string[] | null): Promise<number> {
  const { bufferBase64 } = await buildPdfReport(mockData(), {
    sections,
    historicalPeriods: HISTORICAL,
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
});
