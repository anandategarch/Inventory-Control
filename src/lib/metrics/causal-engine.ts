// ============================================================
//  CAUSAL ENGINE — Bayesian Inference for Deviation Diagnosis
//  --------------------------------------------------------
//  Computes posterior probability for 7 cause types given
//  evidence from rule fires + decomposition data + BOM status
//  + growth rates + historical zScores.
//
//  Bayesian model (simplified — per spec):
//    For each cause C_i:
//      1. Start with prior P(C_i)
//      2. For each evidence item, multiply by likelihood ratio:
//         - Evidence PRESENT  → multiply by (1 + weight)
//         - Evidence ABSENT   → multiply by 1.0 (no penalty)
//      3. posterior_i = prior_i × Π(likelihood_factors for present evidence)
//      4. confidence_i = posterior_i / Σ(all posteriors)
//      5. Return top 3 causes by confidence
//
//  Why simplified (not full Naive Bayes with P(E|¬C)):
//    - Domain evidence is highly correlated (e.g. SUSUT_BOM_MISMATCH
//      rule fire correlates with susutZScore > 1). Full Naive Bayes
//      would double-count.
//    - The (1 + weight) boost is a heuristic that approximates the
//      likelihood ratio P(E|C) / P(E|¬C) without requiring per-evidence
//      priors. Weights in [0.10, 0.40] keep boosts in [1.10×, 1.40×].
//    - Normalisation at the end converts unnormalised posteriors to a
//      proper probability distribution over the 7 causes.
//
//  Pure functions — no DB access. The query layer (src/lib/queries/
//  diagnosis.ts) assembles OutletEvidence[]; this module just runs
//  the Bayesian computation.
// ============================================================

// ============================================================
//  CAUSE_DEFINITIONS — 7 cause types + Bayesian priors
//  --------------------------------------------------------
//  Priors are normalised at runtime (Σ=1.0 after normalisation),
//  so relative weights matter more than absolute values. The
//  values below reflect domain expertise:
//    - SEASONAL (0.20) — most common explanation (high base rate)
//    - MISSING_BOM / SHRINKAGE / PORTIONING / SALES_MIX (0.15) —
//      operational causes, roughly equal prevalence
//    - FRAUD / SUPPLIER (0.10) — rarer, require stronger evidence
// ============================================================
export const CAUSE_DEFINITIONS = [
  {
    id: 'MISSING_BOM',
    label: 'Missing BOM Master Data',
    prior: 0.15,
    description: 'Item tidak memiliki BOM master → 100% deviasi menjadi residual (unexplained)',
    autoAction: 'Set BOM master untuk: {items}. Recalculate Dev/BOM setelah update.',
    evidence: [
      { id: 'bom_zero_items', label: 'Items dengan BOM=0', weight: 0.40 },
      { id: 'residual_high', label: 'Residual > 80% dari deviasi', weight: 0.30 },
      { id: 'tolerance_not_set', label: 'TOLERANCE_NOT_SET_HIGH_DEV fires', weight: 0.20 },
      { id: 'high_nominal_bom_zero', label: 'Nominal deviasi > Rp 10Jt untuk BOM=0 items', weight: 0.10 },
    ],
  },
  {
    id: 'SHRINKAGE',
    label: 'Shrinkage Issue',
    prior: 0.15,
    description: 'Susut berlebihan — penyimpanan/thawing/portioning tidak optimal',
    autoAction: 'Audit proses thawing untuk: {items}. Cek suhu penyimpanan. Update standar susut di BOM.',
    evidence: [
      { id: 'susut_bom_mismatch', label: 'SUSUT_BOM_MISMATCH fires', weight: 0.35 },
      { id: 'susut_pct_high', label: 'Susut > 20% dari deviasi', weight: 0.25 },
      { id: 'susut_growth_high', label: 'Susut growth > BOM growth', weight: 0.20 },
      { id: 'susut_zscore_high', label: 'Susut zScore > 1 (above historical)', weight: 0.20 },
    ],
  },
  {
    id: 'FRAUD',
    label: 'Potential Fraud / Input Error',
    prior: 0.10,
    description: 'Indikasi fraud — Waste+Susut+Trial melebihi deviasi, atau arah berubah',
    autoAction: 'Audit pencatatan SPV. Physical stock count untuk: {items}. Cek double-counting waste/susut/trial.',
    evidence: [
      { id: 'over_explained', label: 'OVER_EXPLAINED fires', weight: 0.35 },
      { id: 'residual_very_high', label: 'Residual > 70%', weight: 0.25 },
      { id: 'direction_flip', label: 'DIRECTION_FLIP fires', weight: 0.20 },
      { id: 'high_loss_nominal', label: 'HIGH_LOSS_NOMINAL fires', weight: 0.20 },
    ],
  },
  {
    id: 'PORTIONING',
    label: 'Portioning Inconsistency',
    prior: 0.15,
    description: 'Porsioning tidak konsisten — deviasi naik saat BOM turun',
    autoAction: 'Sampling porsioning di peak hours untuk: {items}. Training staff portioning consistency.',
    evidence: [
      { id: 'bom_down_dev_up', label: 'BOM_DOWN_DEV_UP fires', weight: 0.30 },
      { id: 'dev_bom_high', label: 'Dev/BOM > 30%', weight: 0.25 },
      { id: 'multiple_items', label: '> 5 item affected', weight: 0.25 },
      { id: 'deviasi_growth_disproportionate', label: 'Deviasi growth > 1.5× BOM growth', weight: 0.20 },
    ],
  },
  {
    id: 'SUPPLIER',
    label: 'Supplier / Receiving Issue',
    prior: 0.10,
    description: 'Masalah supplier atau receiving — multiple item LOSS bersamaan',
    autoAction: 'Verifikasi receiving untuk: {items}. Bandingkan qty diterima vs invoice. Cek supplier quality.',
    evidence: [
      { id: 'multi_item_loss', label: 'Multiple items sama direction LOSS', weight: 0.35 },
      { id: 'bom_deviation_mismatch', label: 'BOM_DEVIATION_MISMATCH fires', weight: 0.25 },
      { id: 'high_loss', label: 'HIGH_LOSS_NOMINAL fires', weight: 0.20 },
      { id: 'nominal_large', label: 'Total nominal loss > Rp 50Jt', weight: 0.20 },
    ],
  },
  {
    id: 'SALES_MIX',
    label: 'Sales Mix Shift',
    prior: 0.15,
    description: 'Pergeseran sales mix — penjualan turun tapi deviasi naik',
    autoAction: 'Analisa sales mix shift: item baru muncul, item lama turun. Update BOM untuk item baru.',
    evidence: [
      { id: 'sales_dev_decrease', label: 'SALES_DEV_DECREASE fires', weight: 0.30 },
      { id: 'sales_down_deviasi_up', label: 'Sales turun + deviasi naik', weight: 0.30 },
      { id: 'item_count_changed', label: 'Jumlah item berubah > 10%', weight: 0.20 },
      { id: 'bom_changed_significantly', label: 'BOM berubah > 20%', weight: 0.20 },
    ],
  },
  {
    id: 'SEASONAL',
    label: 'Seasonal Pattern',
    prior: 0.20,
    description: 'Pola musiman — deviasi tinggi di periode yang sama setiap tahun',
    autoAction: 'Antisipasi pola musiman: prepare stock + staffing untuk periode {month} tahun depan.',
    evidence: [
      { id: 'same_period_high', label: 'Periode sama tahun lalu juga tinggi', weight: 0.40 },
      { id: 'trend_deteriorating', label: 'Trend DETERIORATING 2+ periode', weight: 0.30 },
      { id: 'multi_outlet_pattern', label: 'Multiple outlet show same pattern', weight: 0.30 },
    ],
  },
] as const;

export type CauseId =
  | 'MISSING_BOM'
  | 'SHRINKAGE'
  | 'FRAUD'
  | 'PORTIONING'
  | 'SUPPLIER'
  | 'SALES_MIX'
  | 'SEASONAL';

// ============================================================
//  OutletEvidence — input shape (assembled by query layer)
//  --------------------------------------------------------
//  All fields are per-outlet aggregates for the current period
//  (plus growth vs previous period + historical baseline for
//  zScores). The engine is a PURE function of this interface —
//  no DB access, no side effects.
// ============================================================
export interface OutletEvidence {
  outletCode: string;
  outletName: string;
  area: string;
  // Rule fires (count per rule code, per outlet)
  ruleFires: Record<string, number>;
  // Decomposition (ABS magnitude — always non-negative)
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  /** residual / |qtyDeviasi| — fraction of deviation UNEXPLAINED by waste+susut+trial */
  residualPct: number;
  // BOM status
  /** item names with qtyBom = 0 or NULL */
  bomZeroItems: string[];
  /** total nominalDeviasi (ABS) for BOM=0 items */
  bomZeroNominal: number;
  // Z-Scores (SIGNED: positive = above historical mean = worse)
  susutZScore: number | null;
  // Growth rates (vs previous period, NULL when prev period missing)
  bomGrowth: number | null;
  qtyDeviasiGrowth: number | null;
  // Nominal aggregates
  totalLoss: number;
  totalSurplus: number;
  /** signed — negative = net loss, positive = net surplus */
  netLossSurplus: number;
  // Item count (current vs previous period)
  itemCount: number;
  prevItemCount: number;
  // Sales (current vs previous period — outlet-level)
  sales: number;
  prevSales: number;
  // Direction flips (count of records where direction flipped LOSS↔SURPLUS vs prev)
  directionFlips: number;
  // Historical zScores from previous periods (per-period aggregate qtyDeviasi
  // zScore vs other historical periods — used for SEASONAL detection).
  historicalZScores: number[];
}

// ============================================================
//  CausalResult — output shape (consumed by API response)
//  --------------------------------------------------------
//  `causes` is sorted by confidence DESC, top 3 only (per spec).
//  Each cause includes its evidence array (for UI explanation)
//  + an `impactEstimate` (estimated Rp impact attributable to
//  this cause — derived from cause-specific heuristics).
// ============================================================
export interface CausalEvidence {
  id: string;
  label: string;
  present: boolean;
  weight: number;
}

export interface CausalCause {
  causeId: CauseId;
  causeLabel: string;
  /** normalised posterior probability — 0..1, Σ(top 3) ≤ 1 */
  confidence: number;
  evidence: CausalEvidence[];
  autoAction: string;
  /** estimated Rp impact attributable to this cause */
  impactEstimate: number;
}

export interface CausalResult {
  outletCode: string;
  outletName: string;
  area: string;
  causes: CausalCause[];
  topCause: CauseId;
  topConfidence: number;
}

// ============================================================
//  Evidence evaluators — one per cause
//  --------------------------------------------------------
//  Each returns an array of CausalEvidence (one per evidence
//  item defined in CAUSE_DEFINITIONS). `present` is determined
//  by checking the outlet's evidence fields against the cause-
//  specific trigger condition.
//
//  The `ctx` carries cross-outlet signals (multiOutletPattern)
//  that cannot be derived from a single outlet's evidence.
// ============================================================
interface EvidenceContext {
  /** true if ≥3 other outlets in the same area share a similar deviation pattern */
  multiOutletPattern: boolean;
}

const RULE_FIRED = (outlet: OutletEvidence, code: string): boolean =>
  (outlet.ruleFires[code] ?? 0) > 0;

function evaluateMissingBom(outlet: OutletEvidence): CausalEvidence[] {
  return [
    { id: 'bom_zero_items', label: 'Items dengan BOM=0', weight: 0.40, present: outlet.bomZeroItems.length > 0 },
    { id: 'residual_high', label: 'Residual > 80% dari deviasi', weight: 0.30, present: outlet.residualPct > 0.80 },
    { id: 'tolerance_not_set', label: 'TOLERANCE_NOT_SET_HIGH_DEV fires', weight: 0.20, present: RULE_FIRED(outlet, 'TOLERANCE_NOT_SET_HIGH_DEV') },
    { id: 'high_nominal_bom_zero', label: 'Nominal deviasi > Rp 10Jt untuk BOM=0 items', weight: 0.10, present: outlet.bomZeroNominal > 10_000_000 },
  ];
}

function evaluateShrinkage(outlet: OutletEvidence): CausalEvidence[] {
  const susutPctOfDeviasi = outlet.qtyDeviasi > 0 ? outlet.qtySusut / outlet.qtyDeviasi : 0;
  // susut_growth_high: susutZScore > 0.5 (susut above historical mean — proxy for
  // growth since we don't have explicit prevQtySusut per outlet).
  const susutGrowthHigh = outlet.susutZScore != null && outlet.susutZScore > 0.5;
  const susutZScoreHigh = outlet.susutZScore != null && outlet.susutZScore > 1.0;
  return [
    { id: 'susut_bom_mismatch', label: 'SUSUT_BOM_MISMATCH fires', weight: 0.35, present: RULE_FIRED(outlet, 'SUSUT_BOM_MISMATCH') },
    { id: 'susut_pct_high', label: 'Susut > 20% dari deviasi', weight: 0.25, present: susutPctOfDeviasi > 0.20 },
    { id: 'susut_growth_high', label: 'Susut growth > BOM growth', weight: 0.20, present: susutGrowthHigh },
    { id: 'susut_zscore_high', label: 'Susut zScore > 1 (above historical)', weight: 0.20, present: susutZScoreHigh },
  ];
}

function evaluateFraud(outlet: OutletEvidence): CausalEvidence[] {
  return [
    { id: 'over_explained', label: 'OVER_EXPLAINED fires', weight: 0.35, present: RULE_FIRED(outlet, 'OVER_EXPLAINED') },
    { id: 'residual_very_high', label: 'Residual > 70%', weight: 0.25, present: outlet.residualPct > 0.70 },
    { id: 'direction_flip', label: 'DIRECTION_FLIP fires', weight: 0.20, present: RULE_FIRED(outlet, 'DIRECTION_FLIP') || outlet.directionFlips > 0 },
    { id: 'high_loss_nominal', label: 'HIGH_LOSS_NOMINAL fires', weight: 0.20, present: RULE_FIRED(outlet, 'HIGH_LOSS_NOMINAL') },
  ];
}

function evaluatePortioning(outlet: OutletEvidence): CausalEvidence[] {
  // Dev/BOM > 30%: we don't have per-outlet SUM(qtyBom) in the evidence
  // interface (BOM=0 items would inflate the ratio to infinity). Use rule
  // fires as the proxy:
  //   - BOM_DEVIATION_DISPROPORTIONATE: deviation growth > 1.5× BOM growth
  //   - TOLERANCE_BREACH / TOLERANCE_BREACH_HIGH: |Dev/BOM| > tolerance
  // Either of these firing indicates the outlet has at least one record
  // where Dev/BOM is elevated.
  const devBomHigh =
    RULE_FIRED(outlet, 'BOM_DEVIATION_DISPROPORTIONATE')
    || RULE_FIRED(outlet, 'TOLERANCE_BREACH_HIGH')
    || RULE_FIRED(outlet, 'TOLERANCE_BREACH');
  // deviasi_growth_disproportionate: qtyDeviasiGrowth > 1.5 × bomGrowth (when both positive)
  const deviasiDisproportionate = outlet.bomGrowth != null
    && outlet.bomGrowth > 0
    && outlet.qtyDeviasiGrowth != null
    && outlet.qtyDeviasiGrowth > outlet.bomGrowth * 1.5;
  return [
    { id: 'bom_down_dev_up', label: 'BOM_DOWN_DEV_UP fires', weight: 0.30, present: RULE_FIRED(outlet, 'BOM_DOWN_DEV_UP') },
    { id: 'dev_bom_high', label: 'Dev/BOM > 30%', weight: 0.25, present: devBomHigh },
    { id: 'multiple_items', label: '> 5 item affected', weight: 0.25, present: outlet.itemCount > 5 },
    { id: 'deviasi_growth_disproportionate', label: 'Deviasi growth > 1.5× BOM growth', weight: 0.20, present: deviasiDisproportionate || RULE_FIRED(outlet, 'BOM_DEVIATION_DISPROPORTIONATE') },
  ];
}

function evaluateSupplier(outlet: OutletEvidence): CausalEvidence[] {
  // multi_item_loss: multiple items + net loss direction
  const multiItemLoss = outlet.itemCount > 5 && outlet.netLossSurplus < 0;
  // nominal_large: total loss > Rp 50Jt
  const nominalLarge = outlet.totalLoss > 50_000_000;
  return [
    { id: 'multi_item_loss', label: 'Multiple items sama direction LOSS', weight: 0.35, present: multiItemLoss },
    { id: 'bom_deviation_mismatch', label: 'BOM_DEVIATION_MISMATCH fires', weight: 0.25, present: RULE_FIRED(outlet, 'BOM_DEVIATION_MISMATCH') },
    { id: 'high_loss', label: 'HIGH_LOSS_NOMINAL fires', weight: 0.20, present: RULE_FIRED(outlet, 'HIGH_LOSS_NOMINAL') },
    { id: 'nominal_large', label: 'Total nominal loss > Rp 50Jt', weight: 0.20, present: nominalLarge },
  ];
}

function evaluateSalesMix(outlet: OutletEvidence): CausalEvidence[] {
  // sales_down_deviasi_up: sales declined + deviation grew
  const salesDeclined = outlet.prevSales > 0 && outlet.sales < outlet.prevSales;
  const deviasiUp = (outlet.qtyDeviasiGrowth ?? 0) > 0;
  const salesDownDeviasiUp = salesDeclined && deviasiUp;
  // item_count_changed: |Δ itemCount| / prevItemCount > 10%
  const itemCountChanged = outlet.prevItemCount > 0
    && Math.abs(outlet.itemCount - outlet.prevItemCount) / outlet.prevItemCount > 0.10;
  // bom_changed_significantly: |bomGrowth| > 20%
  const bomChangedSignificantly = outlet.bomGrowth != null && Math.abs(outlet.bomGrowth) > 0.20;
  return [
    { id: 'sales_dev_decrease', label: 'SALES_DEV_DECREASE fires', weight: 0.30, present: RULE_FIRED(outlet, 'SALES_DEV_DECREASE') },
    { id: 'sales_down_deviasi_up', label: 'Sales turun + deviasi naik', weight: 0.30, present: salesDownDeviasiUp },
    { id: 'item_count_changed', label: 'Jumlah item berubah > 10%', weight: 0.20, present: itemCountChanged },
    { id: 'bom_changed_significantly', label: 'BOM berubah > 20%', weight: 0.20, present: bomChangedSignificantly },
  ];
}

function evaluateSeasonal(outlet: OutletEvidence, ctx: EvidenceContext): CausalEvidence[] {
  // same_period_high: at least one prior period had aggregate zScore > 1.5
  // (current period's pattern also appeared in historical periods — seasonal recurrence)
  const samePeriodHigh = outlet.historicalZScores.some((z) => z > 1.5);
  // trend_deteriorating: 2+ historical periods had zScore > 0 (above mean)
  const trendDeteriorating = outlet.historicalZScores.filter((z) => z > 0).length >= 2;
  // multi_outlet_pattern: pre-computed cross-outlet signal (see detectMultiOutletPattern)
  const multiOutletPattern = ctx.multiOutletPattern;
  return [
    { id: 'same_period_high', label: 'Periode sama tahun lalu juga tinggi', weight: 0.40, present: samePeriodHigh },
    { id: 'trend_deteriorating', label: 'Trend DETERIORATING 2+ periode', weight: 0.30, present: trendDeteriorating },
    { id: 'multi_outlet_pattern', label: 'Multiple outlet show same pattern', weight: 0.30, present: multiOutletPattern },
  ];
}

function evaluateEvidenceForCause(
  causeId: CauseId,
  outlet: OutletEvidence,
  ctx: EvidenceContext,
): CausalEvidence[] {
  switch (causeId) {
    case 'MISSING_BOM': return evaluateMissingBom(outlet);
    case 'SHRINKAGE': return evaluateShrinkage(outlet);
    case 'FRAUD': return evaluateFraud(outlet);
    case 'PORTIONING': return evaluatePortioning(outlet);
    case 'SUPPLIER': return evaluateSupplier(outlet);
    case 'SALES_MIX': return evaluateSalesMix(outlet);
    case 'SEASONAL': return evaluateSeasonal(outlet, ctx);
    default: return [];
  }
}

// ============================================================
//  detectMultiOutletPattern — cross-outlet signal for SEASONAL
//  --------------------------------------------------------
//  For each outlet, count OTHER outlets in the same area that
//  show a similar deviation pattern. "Similar" = any of:
//    - residualPct within 0.20 (both unexplained fraction close)
//    - both have directionFlips > 0 (same volatility signal)
//    - both have susutZScore > 1 (same shrinkage anomaly)
//
//  If ≥3 other outlets match, the outlet is part of a multi-
//  outlet pattern (likely seasonal or systemic, not isolated).
// ============================================================
function detectMultiOutletPattern(outlet: OutletEvidence, allOutlets: OutletEvidence[]): boolean {
  const sameArea = allOutlets.filter(
    (o) => o.area === outlet.area && o.outletCode !== outlet.outletCode,
  );
  if (sameArea.length < 3) return false;
  let similarCount = 0;
  for (const other of sameArea) {
    const residualDiff = Math.abs(other.residualPct - outlet.residualPct);
    const bothHaveFlips = other.directionFlips > 0 && outlet.directionFlips > 0;
    const bothHighSusut =
      (other.susutZScore ?? 0) > 1 && (outlet.susutZScore ?? 0) > 1;
    if (residualDiff < 0.20 || bothHaveFlips || bothHighSusut) {
      similarCount++;
    }
  }
  return similarCount >= 3;
}

// ============================================================
//  estimateImpact — Rp impact attributable to each cause
//  --------------------------------------------------------
//  Heuristic: each cause claims a fraction of the outlet's
//  total loss magnitude (|netLossSurplus|). The fraction is
//  cause-specific:
//    - MISSING_BOM: bomZeroNominal (loss from BOM=0 items)
//    - SHRINKAGE:   qtySusut's share of deviation × |net|
//    - FRAUD:       residualPct × |net| (unexplained portion)
//    - PORTIONING:  0.40 × |net| (estimated 40% due to portioning)
//    - SUPPLIER:    0.40 × totalLoss
//    - SALES_MIX:   0.30 × |net|
//    - SEASONAL:    0.20 × |net|
// ============================================================
function estimateImpact(causeId: CauseId, outlet: OutletEvidence): number {
  const absNet = Math.abs(outlet.netLossSurplus);
  switch (causeId) {
    case 'MISSING_BOM':
      // Loss attributable to BOM=0 items (bounded by |net|)
      return Math.min(outlet.bomZeroNominal, absNet);
    case 'SHRINKAGE': {
      // Susut's share of deviation × |net|
      const susutShare = outlet.qtyDeviasi > 0
        ? outlet.qtySusut / outlet.qtyDeviasi
        : 0;
      return Math.min(susutShare * absNet, absNet);
    }
    case 'FRAUD':
      // Unexplained portion (residual) × |net|
      return Math.min(outlet.residualPct * absNet, absNet);
    case 'PORTIONING':
      return Math.min(0.40 * absNet, absNet);
    case 'SUPPLIER':
      return Math.min(0.40 * outlet.totalLoss, outlet.totalLoss);
    case 'SALES_MIX':
      return Math.min(0.30 * absNet, absNet);
    case 'SEASONAL':
      return Math.min(0.20 * absNet, absNet);
    default:
      return 0;
  }
}

// ============================================================
//  formatAutoAction — fill {items} + {month} placeholders
//  --------------------------------------------------------
//  {items} → first 3 BOM=0 item names (or first 3 item-affected
//  outlets if no BOM=0 — for SUPPLIER/PORTIONING we fall back
//  to the outlet name itself).
//  {month} → outlet's area + "period berikutnya" (next period).
// ============================================================
function formatAutoAction(template: string, outlet: OutletEvidence): string {
  const itemsList = outlet.bomZeroItems.length > 0
    ? outlet.bomZeroItems.slice(0, 3).join(', ')
    : outlet.outletName;
  const monthToken = `${outlet.area} — periode berikutnya`;
  return template.replace('{items}', itemsList).replace('{month}', monthToken);
}

// ============================================================
//  computeCausalDiagnosis — main entry point
//  --------------------------------------------------------
//  Takes an array of OutletEvidence (one per outlet) and
//  returns an array of CausalResult (one per outlet).
//
//  Flow:
//    1. Pre-compute multiOutletPattern for each outlet (cross-
//       outlet signal needed by SEASONAL evaluator).
//    2. For each outlet × cause, evaluate evidence array.
//    3. Bayesian: posterior = prior × Π(1 + weight) for PRESENT
//       evidence. Absent evidence contributes factor 1.0.
//    4. Normalise: confidence = posterior / Σ(all 7 posteriors).
//    5. Sort causes by confidence DESC, take top 3.
//    6. Compute impactEstimate per cause.
//    7. Format autoAction with outlet context.
// ============================================================
export function computeCausalDiagnosis(outlets: OutletEvidence[]): CausalResult[] {
  if (outlets.length === 0) return [];

  // Step 1: pre-compute multiOutletPattern for each outlet.
  const multiOutletByOutlet = new Map<string, boolean>();
  for (const outlet of outlets) {
    multiOutletByOutlet.set(
      outlet.outletCode,
      detectMultiOutletPattern(outlet, outlets),
    );
  }

  const results: CausalResult[] = [];
  for (const outlet of outlets) {
    const ctx: EvidenceContext = {
      multiOutletPattern: multiOutletByOutlet.get(outlet.outletCode) ?? false,
    };

    // Step 2-3: evaluate evidence + compute unnormalised posteriors.
    const posteriors: Array<{ causeId: CauseId; evidence: CausalEvidence[]; posterior: number }> = [];
    for (const def of CAUSE_DEFINITIONS) {
      const evidence = evaluateEvidenceForCause(def.id as CauseId, outlet, ctx);
      let posterior = def.prior;
      for (const ev of evidence) {
        if (ev.present) {
          posterior *= (1 + ev.weight);
        }
        // Absent → factor 1.0 (no change).
      }
      posteriors.push({ causeId: def.id as CauseId, evidence, posterior });
    }

    // Step 4: normalise — confidence_i = posterior_i / Σ(posteriors).
    const totalPosterior = posteriors.reduce((s, p) => s + p.posterior, 0);
    const causes: CausalCause[] = posteriors.map((p) => {
      // Lookup is guaranteed to find a match — p.causeId was sourced from
      // CAUSE_DEFINITIONS in the loop above. Fall back to a stub if not
      // found (defensive — should never trigger).
      const def = CAUSE_DEFINITIONS.find((d) => d.id === p.causeId);
      if (!def) {
        return {
          causeId: p.causeId,
          causeLabel: p.causeId,
          confidence: 0,
          evidence: p.evidence,
          autoAction: '',
          impactEstimate: 0,
        };
      }
      const confidence = totalPosterior > 0 ? p.posterior / totalPosterior : 0;
      return {
        causeId: p.causeId,
        causeLabel: def.label,
        confidence: Number(confidence.toFixed(4)),
        evidence: p.evidence,
        autoAction: formatAutoAction(def.autoAction, outlet),
        impactEstimate: Math.round(estimateImpact(p.causeId, outlet)),
      };
    });

    // Step 5: sort by confidence DESC, take top 3.
    causes.sort((a, b) => b.confidence - a.confidence);
    const top3 = causes.slice(0, 3);

    results.push({
      outletCode: outlet.outletCode,
      outletName: outlet.outletName,
      area: outlet.area,
      causes: top3,
      topCause: top3[0]?.causeId ?? ('SEASONAL' as CauseId),
      topConfidence: top3[0]?.confidence ?? 0,
    });
  }

  return results;
}

// ============================================================
//  computeCauseDistribution — aggregate stats across outlets
//  --------------------------------------------------------
//  For the API response's `causeDistribution` field: counts
//  how many outlets have each cause as their TOP cause + the
//  average confidence among those outlets.
// ============================================================
export function computeCauseDistribution(
  results: CausalResult[],
): Record<CauseId, { count: number; avgConfidence: number }> {
  const init = (): { count: number; sumConfidence: number } => ({ count: 0, sumConfidence: 0 });
  const dist: Record<CauseId, { count: number; sumConfidence: number }> = {
    MISSING_BOM: init(),
    SHRINKAGE: init(),
    FRAUD: init(),
    PORTIONING: init(),
    SUPPLIER: init(),
    SALES_MIX: init(),
    SEASONAL: init(),
  };
  for (const r of results) {
    const top = r.causes[0];
    if (!top) continue;
    dist[top.causeId].count += 1;
    dist[top.causeId].sumConfidence += top.confidence;
  }
  const out = {} as Record<CauseId, { count: number; avgConfidence: number }>;
  for (const k of Object.keys(dist) as CauseId[]) {
    const v = dist[k];
    out[k] = {
      count: v.count,
      avgConfidence: v.count > 0 ? Number((v.sumConfidence / v.count).toFixed(4)) : 0,
    };
  }
  return out;
}
