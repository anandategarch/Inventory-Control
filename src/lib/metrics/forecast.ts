// ============================================================
//  FORECAST METRICS — Trend Projection (Linear Regression)
//  --------------------------------------------------------
//  Projects the next period's deviation magnitude based on the
//  historical weekly trend. Uses simple OLS linear regression
//  on ABS(nominalDeviasi) per week + computes R² for confidence.
//
//  Sign convention (per master context):
//    - LOSS = negative nominalDeviasi
//    - We model MAGNITUDE (|nominalDeviasi|), so a positive slope
//      always means "deviation is growing" (worse), regardless of
//      whether the underlying deviation is LOSS or SURPLUS.
//    - DETERIORATING  → magnitude growing (slope > +0.1)
//      IMPROVING     → magnitude shrinking (slope < -0.1)
//      STABLE        → |slope| <= 0.1
//
//  Algorithm:
//    1. OLS linear regression: y = a + b*x
//       x = week index (0,1,2,…,n-1)
//       y = ABS(nominalDeviasi) for that week
//       b = (n*Σxy − Σx*Σy) / (n*Σx² − (Σx)²)
//       a = (Σy − b*Σx) / n
//    2. Project next period: y_next = a + b*n
//    3. Confidence from sample size + coefficient of determination (R²):
//       HIGH   if n >= 4 AND R² > 0.7
//       MEDIUM if n >= 3 AND R² > 0.4
//       LOW    otherwise
//    4. Trend direction from slope sign vs ±0.1 threshold.
//    5. Warning when projected magnitude > 1.2 × current magnitude.
//
//  Returns null when:
//    - input has fewer than 2 data points (cannot fit a line)
//    - denominator (n*Σx² − (Σx)²) is 0 (degenerate — all x equal)
// ============================================================

/**
 * Input shape for projectTrend — one row per historical week.
 */
export interface WeeklyTrendInput {
  weekLabel: string;
  /** Signed nominal deviation for the week (LOSS = negative). */
  nominalDeviasi: number;
  /** Aggregate Dev/BOM ratio for the week (signed; |.| used for projection). */
  devBom: number;
  /** Total sales for the week (used for context, not regression). */
  sales: number;
}

/**
 * Output of projectTrend — next-period forecast + diagnostics.
 */
export interface TrendProjection {
  /** Human-readable label for the projected period. */
  weekLabel: string;
  /** Forecast |nominalDeviasi| for the next period (always non-negative). */
  projectedNominalDeviasi: number;
  /** Forecast |devBom| for the next period (always non-negative). */
  projectedDevBom: number;
  /** Confidence band based on R² + sample size. */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Direction the deviation magnitude is moving. */
  trendDirection: 'IMPROVING' | 'DETERIORATING' | 'STABLE';
  /**
   * Trend strength (0-1) — |slope| normalized against the mean of |y|.
   * 0 = no trend, 1 = slope magnitude equals the historical mean.
   * Clamped to [0, 1] for stable display.
   */
  trendStrength: number;
  /** Optional human-readable warning when projection is materially worse. */
  warning?: string;
  /** Coefficient of determination R² (0-1) — explanatory power of the model. */
  rSquared: number;
  /** Number of weekly observations used to fit the regression. */
  sampleSize: number;
  /** Slope (b) of the regression line on |nominalDeviasi|. */
  slope: number;
  /** Intercept (a) of the regression line on |nominalDeviasi|. */
  intercept: number;
  /** Current period |nominalDeviasi| (last observation) — used for the 1.2× guard. */
  currentNominalDeviasi: number;
}

/** Minimum number of weekly observations required to attempt a regression. */
const MIN_DATA_POINTS = 2;

/** Slope thresholds for direction classification (in absolute-deviation units). */
const SLOPE_THRESHOLD = 0.1;

/** Projected magnitude vs current magnitude ratio above which we warn. */
const WARNING_RATIO = 1.2;

/**
 * Fit a simple OLS linear regression y = a + b*x.
 *
 * Returns { slope, intercept, rSquared } or null when degenerate
 * (fewer than 2 points, or all x equal → divide-by-zero).
 *
 * Pure helper — no domain logic, so it can be reused for devBom too.
 */
function fitLinearRegression(
  points: Array<{ x: number; y: number }>,
): { slope: number; intercept: number; rSquared: number } | null {
  const n = points.length;
  if (n < MIN_DATA_POINTS) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }

  const denom = n * sumX2 - sumX * sumX;
  // Degenerate case: all x are the same (e.g., duplicate week indices).
  // Cannot fit a unique line.
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // Coefficient of determination R²:
  //   R² = (n·Σxy − Σx·Σy)² / ((n·Σx² − (Σx)²) · (n·Σy² − (Σy)²))
  const yDenom = n * sumY2 - sumY * sumY;
  // If yDenom === 0, all y are identical → perfect flat line, R² undefined.
  // Treat as R² = 1 (the model perfectly predicts the constant).
  const rSquared = yDenom === 0 ? 1 : ((n * sumXY - sumX * sumY) ** 2) / (denom * yDenom);

  return { slope, intercept, rSquared: clamp01(rSquared) };
}

function clamp01(v: number): number {
  if (!isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Classify confidence based on sample size + R².
 */
function classifyConfidence(n: number, rSquared: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (n >= 4 && rSquared > 0.7) return 'HIGH';
  if (n >= 3 && rSquared > 0.4) return 'MEDIUM';
  return 'LOW';
}

/**
 * Classify trend direction from slope sign.
 *
 * Slope is in units of |nominalDeviasi| per week — it is NOT a ratio,
 * so the ±0.1 threshold is a small-magnitude heuristic. For very large
 * nominal scales (e.g., Rp billions), even a tiny slope is meaningful,
 * but trendStrength (normalized) carries the magnitude information.
 */
function classifyTrendDirection(slope: number): 'IMPROVING' | 'DETERIORATING' | 'STABLE' {
  if (slope > SLOPE_THRESHOLD) return 'DETERIORATING';
  if (slope < -SLOPE_THRESHOLD) return 'IMPROVING';
  return 'STABLE';
}

/**
 * Build a human-readable warning when the projection is materially worse
 * than the current period.
 *
 * "Worse" = projected magnitude > 1.2 × current magnitude.
 * Uses ABS values throughout (LOSS or SURPLUS both count as "deviation").
 */
function buildWarning(
  projected: number,
  current: number,
  trendDirection: 'IMPROVING' | 'DETERIORATING' | 'STABLE',
): string | undefined {
  if (current <= 0) return undefined;
  const ratio = projected / current;
  // Only warn when the trend is worsening AND the projection exceeds 1.2× current.
  if (trendDirection === 'DETERIORATING' && ratio > WARNING_RATIO) {
    const pctWorse = Math.round((ratio - 1) * 100);
    return `Jika tren berlanjut, deviasi bisa mencapai ${pctWorse}% lebih besar dari periode ini.`;
  }
  return undefined;
}

/**
 * Project the next-period deviation magnitude from historical weekly data.
 *
 * @param weeklyData  Array of weekly aggregates (chronological order assumed).
 *                    Each entry must have a `weekLabel`, `nominalDeviasi`,
 *                    `devBom`, and `sales` field. The function takes ABS()
 *                    internally, so callers may pass signed values.
 * @returns TrendProjection for the next period, or null when there is
 *          insufficient data (fewer than 2 weeks or degenerate x).
 *
 * Master context: Forecast = linear projection of |nominalDeviasi| trend.
 */
export function projectTrend(
  weeklyData: Array<WeeklyTrendInput>,
): TrendProjection | null {
  // Filter to valid rows (ignore nulls / NaN).
  const clean = weeklyData.filter(
    (w) =>
      w != null &&
      typeof w.nominalDeviasi === 'number' &&
      isFinite(w.nominalDeviasi) &&
      typeof w.devBom === 'number' &&
      isFinite(w.devBom),
  );

  const n = clean.length;
  if (n < MIN_DATA_POINTS) return null;

  // x = 0,1,2,…,n-1 ; y = ABS(nominalDeviasi)
  const nominalPoints = clean.map((w, i) => ({
    x: i,
    y: Math.abs(w.nominalDeviasi),
  }));

  // Fit regression on |nominalDeviasi|
  const nominalFit = fitLinearRegression(nominalPoints);
  if (!nominalFit) return null;

  // Fit regression on |devBom| (independent model — used only for projection)
  const devBomPoints = clean.map((w, i) => ({
    x: i,
    y: Math.abs(w.devBom),
  }));
  const devBomFit = fitLinearRegression(devBomPoints);

  // Project next period: x = n (one step beyond the last observed index)
  const projectedNominal = Math.max(0, nominalFit.intercept + nominalFit.slope * n);
  const projectedDevBom = devBomFit
    ? Math.max(0, devBomFit.intercept + devBomFit.slope * n)
    : Math.abs(clean[n - 1].devBom);

  // Current period = last observation
  const currentNominalDeviasi = Math.abs(clean[n - 1].nominalDeviasi);

  // Trend direction from slope sign
  const trendDirection = classifyTrendDirection(nominalFit.slope);

  // Trend strength = |slope| normalized against the mean of |y|.
  // 0 = no movement, 1 = slope magnitude equals the historical mean.
  const meanAbsNominal = nominalPoints.reduce((s, p) => s + p.y, 0) / n;
  const trendStrength = clamp01(
    meanAbsNominal > 0 ? Math.abs(nominalFit.slope) / meanAbsNominal : 0,
  );

  // Confidence
  const confidence = classifyConfidence(n, nominalFit.rSquared);

  // Warning
  const warning = buildWarning(projectedNominal, currentNominalDeviasi, trendDirection);

  // Label for the projected period — preserve the last week's label and
  // annotate "(projection)" so the UI can render it distinct from observed weeks.
  const lastLabel = clean[n - 1].weekLabel || `W${n}`;
  const projectedLabel = `${lastLabel} → next (projection)`;

  return {
    weekLabel: projectedLabel,
    projectedNominalDeviasi: projectedNominal,
    projectedDevBom,
    confidence,
    trendDirection,
    trendStrength,
    warning,
    rSquared: nominalFit.rSquared,
    sampleSize: n,
    slope: nominalFit.slope,
    intercept: nominalFit.intercept,
    currentNominalDeviasi,
  };
}
