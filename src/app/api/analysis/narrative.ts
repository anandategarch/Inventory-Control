// ============================================================
//  ANALYSIS API — Narrative generation + recommendations
//  Rule-based narrative summarising the period's findings, and a
//  recommendation list derived from anomaly signals.
// ============================================================
import type { RuntimeThresholds } from '@/lib/settings';
import type {
  Totals,
  OutletAgg,
  ExecutiveSummary,
  TopItemsBundle,
  WorklistItem,
  GrowthComparison,
  VarianceAnalysis,
  OutletHealthRank,
  ItemConsistency,
  AreaAnalysisItem,
  Recommendation,
  HealthBreakdown,
  DqStatus,
} from './types';

/** Bundle of inputs consumed by the narrative generator. */
export interface NarrativeInput {
  currentWeek: string | null;
  monthLabel: string | null;
  area: string | null;
  outletCode: string | null;
  pic: string | null;
  totals: Totals;
  byOutlet: Map<string, OutletAgg>;
  execSummary: ExecutiveSummary;
  topItemsByNominal: TopItemsBundle['topItemsByNominal'];
  investigationWorklist: WorklistItem[];
  health: HealthBreakdown;
  /** P2-5: DQ status for data-quality gating in the narrative */
  dq?: DqStatus;
  growthComparison: GrowthComparison;
  compareWeek: string | null;
  varianceAnalysis: VarianceAnalysis;
  outletHealthRanking: OutletHealthRank[];
  itemConsistencyAnalysis: ItemConsistency[];
  areaAnalysis: AreaAnalysisItem[];
  thresholds: RuntimeThresholds;
}

/**
 * Generate the rule-based narrative (Indonesian-language summary).
 * FIX P0-5: Now async — reads thresholds from Settings (not hardcoded).
 * Sections: header / executive summary / efficiency diagnostic /
 * loss-vs-surplus imbalance / waste composition / risk concentration /
 * health status / area comparison / growth / top items / worklist /
 * variance / outlet health / item consistency.
 */
export async function generateNarrative(input: NarrativeInput): Promise<string> {
  const { thresholds } = input;
  const parts: string[] = [];
  const {
    currentWeek,
    monthLabel,
    area,
    outletCode,
    pic,
    totals,
    byOutlet,
    topItemsByNominal,
    investigationWorklist,
    health,
    growthComparison,
    compareWeek,
    varianceAnalysis,
    outletHealthRanking,
    itemConsistencyAnalysis,
    areaAnalysis,
  } = input;

  const {
    totalSales,
    qtyBomTotal,
    qtyDeviasiTotal,
    qtyWasteTotal,
    qtySusutTotal,
    qtyTrialTotal,
    nomDeviasiTotal,
    totalLoss,
    totalSurplus,
    residualLossQty,
  } = totals;

  parts.push(`📊 LAPORAN ANALISIS — ${currentWeek || 'SEMUA'} ${monthLabel || ''}`);
  if (area) parts.push(`📍 Filter area: ${area}`);
  if (outletCode) parts.push(`📍 Filter outlet: ${outletCode}`);
  if (pic) parts.push(`📍 Filter PIC: ${pic}`);
  parts.push('');
  parts.push(`📈 RINGKASAN EKSEKUTIF`);
  parts.push(`• Total Sales: Rp ${totalSales.toLocaleString('id-ID')}`);
  parts.push(
    `• Total Nominal Deviasi: Rp ${nomDeviasiTotal.toLocaleString('id-ID')} (${totalSales > 0 ? ((nomDeviasiTotal / totalSales) * 100).toFixed(1) : 0}% dari sales)`
  );
  parts.push(
    `• Total LOSS: Rp ${totalLoss.toLocaleString('id-ID')} (${totalSales > 0 ? ((totalLoss / totalSales) * 100).toFixed(1) : 0}% dari sales)`
  );
  parts.push(`• Total SURPLUS: Rp ${totalSurplus.toLocaleString('id-ID')}`);
  parts.push(
    `• Rasio Deviasi/BOM: ${qtyBomTotal > 0 ? ((qtyDeviasiTotal / qtyBomTotal) * 100).toFixed(2) : 0}%`
  );
  parts.push(
    `• Residual Loss: ${residualLossQty.toLocaleString()} (${qtyDeviasiTotal > 0 ? ((residualLossQty / qtyDeviasiTotal) * 100).toFixed(1) : 0}% dari deviasi)`
  );

  // Efficiency diagnostic
  const devToSales = totalSales > 0 ? nomDeviasiTotal / totalSales : 0;
  parts.push('');
  parts.push(`💡 DIAGNOSTIK EFISIENSI`);
  if (devToSales > thresholds.EFFICIENCY_HIGH_PCT) {
    parts.push(
      `⚠️ Rasio deviasi/sales ${(devToSales * 100).toFixed(1)}% — SANGAT TINGGI (batas kritis ${(thresholds.EFFICIENCY_HIGH_PCT * 100).toFixed(0)}%). Kemungkinan ada kebocoran operasional atau masalah pencatatan.`
    );
  } else if (devToSales > thresholds.EFFICIENCY_WARN_PCT) {
    parts.push(
      `🔶 Rasio deviasi/sales ${(devToSales * 100).toFixed(1)}% — di atas batas wajar (${(thresholds.EFFICIENCY_WARN_PCT * 100).toFixed(0)}%). Perlu monitoring ketat.`
    );
  } else {
    parts.push(`✅ Rasio deviasi/sales ${(devToSales * 100).toFixed(1)}% — dalam batas wajar.`);
  }

  // Direction imbalance (LOSS vs SURPLUS)
  const lossSurplusRatio =
    totalLoss + totalSurplus > 0 ? totalLoss / (totalLoss + totalSurplus) : 0;
  parts.push(`• LOSS vs SURPLUS: ${totalLoss.toLocaleString('id-ID')} vs ${totalSurplus.toLocaleString('id-ID')}`);
  if (lossSurplusRatio > thresholds.DIRECTION_IMBALANCE_PCT) {
    parts.push(
      `🔴 Dominasi LOSS (${(lossSurplusRatio * 100).toFixed(0)}%) — pemakaian aktual melebihi SOC. Investigasi penyebab over-consumption.`
    );
  } else if (lossSurplusRatio < (1 - thresholds.DIRECTION_IMBALANCE_PCT)) {
    parts.push(
      `🟢 Dominasi SURPLUS (${((1 - lossSurplusRatio) * 100).toFixed(0)}%) — pemakaian aktual di bawah SOC. Cek apakah BOM perlu revisi atau ada under-portions.`
    );
  } else {
    parts.push(
      `⚖️ Seimbang antara LOSS dan SURPLUS (${(lossSurplusRatio * 100).toFixed(0)}% : ${((1 - lossSurplusRatio) * 100).toFixed(0)}%).`
    );
  }

  // Waste composition analysis
  const wasteTotal = qtyWasteTotal + qtySusutTotal + qtyTrialTotal;
  if (wasteTotal > 0 && qtyDeviasiTotal > 0) {
    parts.push('');
    parts.push(`♻️ KOMPOSISI DEVIASI`);
    parts.push(
      `• Waste: ${qtyWasteTotal.toLocaleString()} (${((qtyWasteTotal / wasteTotal) * 100).toFixed(1)}% dari waste+susut+trial)`
    );
    parts.push(`• Susut: ${qtySusutTotal.toLocaleString()} (${((qtySusutTotal / wasteTotal) * 100).toFixed(1)}%)`);
    parts.push(`• Trial: ${qtyTrialTotal.toLocaleString()} (${((qtyTrialTotal / wasteTotal) * 100).toFixed(1)}%)`);
    parts.push(
      `• Residual (tidak terjelaskan): ${residualLossQty.toLocaleString()} (${((residualLossQty / qtyDeviasiTotal) * 100).toFixed(1)}% dari total deviasi)`
    );
    if (residualLossQty / qtyDeviasiTotal > thresholds.RESIDUAL_LOSS_HIGH_PCT) {
      parts.push(
        `🚨 ${((residualLossQty / qtyDeviasiTotal) * 100).toFixed(0)}% deviasi TIDAK terjelaskan oleh waste/susut/trial — klasifikasi data bermasalah.`
      );
    }
  }

  // Risk concentration analysis
  if (byOutlet.size > 0) {
    parts.push('');
    parts.push(`🎯 KONSENTRASI RISIKO`);
    const sortedOutlets = [...byOutlet.entries()].sort((a, b) => b[1].absNominal - a[1].absNominal);
    const top3Nominal = sortedOutlets.slice(0, 3).reduce((s, [, v]) => s + v.absNominal, 0);
    const concentrationPct = nomDeviasiTotal > 0 ? (top3Nominal / nomDeviasiTotal) * 100 : 0;
    parts.push(`• Top 3 outlet menyumbang ${concentrationPct.toFixed(1)}% dari total nominal deviasi`);
    if (concentrationPct > thresholds.CONCENTRATION_PCT * 100) {
      parts.push(
        `⚠️ Risiko TERKONSENTRASI di few outlets — fokus investigasi ke ${sortedOutlets.slice(0, 3).map(([c]) => c).join(', ')}`
      );
    } else {
      parts.push(`✅ Risiko terdistribusi merata — tidak ada outlet dominan`);
    }
    parts.push(`• Total outlet dianalisis: ${byOutlet.size}`);
  }

  parts.push('');
  parts.push(`🏥 STATUS KESEHATAN`);
  parts.push(`• Normal: ${health.normal.toLocaleString()} records`);
  parts.push(`• Warning: ${health.warning.toLocaleString()} records`);
  parts.push(`• Abnormal: ${health.abnormal.toLocaleString()} records`);
  const totalRecords = health.normal + health.warning + health.abnormal;
  if (totalRecords > 0) {
    const abnormalPct = (health.abnormal / totalRecords) * 100;
    if (abnormalPct > 20) {
      parts.push(`⚠️ ABNORMAL RATE ${abnormalPct.toFixed(1)}% — KRITIS! Investigasi mendalam diperlukan.`);
    } else if (abnormalPct > 5) {
      parts.push(`⚠️ Abnormal rate ${abnormalPct.toFixed(1)}% — perlu perhatian.`);
    } else {
      parts.push(`✅ Abnormal rate ${abnormalPct.toFixed(1)}% — dalam batas wajar.`);
    }
  }

  // P2-5: DQ Gating — warn the user when data quality is poor so they
  // know that conclusions for outlets/items with bad DQ may be inaccurate.
  // Fires after HEALTH section so the warning sits next to the verdict.
  const dq = input.dq;
  if (dq && (dq.errors > 50 || dq.warnings > 500)) {
    parts.push('');
    parts.push(
      `⚠️ DATA QUALITY: ${dq.errors} error + ${dq.warnings} warning records. Kesimpulan untuk outlet/item dengan data quality buruk mungkin tidak akurat. Disarankan validasi data sebelum investigasi.`
    );
  }

  // Area comparison narrative
  // FIX P0-3: areaAnalysis is now sorted by lossToSales DESC (not abs nominal)
  // so worstArea[0] = highest loss/sales ratio, bestArea[last] = lowest
  if (areaAnalysis.length > 1) {
    parts.push('');
    parts.push(`🗺️ PERBANDINGAN AREA`);
    const worstArea = areaAnalysis[0];
    const bestArea = areaAnalysis[areaAnalysis.length - 1];
    parts.push(
      `• Area TERBURUK: ${worstArea.area} — Loss/Sales ${(worstArea.lossToSales * 100).toFixed(1).replace('.', ',')}% (Rp ${worstArea.totalAbsNominal.toLocaleString('id-ID')} | ${worstArea.outletCount} outlet)`
    );
    parts.push(
      `• Area TERBAIK: ${bestArea.area} — Loss/Sales ${(bestArea.lossToSales * 100).toFixed(1).replace('.', ',')}% (Rp ${bestArea.totalAbsNominal.toLocaleString('id-ID')} | ${bestArea.outletCount} outlet)`
    );
  }

  parts.push('');
  if (growthComparison.salesGrowth != null) {
    parts.push(`📊 PERTUMBUHAN vs ${compareWeek || 'periode sebelumnya'}`);
    parts.push(`• Sales growth: ${(growthComparison.salesGrowth * 100).toFixed(1).replace('.', ',')}%`);
    parts.push(
      `• BOM growth: ${growthComparison.bomGrowth != null ? (growthComparison.bomGrowth * 100).toFixed(1).replace('.', ',') + '%' : 'N/A'}`
    );
    parts.push(
      `• Nominal Deviasi growth: ${growthComparison.nominalDeviasiGrowth != null ? (growthComparison.nominalDeviasiGrowth * 100).toFixed(1).replace('.', ',') + '%' : 'N/A'}`
    );
    if (
      growthComparison.salesGrowth != null &&
      growthComparison.nominalDeviasiGrowth != null
    ) {
      const sg = growthComparison.salesGrowth;
      const dg = growthComparison.nominalDeviasiGrowth;

      if (sg < 0 && dg > 0) {
        // FIX P0-2: CRITICAL MISMATCH — sales down, deviation up
        // This is the worst-case efficiency crisis that was previously invisible
        parts.push(
          `🚨 CRITICAL: Sales turun ${(Math.abs(sg) * 100).toFixed(1).replace('.', ',')}% tetapi deviation naik ${(dg * 100).toFixed(1).replace('.', ',')}% — efisiensi memburuk signifikan. Revenue menurun sementara loss meningkat, perlu investigasi segera.`
        );
      } else if (sg > 0 && dg > thresholds.SALES_DEVIATION_FACTOR * sg) {
        // Existing mismatch: deviation growing factor× faster than sales
        parts.push(
          `🚨 MISMATCH: Deviasi growth ${(dg * 100).toFixed(1).replace('.', ',')}% jauh melebihi Sales growth ${(sg * 100).toFixed(1).replace('.', ',')}% — deviation tumbuh ${(dg / sg).toFixed(1)}x lebih cepat dari sales. Kemungkinan ada masalah pencatatan atau kebocoran.`
        );
      } else if (sg < 0 && dg < sg) {
        // Both negative, deviation dropped faster than sales — efficiency improving
        parts.push(`🟢 Sales turun tapi deviasi turun lebih cepat — efisiensi membaik.`);
      } else if (sg < 0 && dg < 0 && dg > sg) {
        // Both negative, deviation dropped slower than sales — mild concern
        parts.push(
          `⚠️ Sales turun ${(Math.abs(sg) * 100).toFixed(1).replace('.', ',')}% dan deviasi juga turun ${(Math.abs(dg) * 100).toFixed(1).replace('.', ',')}%, tetapi deviasi turun lebih lambat — perlu monitoring.`
        );
      }
    }
    parts.push('');
  }

  // FIX §25: HIPOTESIS section — explains the likely drivers behind observed deviations
  parts.push('');
  parts.push(`🧐 HIPOTESIS`);
  if (qtyDeviasiTotal > 0 && residualLossQty / qtyDeviasiTotal > thresholds.RESIDUAL_LOSS_HIGH_PCT) {
    parts.push(
      `• RESIDUAL TINGGI: ${((residualLossQty / qtyDeviasiTotal) * 100).toFixed(0)}% deviasi tidak terjelaskan — kemungkinan pencatatan Waste/Susut/Trial tidak akurat, receiving discrepancy, atau transfer belum tercatat.`
    );
  }
  if (growthComparison.priceGrowth != null && growthComparison.priceGrowth > 0.05) {
    parts.push(
      `• PRICE EFFECT: Harga naik ${(growthComparison.priceGrowth * 100).toFixed(1)}% — sebagian kenaikan nominal deviation dapat dipengaruhi oleh kenaikan harga, bukan murni operational usage.`
    );
  }
  if (totalLoss > totalSurplus * 2) {
    parts.push(
      `• OVER-CONSUMPTION INDIKASI: LOSS ${((totalLoss / (totalLoss + totalSurplus)) * 100).toFixed(0)}% dominan — terdapat indikasi pemakaian aktual melebihi SOC. Perlu investigasi actual usage vs SOC, portioning, dan pencatatan.`
    );
  }
  parts.push(
    `Catatan: Hipotesis berdasarkan indikasi data. Root cause memerlukan physical investigation dan evidence.`
  );

  if (topItemsByNominal.length > 0) {
    parts.push(`🔝 TOP 3 ITEM BY NOMINAL DEVIASI`);
    for (const it of topItemsByNominal.slice(0, 3)) {
      parts.push(`• ${it.itemName} (${it.outletCode}): Rp ${it.absNominal.toLocaleString('id-ID')} [${it.direction}]`);
    }
    parts.push('');
  }
  if (investigationWorklist.length > 0) {
    parts.push(`🔍 WORKLIST INVESTIGASI: ${investigationWorklist.length} items`);
    const p1Count = investigationWorklist.filter((w) => w.priority === 'P1').length;
    const p2Count = investigationWorklist.filter((w) => w.priority === 'P2').length;
    parts.push(`• P1 (kritis): ${p1Count} items`);
    parts.push(`• P2 (peringatan): ${p2Count} items`);
    if (p1Count > 0) {
      parts.push(`🚨 PRIORITAS: Investigasi P1 items segera (nominal > Rp ${(thresholds.HIGH_LOSS_NOMINAL_THRESHOLD * 50 / 1000000).toFixed(0)}Jt atau residual > ${(thresholds.RESIDUAL_LOSS_HIGH_PCT * 100).toFixed(0)}%).`);
    }
  } else {
    parts.push(`✅ Tidak ada anomali signifikan terdeteksi pada periode ini.`);
  }

  // Variance analysis narrative
  if (varianceAnalysis.topWorsened.length > 0 || varianceAnalysis.topImproved.length > 0) {
    parts.push('');
    parts.push(`📉 ANALISIS VARIANCE (vs ${compareWeek || 'sebelumnya'})`);
    if (varianceAnalysis.topWorsened.length > 0) {
      parts.push(`🔴 MEMBURUK (top 3):`);
      for (const v of varianceAnalysis.topWorsened.slice(0, 3)) {
        parts.push(
          `• ${v.itemName} (${v.outletCode}): +Rp ${v.change.toLocaleString('id-ID')} ${v.changePct != null ? `(${(v.changePct * 100).toFixed(0).replace('.', ',')}%)` : ''}`
        );
      }
    }
    if (varianceAnalysis.topImproved.length > 0) {
      parts.push(`🟢 MEMBAIK (top 3):`);
      for (const v of varianceAnalysis.topImproved.slice(0, 3)) {
        parts.push(
          `• ${v.itemName} (${v.outletCode}): Rp ${v.change.toLocaleString('id-ID')} ${v.changePct != null ? `(${(v.changePct * 100).toFixed(0).replace('.', ',')}%)` : ''}`
        );
      }
    }
  }

  // Outlet health ranking narrative
  if (outletHealthRanking.length > 0) {
    parts.push('');
    parts.push(`🏥 RANKING KESEHATAN OUTLET (worst 5)`);
    for (const o of outletHealthRanking.slice(0, 5)) {
      parts.push(
        `• #${o.rank} ${o.outletName} (${o.outletCode}): score ${o.healthScore}/100, Dev/BOM ${(o.devBomRatio * 100).toFixed(1).replace('.', ',')}%, ${o.abnormalCount} item abnormal`
      );
    }
    const criticalCount = outletHealthRanking.filter((o) => o.healthScore < 30).length;
    if (criticalCount > 0) {
      parts.push(`🚨 ${criticalCount} outlet dengan health score < 30 (KRITIS) — perlu intervensi langsung.`);
    }
  }

  // Item consistency narrative
  if (itemConsistencyAnalysis.length > 0) {
    parts.push('');
    parts.push(`🔗 KONSISTENSI ITEM (systemic issues)`);
    const systemic = itemConsistencyAnalysis.filter((i) => i.consistency === 'SYSTEMIC');
    if (systemic.length > 0) {
      parts.push(`⚠️ ${systemic.length} item SYSTEMIC (deviasi di ≥10 outlet):`);
      for (const s of systemic.slice(0, 3)) {
        parts.push(`• ${s.itemName}: ${s.outletCount} outlet, total Rp ${s.totalAbsNominal.toLocaleString('id-ID')}`);
      }
    }
  }

  // P3: Note about receiving/transfer/UOM (requires schema expansion)
  // — surfaces when residual is high, since these are the most likely
  // physical-process explanations for unexplained deviations.
  if (qtyDeviasiTotal > 0 && residualLossQty / qtyDeviasiTotal > 0.5) {
    parts.push('');
    parts.push(
      `📋 CATATAN: Analisis receiving, transfer antar outlet, dan UOM conversion belum tersedia di platform ini. Untuk investigasi residual tinggi, disarankan melakukan cross-check manual terhadap receiving discrepancy, transfer menggantung, dan UOM conversion mismatch.`
    );
  }

  return parts.join('\n');
}

// ------------------------------------------------------------
//  Recommendations
// ------------------------------------------------------------

/** Bundle of inputs consumed by the recommendations generator. */
export interface RecommendationInput {
  totals: Totals;
  byOutlet: Map<string, OutletAgg>;
  investigationWorklist: WorklistItem[];
  growthComparison: GrowthComparison;
  areaAnalysis: AreaAnalysisItem[];
  itemConsistencyAnalysis: ItemConsistency[];
  thresholds: RuntimeThresholds;
}

/**
 * Generate rule-based recommendations derived from the available signals
 * (P1 worklist count, residual ratio, growth mismatch, risk concentration,
 * area gap, direction imbalance, systemic items). Falls back to a P3
 * "no critical anomalies" entry if no triggers fire.
 * FIX P0-5: Now async — reads thresholds from Settings (not hardcoded).
 */
export async function generateRecommendations(input: RecommendationInput): Promise<Recommendation[]> {
  const { thresholds } = input;
  const {
    totals,
    byOutlet,
    investigationWorklist,
    growthComparison,
    areaAnalysis,
    itemConsistencyAnalysis,
  } = input;

  const {
    qtyDeviasiTotal,
    nomDeviasiTotal,
    totalLoss,
    totalSurplus,
    residualLossQty,
  } = totals;

  const recommendations: Recommendation[] = [];

  const p1Items = investigationWorklist.filter((w) => w.priority === 'P1');
  if (p1Items.length > 0) {
    recommendations.push({
      why: `${p1Items.length} item dengan nominal deviation > Rp ${(thresholds.HIGH_LOSS_NOMINAL_THRESHOLD * 50 / 1000000).toFixed(0)}Jt atau residual > ${(thresholds.RESIDUAL_LOSS_HIGH_PCT * 100).toFixed(0)}% — perlu investigasi segera`,
      what: [
        'Audit langsung ke outlet terkait',
        'Verifikasi pencatatan BOM vs COM',
        'Cek apakah ada waste/susut/trial yang tidak tercatat',
        'Konfirmasi dengan kepala outlet dalam 1x24 jam',
      ],
      priority: 'P1',
    });
  }

  if (residualLossQty > 0 && qtyDeviasiTotal > 0 && residualLossQty / qtyDeviasiTotal > thresholds.RESIDUAL_LOSS_WARN_PCT) {
    recommendations.push({
      why: `Residual loss ${((residualLossQty / qtyDeviasiTotal) * 100).toFixed(0)}% dari total deviation — sebagian besar deviation tidak terjelaskan`,
      what: [
        'Review proses pencatatan waste, susut, trial',
        'Training ulang crew outlet untuk input data',
        'Buat standard operating procedure untuk klasifikasi deviation',
      ],
      priority: 'P2',
    });
  }

  // FIX P0-2: Growth mismatch recommendations — now covers critical case
  if (
    growthComparison.salesGrowth != null &&
    growthComparison.nominalDeviasiGrowth != null
  ) {
    const sg = growthComparison.salesGrowth;
    const dg = growthComparison.nominalDeviasiGrowth;

    if (sg < 0 && dg > 0) {
      // CRITICAL: sales down, deviation up
      recommendations.push({
        why: `Sales turun ${(Math.abs(sg) * 100).toFixed(1)}% tetapi deviation naik ${(dg * 100).toFixed(1)}% — krisis efisiensi, revenue menurun sementara loss meningkat`,
        what: [
          'Investigasi segera: cek apakah ada kebocoran stock atau pencurian',
          'Verifikasi pencatatan BOM vs actual usage di outlet dengan deviation tertinggi',
          'Cek apakah ada perubahan supplier atau kualitas bahan baku',
          'Review pricing strategy — mungkin perlu adjust menu price',
        ],
        priority: 'P1',
      });
    } else if (sg > 0 && dg > thresholds.SALES_DEVIATION_FACTOR * sg) {
      // Existing: deviation growing factor× faster than sales
      recommendations.push({
        why: `Deviasi growth ${(dg * 100).toFixed(1)}% jauh melebihi Sales growth ${(sg * 100).toFixed(1)}% — indikasi mismatch pencatatan atau kebocoran`,
        what: [
          'Bandingkan dengan periode sebelumnya',
          'Cek apakah ada perubahan harga atau menu',
          'Investigasi apakah ada pattern yang konsisten di outlet tertentu',
        ],
        priority: 'P2',
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      why: 'Tidak ada anomali kritis terdeteksi pada periode ini',
      what: ['Lanjutkan monitoring berkala', 'Review data mingguan untuk trend'],
      priority: 'P3',
    });
  }

  // Additional recommendations based on deepened analysis
  // Risk concentration
  if (byOutlet.size > 0) {
    const sortedOutlets = [...byOutlet.entries()].sort((a, b) => b[1].absNominal - a[1].absNominal);
    const top3Nominal = sortedOutlets.slice(0, 3).reduce((s, [, v]) => s + v.absNominal, 0);
    const concentrationPct = nomDeviasiTotal > 0 ? (top3Nominal / nomDeviasiTotal) * 100 : 0;
    if (concentrationPct > thresholds.CONCENTRATION_PCT * 100) {
      recommendations.push({
        why: `Risiko terkonsentrasi di 3 outlet teratas (${concentrationPct.toFixed(0)}% dari total) — fokus investigasi akan lebih efektif`,
        what: [
          `Prioritaskan audit ke: ${sortedOutlets.slice(0, 3).map(([c]) => c).join(', ')}`,
          'Bandingkan performance outlet sebelum dan sesudah intervensi',
          'Identifikasi best practice dari outlet dengan score > 70',
        ],
        priority: 'P2',
      });
    }
  }

  // Area comparison recommendation
  if (areaAnalysis.length > 1) {
    const worstArea = areaAnalysis[0];
    const bestArea = areaAnalysis[areaAnalysis.length - 1];
    if (worstArea.lossToSales > bestArea.lossToSales * 3) {
      recommendations.push({
        why: `Area ${worstArea.area} memiliki Loss/Sales ${(worstArea.lossToSales * 100).toFixed(1)}% — jauh lebih buruk dari ${bestArea.area} (${(bestArea.lossToSales * 100).toFixed(1)}%)`,
        what: [
          `Benchmark SOP area ${bestArea.area} ke area ${worstArea.area}`,
          'Cek perbedaan supplier, proses, atau training crew',
          'Assign area manager untuk monitoring intensif',
        ],
        priority: 'P2',
      });
    }
  }

  // Direction imbalance recommendation
  if (totalLoss + totalSurplus > 0) {
    const lossPct = totalLoss / (totalLoss + totalSurplus);
    if (lossPct > thresholds.DIRECTION_IMBALANCE_PCT) {
      recommendations.push({
        why: `Dominasi LOSS (${(lossPct * 100).toFixed(0)}%) — pemakaian aktual konsisten melebihi SOC`,
        what: [
          'Review BOM apakah masih relevan dengan portion aktual',
          'Cek apakah ada kebocoran stock atau pencurian',
          'Training ulang crew untuk portion control',
        ],
        priority: 'P2',
      });
    } else if (lossPct < (1 - thresholds.DIRECTION_IMBALANCE_PCT)) {
      recommendations.push({
        why: `Dominasi SURPLUS (${((1 - lossPct) * 100).toFixed(0)}%) — pemakaian aktual konsisten di bawah SOC`,
        what: [
          'Review BOM apakah perlu dinaikkan (under-portion)',
          'Cek apakah ada menu yang tidak terpakai',
          'Verifikasi apakah ada pencatatan yang tertinggal',
        ],
        priority: 'P3',
      });
    }
  }

  // Systemic item recommendation
  const systemicItems = itemConsistencyAnalysis.filter((i) => i.consistency === 'SYSTEMIC');
  if (systemicItems.length > 0) {
    recommendations.push({
      why: `${systemicItems.length} item bersifat SYSTEMIC (deviasi di ≥10 outlet) — masalah produk, bukan outlet`,
      what: [
        `Review BOM dan harga beli untuk: ${systemicItems.slice(0, 3).map((i) => i.itemName).join(', ')}`,
        'Cek apakah ada masalah kualitas dari supplier',
        'Pertimbangkan renegotiasi harga atau ganti supplier',
      ],
      priority: 'P2',
    });
  }

  return recommendations;
}
