// ============================================================
//  Recommendation Engine — rule-based WHY/WHAT/PRIORITY
//  (AI/LLM narrative features removed — Task REMOVE-AI.
//   Kept buildRecommendations since it is rule-based, not AI.)
// ============================================================
import type { InvestigationItem } from '@/types/inventory';

export function buildRecommendations(worklist: InvestigationItem[]): Array<{
  why: string;
  what: string[];
  priority: 'P1' | 'P2' | 'P3';
}> {
  if (worklist.length === 0) {
    return [{
      why: 'Tidak ada anomaly terdeteksi pada periode ini.',
      what: ['Lanjutkan monitoring rutin.'],
      priority: 'P3',
    }];
  }

  const p1 = worklist.filter((w) => w.priority === 'P1');
  const p2 = worklist.filter((w) => w.priority === 'P2');

  const recommendations: Array<{ why: string; what: string[]; priority: 'P1' | 'P2' | 'P3' }> = [];

  if (p1.length > 0) {
    const top = p1[0];
    const hasResidual = p1.some((w) => w.ruleCodes.some((c) => c.includes('RESIDUAL')));
    const hasBomMismatch = p1.some((w) => w.ruleCodes.some((c) => c.includes('BOM')));
    const hasSalesMismatch = p1.some((w) => w.ruleCodes.some((c) => c.includes('SALES')));
    const hasTolerance = p1.some((w) => w.ruleCodes.some((c) => c.includes('TOLERANCE')));
    const hasBenchmark = p1.some((w) => w.ruleCodes.some((c) => c.includes('BENCHMARK')));
    const hasHistorical = p1.some((w) => w.ruleCodes.some((c) => c.includes('HISTORICAL')));

    const whyParts: string[] = [];
    if (hasResidual) whyParts.push('Residual Loss tinggi setelah dikurangi Waste/Susut/Trial');
    if (hasBomMismatch) whyParts.push('Deviation growth tidak sebanding dengan BOM growth');
    if (hasSalesMismatch) whyParts.push('Deviation growth jauh melebihi Sales growth');
    if (hasTolerance) whyParts.push('Deviation/BOM melebihi tolerance');
    if (hasBenchmark) whyParts.push('Outlet menyimpang dari benchmark area/network');
    if (hasHistorical) whyParts.push('Deviation abnormal vs historical behavior');
    whyParts.push(`Financial impact tertinggi: ${top.itemName} @ ${top.outletCode} (Rp ${top.absNominalDeviasi.toLocaleString('id-ID')})`);

    const what: string[] = [];
    if (hasResidual) what.push('Validasi Actual Usage vs SOC + sampling fisik + cek pencatatan Waste/Susut/Trial');
    if (hasBomMismatch) what.push('Rekonsiliasi BOM aktual vs sistem + periksa receiving/transfer/UOM conversion');
    if (hasSalesMismatch) what.push('Audit transaksi inventory + cek price effect vs quantity effect');
    if (hasTolerance) what.push('Review SOC/standard + sampling pemakaian aktual per menu');
    if (hasBenchmark) what.push('Benchmarking vs outlet serupa + audit prosedur operasional');
    if (hasHistorical) what.push('Investigasi pola outlier vs historical behavior');
    what.push('Cross-check receiving vs invoice supplier');
    what.push('Verifikasi transfer antar outlet');

    recommendations.push({
      why: whyParts.join('; '),
      what,
      priority: 'P1',
    });
  }

  if (p2.length > 0) {
    recommendations.push({
      why: `${p2.length} item dengan severity WARNING perlu monitoring. Pattern: deviation moderate atau tolerance breach ringan.`,
      what: [
        'Monitoring tren mingguan item-item P2',
        'Sampling spot-check pada item dengan deviation rising',
        'Verifikasi pencatatan Waste/Susut rutin',
      ],
      priority: 'P2',
    });
  }

  return recommendations;
}
