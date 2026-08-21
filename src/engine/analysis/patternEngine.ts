// ============================================================
//  PATTERN ENGINE — Cross-Outlet Pattern Detection
//  --------------------------------------------------------
//  Classifies deviations into 4 pattern archetypes:
//
//    SYSTEMIC_ITEM     — same item deviates across MANY outlets
//                        → item-level problem (recipe / supplier / price)
//
//    ISOLATED_OUTLET   — one outlet deviates across MANY items
//                        → outlet-level problem (staff / process / fraud)
//
//    AREA_LEVEL        — outlets in same area share a deviation pattern
//                        → area-level problem (supervisor / logistics)
//
//    NETWORK_WIDE      — network-wide deviation exceeds tolerance
//                        → systemic process issue
//
//  Inputs are existing analysis artifacts (outlet health ranking,
//  item consistency, area analysis) — no extra DB queries needed.
//
//  Detection thresholds (tunable):
//    SYSTEMIC_ITEM   : deviatingOutlets / totalOutlets > 0.30
//    ISOLATED_OUTLET : deviatingItems   / totalItems   > 0.50
//    AREA_LEVEL      : area.avgDevBom > 1.5 × network.avgDevBom
//    NETWORK_WIDE    : network.avgDevBom > 0.10 (10%)
//
//  All comparisons use ABS() magnitudes per the platform's sign
//  convention (LOSS = negative).
// ============================================================

/**
 * Outlet shape consumed by detectPatterns.
 * Mirrors `computeOutletHealthRanking` output.
 */
export interface AnalysisOutlet {
  outletCode: string;
  outletName: string;
  area: string;
  /** Health score 0-100 (lower = worse). */
  healthScore: number;
  /** # items at this outlet with no rule flags. */
  normal: number;
  /** # items at this outlet flagged WARNING. */
  warning: number;
  /** # items at this outlet flagged ABNORMAL. */
  abnormal: number;
  /** Σ |nominalDeviasi| across all items at this outlet. */
  absNominal: number;
  /** Aggregate Dev/BOM at this outlet. */
  devBom: number;
  /** Outlet sales (MODE per outlet). */
  sales: number;
}

/**
 * Item shape consumed by detectPatterns.
 * Mirrors `queryItemConsistency` output.
 */
export interface AnalysisItem {
  itemName: string;
  /** # distinct outlets where this item has |nominalLossSurplus| > 0. */
  outletCount: number;
  /** Σ |nominalLossSurplus| across all outlets for this item. */
  totalAbsNominal: number;
  /** Volume-weighted Dev/BOM across all outlets for this item. */
  avgDevBom: number;
  /** Existing consistency classification (informational). */
  consistency?: 'SYSTEMIC' | 'WIDESPREAD' | 'ISOLATED';
}

/**
 * Area shape consumed by detectPatterns.
 * Mirrors `queryAreaAnalysis` output.
 */
export interface AnalysisArea {
  area: string;
  outletCount: number;
  totalSales: number;
  totalAbsNominal: number;
  avgDevBom: number;
  /** Area-level loss-to-sales ratio (optional — used for severity enrichment). */
  lossToSales?: number | null;
}

/**
 * Aggregated analysis data passed to detectPatterns.
 * All fields optional — the engine degrades gracefully when a section
 * is missing (e.g. itemConsistency may be empty if no items breached
 * the underlying SQL filter).
 */
export interface AnalysisData {
  /** Per-outlet health ranking (worst-first is fine, order is ignored). */
  outletHealthRanking?: AnalysisOutlet[];
  /** Per-item consistency summary. */
  itemConsistency?: AnalysisItem[];
  /** Per-area aggregates. */
  areaAnalysis?: AnalysisArea[];
  /**
   * Total number of outlets in the dataset (denominator for SYSTEMIC_ITEM ratio).
   * If omitted, derived from `outletHealthRanking.length` (which only contains
   * outlets with at least one deviation — this is a conservative denominator).
   */
  totalOutlets?: number;
  /**
   * Network-wide average Dev/BOM. If omitted, computed as the outletCount-
   * weighted mean of `areaAnalysis[].avgDevBom`. If neither is available,
   * falls back to the mean of `outletHealthRanking[].devBom`.
   */
  networkAvgDevBom?: number;
}

/**
 * Single detected pattern. Fields `affectedItems`, `affectedOutlets`,
 * `affectedAreas` are populated based on `type`.
 */
export interface PatternDetection {
  type: 'SYSTEMIC_ITEM' | 'ISOLATED_OUTLET' | 'AREA_LEVEL' | 'NETWORK_WIDE';
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  /** Short human-readable title (Indonesian). */
  title: string;
  /** Longer human-readable description (Indonesian). */
  description: string;
  /** For SYSTEMIC_ITEM: item names that breach the systemic threshold. */
  affectedItems?: string[];
  /** For ISOLATED_OUTLET: outlet codes that breach the isolated threshold. */
  affectedOutlets?: string[];
  /** For AREA_LEVEL: area names that breach the area-level threshold. */
  affectedAreas?: string[];
  /** Recommended next action (Indonesian). */
  recommendation: string;
}

// ============================================================
//  Tunable thresholds (kept module-local for now — promote to
//  src/config/thresholds.ts if they need runtime tuning)
// ============================================================
const SYSTEMIC_ITEM_RATIO_THRESHOLD = 0.30; // 30%+ outlets deviating
const SYSTEMIC_ITEM_CRITICAL_RATIO = 0.50;  // 50%+ outlets → CRITICAL
const SYSTEMIC_ITEM_TOP_N = 5;              // show top 5 items

const ISOLATED_OUTLET_RATIO_THRESHOLD = 0.50; // 50%+ items deviating
const ISOLATED_OUTLET_CRITICAL_RATIO = 0.70;  // 70%+ items → CRITICAL
const ISOLATED_OUTLET_MIN_ITEMS = 5;          // need ≥5 items evaluated
const ISOLATED_OUTLET_TOP_N = 5;              // show top 5 outlets

const AREA_LEVEL_FACTOR = 1.5;   // > 1.5× network avg → AREA_LEVEL
const AREA_LEVEL_CRITICAL_FACTOR = 2.0; // > 2.0× → CRITICAL
const AREA_LEVEL_TOP_N = 5;      // show top 5 areas

const NETWORK_WIDE_THRESHOLD = 0.10;  // 10%+ network avg Dev/Bom
const NETWORK_WIDE_CRITICAL = 0.20;   // 20%+ → CRITICAL

// ============================================================
//  Helpers
// ============================================================

function safeNumber(v: number | null | undefined): number {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return 0;
  return v;
}

/**
 * Compute the network-wide average Dev/BOM from areaAnalysis (outletCount-weighted).
 * Falls back to simple mean of outlet devBom values when areaAnalysis is missing.
 * Returns 0 when no data is available.
 */
function computeNetworkAvgDevBom(data: AnalysisData): number {
  if (data.networkAvgDevBom != null && isFinite(data.networkAvgDevBom)) {
    return Math.abs(data.networkAvgDevBom);
  }
  const areas = data.areaAnalysis ?? [];
  if (areas.length > 0) {
    const totalWeight = areas.reduce((s, a) => s + Math.max(0, a.outletCount), 0);
    if (totalWeight > 0) {
      const weighted = areas.reduce(
        (s, a) => s + Math.abs(a.avgDevBom) * Math.max(0, a.outletCount),
        0,
      );
      return weighted / totalWeight;
    }
    // No outlet counts → simple mean of |avgDevBom|
    return areas.reduce((s, a) => s + Math.abs(a.avgDevBom), 0) / areas.length;
  }
  // Last resort: mean of outlet devBom values
  const outlets = data.outletHealthRanking ?? [];
  if (outlets.length === 0) return 0;
  return outlets.reduce((s, o) => s + Math.abs(o.devBom), 0) / outlets.length;
}

/**
 * Compute total outlets in the dataset — preferred explicit value,
 * otherwise derived from outletHealthRanking length.
 */
function computeTotalOutlets(data: AnalysisData): number {
  if (data.totalOutlets != null && data.totalOutlets > 0) return data.totalOutlets;
  return data.outletHealthRanking?.length ?? 0;
}

function severityFromRatio(
  ratio: number,
  criticalThreshold: number,
): 'CRITICAL' | 'WARNING' {
  return ratio >= criticalThreshold ? 'CRITICAL' : 'WARNING';
}

function severityFromFactor(
  factor: number,
  criticalFactor: number,
): 'CRITICAL' | 'WARNING' {
  return factor >= criticalFactor ? 'CRITICAL' : 'WARNING';
}

// ============================================================
//  Detectors
// ============================================================

/**
 * Detect SYSTEMIC_ITEM patterns — items that deviate across many outlets.
 *
 * For each item: ratio = item.outletCount / totalOutlets
 * If ratio > 0.30 → flag (CRITICAL if ratio > 0.50).
 *
 * Recommendation: review recipe / supplier / price for the affected items.
 */
function detectSystemicItems(
  data: AnalysisData,
  totalOutlets: number,
): PatternDetection[] {
  const items = data.itemConsistency ?? [];
  if (items.length === 0 || totalOutlets === 0) return [];

  const flagged = items
    .map((item) => {
      const outletCount = Math.max(0, item.outletCount);
      const ratio = outletCount / totalOutlets;
      return { item, ratio, outletCount };
    })
    .filter((x) => x.ratio > SYSTEMIC_ITEM_RATIO_THRESHOLD)
    .sort((a, b) => b.item.totalAbsNominal - a.item.totalAbsNominal)
    .slice(0, SYSTEMIC_ITEM_TOP_N);

  if (flagged.length === 0) return [];

  return flagged.map(({ item, ratio, outletCount }) => {
    const pct = Math.round(ratio * 100);
    const severity = severityFromRatio(ratio, SYSTEMIC_ITEM_CRITICAL_RATIO);
    return {
      type: 'SYSTEMIC_ITEM' as const,
      severity,
      title: `Item sistemik: ${item.itemName}`,
      description:
        `Item ${item.itemName} deviasi di ${outletCount} dari ${totalOutlets} outlet ` +
        `(${pct}%) — potensi masalah recipe / supplier / price. ` +
        `Total |nominal| ${formatNominal(item.totalAbsNominal)}, avg Dev/BOM ${(item.avgDevBom * 100).toFixed(1)}%.`,
      affectedItems: [item.itemName],
      recommendation:
        'Review recipe & BOM aktual, validasi harga supplier, dan sampling pemakaian per outlet untuk item ini.',
    };
  });
}

/**
 * Detect ISOLATED_OUTLET patterns — outlets that deviate across many items.
 *
 * For each outlet:
 *   deviatingItems = warning + abnormal (items with rule flags)
 *   totalItems     = normal + warning + abnormal (all evaluated items)
 *   ratio = deviatingItems / totalItems
 *
 * If ratio > 0.50 → flag (CRITICAL if ratio > 0.70).
 * Outlets with fewer than ISOLATED_OUTLET_MIN_ITEMS evaluated are skipped
 * (insufficient sample to draw conclusions).
 */
function detectIsolatedOutlets(
  data: AnalysisData,
): PatternDetection[] {
  const outlets = data.outletHealthRanking ?? [];
  if (outlets.length === 0) return [];

  const flagged = outlets
    .map((o) => {
      const normal = safeNumber(o.normal);
      const warning = safeNumber(o.warning);
      const abnormal = safeNumber(o.abnormal);
      const total = normal + warning + abnormal;
      const deviating = warning + abnormal;
      const ratio = total > 0 ? deviating / total : 0;
      return { outlet: o, total, deviating, ratio };
    })
    .filter(
      (x) =>
        x.total >= ISOLATED_OUTLET_MIN_ITEMS &&
        x.ratio > ISOLATED_OUTLET_RATIO_THRESHOLD,
    )
    .sort((a, b) => b.ratio - a.ratio || b.outlet.abnormal - a.outlet.abnormal)
    .slice(0, ISOLATED_OUTLET_TOP_N);

  if (flagged.length === 0) return [];

  return flagged.map(({ outlet, total, deviating, ratio }) => {
    const pct = Math.round(ratio * 100);
    const severity = severityFromRatio(ratio, ISOLATED_OUTLET_CRITICAL_RATIO);
    return {
      type: 'ISOLATED_OUTLET' as const,
      severity,
      title: `Outlet terisolasi: ${outlet.outletCode} — ${outlet.outletName}`,
      description:
        `Outlet ${outlet.outletCode} punya ${deviating} dari ${total} item deviasi ` +
        `(${pct}%) — masalah spesifik outlet (staff / proses / potensi fraud). ` +
        `Health score ${Math.round(outlet.healthScore)}/100, area ${outlet.area}.`,
      affectedOutlets: [outlet.outletCode],
      recommendation:
        'Audit operasional outlet: cek pencatatan SPV, training staff, prosedur stock opname, ' +
        'dan transaksi adjustment. Bandingkan dengan peer outlet di area yang sama.',
    };
  });
}

/**
 * Detect AREA_LEVEL patterns — areas whose avg Dev/BOM exceeds 1.5× network avg.
 *
 * Recommendation: review area supervisor / logistics for affected areas.
 */
function detectAreaLevel(
  data: AnalysisData,
  networkAvgDevBom: number,
): PatternDetection[] {
  const areas = data.areaAnalysis ?? [];
  if (areas.length === 0 || networkAvgDevBom <= 0) return [];

  const flagged = areas
    .map((a) => {
      const areaAvg = Math.abs(a.avgDevBom);
      const factor = networkAvgDevBom > 0 ? areaAvg / networkAvgDevBom : 0;
      return { area: a, areaAvg, factor };
    })
    .filter((x) => x.factor > AREA_LEVEL_FACTOR)
    .sort((a, b) => b.factor - a.factor)
    .slice(0, AREA_LEVEL_TOP_N);

  if (flagged.length === 0) return [];

  return flagged.map(({ area, areaAvg, factor }) => {
    const severity = severityFromFactor(factor, AREA_LEVEL_CRITICAL_FACTOR);
    const networkPct = (networkAvgDevBom * 100).toFixed(1);
    const areaPct = (areaAvg * 100).toFixed(1);
    return {
      type: 'AREA_LEVEL' as const,
      severity,
      title: `Area bermasalah: ${area.area}`,
      description:
        `Area ${area.area} avg deviasi ${areaPct}% vs network ${networkPct}% ` +
        `(${factor.toFixed(2)}×) — masalah area-level (supervisor / logistik). ` +
        `${area.outletCount} outlet terdampak.`,
      affectedAreas: [area.area],
      recommendation:
        'Review kinerja supervisor area, jalur logistik, dan konsistensi penerapan SOP ' +
        `lintas ${area.outletCount} outlet di area ${area.area}.`,
    };
  });
}

/**
 * Detect NETWORK_WIDE pattern — when the whole network's avg Dev/BOM > 10%.
 */
function detectNetworkWide(
  networkAvgDevBom: number,
): PatternDetection[] {
  if (networkAvgDevBom <= NETWORK_WIDE_THRESHOLD) return [];

  const severity: 'CRITICAL' | 'WARNING' =
    networkAvgDevBom >= NETWORK_WIDE_CRITICAL ? 'CRITICAL' : 'WARNING';
  const pct = (networkAvgDevBom * 100).toFixed(1);

  return [
    {
      type: 'NETWORK_WIDE',
      severity,
      title: 'Deviasi network-wide tinggi',
      description:
        `Network-wide deviation ${pct}% ` +
        `(ambang ${NETWORK_WIDE_THRESHOLD * 100}%) — potensi masalah proses sistemik ` +
        `lintas seluruh outlet.`,
      recommendation:
        'Review menyeluruh: BOM master data, training program, dan proses pencatatan ' +
        'di seluruh outlet. Prioritaskan audit pada item-item dengan konsistensi SYSTEMIC.',
    },
  ];
}

/**
 * Compact formatter for nominal values — uses Indonesian abbreviations
 * (Jt / M) consistent with src/lib/format.ts fmtIDR, but without the
 * `Rp ` prefix (so descriptions stay readable in narrative form).
 */
function formatNominal(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}M`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}Jt`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}Rb`;
  return `${sign}${abs.toFixed(0)}`;
}

// ============================================================
//  Main entry point
// ============================================================

/**
 * Detect cross-outlet patterns from existing analysis artifacts.
 *
 * Runs all 4 detectors and returns a flat array of PatternDetection.
 * Order: NETWORK_WIDE first (most severe / highest leverage), then
 * SYSTEMIC_ITEM, ISOLATED_OUTLET, AREA_LEVEL.
 *
 * Returns an empty array when no patterns breach any threshold —
 * this is a valid result (the network is healthy).
 */
export function detectPatterns(data: AnalysisData): PatternDetection[] {
  if (!data || (Array.isArray(data) && data.length === 0)) return [];

  const totalOutlets = computeTotalOutlets(data);
  const networkAvgDevBom = computeNetworkAvgDevBom(data);

  const networkWide = detectNetworkWide(networkAvgDevBom);
  const systemicItems = detectSystemicItems(data, totalOutlets);
  const isolatedOutlets = detectIsolatedOutlets(data);
  const areaLevel = detectAreaLevel(data, networkAvgDevBom);

  // Order: most systemic → most localized
  return [...networkWide, ...systemicItems, ...isolatedOutlets, ...areaLevel];
}
