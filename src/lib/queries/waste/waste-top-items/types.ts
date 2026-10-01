// ============================================================
//  Waste Top Items — shared types (DEEP-WASTE-1)
//  --------------------------------------------------------
//  SPLIT-0-B: moved verbatim out of waste-top-items.ts. The two
//  raw-row interfaces (SQL round-trip shapes) were module-private
//  in the monolith — the `export` keyword on them below is the
//  ONLY code change in this split (sibling sharing between
//  ./query.ts and ./builders.ts — same precedent as toNum /
//  monthWindowBound in waste/shared.ts, GODSPLIT-W1-B); they are
//  deliberately NOT re-exported by ./index.ts, so the public
//  surface stays byte-compatible with the pre-split module.
// ============================================================

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
// W11 (Paritas Susut & Trial): semua tipe/perubahan di bawah blok W11
// bersifat ADDITIF — tidak ada nama/field pra-W11 yang berubah
// (lihat ./fingerprint.ts untuk kontrak + logika keputusan).

/**
 * W11: the parity metric the top-N is ORDERED by (and whose nominal the
 * rows lead with). 'waste' = the pre-W11 behavior, byte-identical.
 */
export type WasteMetric = 'waste' | 'susut' | 'trial';

export interface WasteItemRawRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number | bigint;
  wasteQty: number | bigint;
  outletsActive: number | bigint;
  monthsActive: number | bigint;
  lastMonthWaste: number | bigint;
  prevMonthWaste: number | bigint;
  populationTotal: number | bigint;
  // ---- W11 (Paritas Susut & Trial) — same-scan aggregates, ADDITIVE ----
  /** Σ|nominalSusut| per item over the window (the parity companion of totalWaste). */
  totalSusut: number | bigint;
  /** Σ|qtySusut| per item over the window. */
  susutQty: number | bigint;
  /** Σ|nominalTrial| per item over the window. */
  totalTrial: number | bigint;
  /** Σ|qtyTrial| per item over the window. */
  trialQty: number | bigint;
  /**
   * Σ|qtyBom| per item over the window — the theoretical-usage basis for
   * the trial-screen ratio (trialQty / bomQty). NOT needed pre-W11: the
   * BOM usage basis used to live only in the W3 distribution round's
   * hasBom flag, which is too coarse for a ratio.
   */
  bomQty: number | bigint;
  /** Distinct months with trial > 0 (FIX 1 discipline: FILTER on the metric, never record presence). */
  trialMonthsActive: number | bigint;
  /** Σ|nominalSusut| across ALL items in scope (window total — the susut share denominator). */
  susutPopulationTotal: number | bigint;
  /** Σ|nominalTrial| across ALL items in scope (window total — the trial share denominator). */
  trialPopulationTotal: number | bigint;
}

export interface WasteItemOutletRawRow {
  itemId: number;
  outletCode: string;
  outletName: string;
  area: string;
  waste: number | bigint;
  monthsActive: number | bigint;
  // ---- W11 (additive): per-outlet susut/trial companions of `waste` so
  // the breakdown row can follow the ACTIVE metric (same scan, same
  // GROUP BY — two more SUM expressions, no extra round trip). ----
  susut: number | bigint;
  trial: number | bigint;
}

/**
 * W3 quadrant round-trip shape: the FULL per-(item, outlet) distribution
 * (GROUP BY outlet, NO cap — unlike the top-8 breakdown slice) plus the
 * BOM>0 flag that anchors the prevalence denominator. `hasBom` is a 0/1
 * MAX flag over the outlet's window rows: 1 = the outlet prepped/used the
 * item (ABS(qtyBom) > 0) somewhere in the window.
 */
export interface WasteItemOutletDistributionRawRow {
  itemId: number;
  outletId: number;
  waste: number | bigint;
  hasBom: number | bigint;
}

export interface WasteItemOutletBreakdown {
  outletCode: string;
  outletName: string;
  area: string;
  waste: number;
  monthsActive: number;
  /** waste / item's totalWaste (0 when totalWaste is 0). */
  shareOfItem: number;
  /** W11 (additive): Σ|nominalSusut| of this outlet on the item (parity companion of `waste`). */
  susut: number;
  /** W11 (additive): Σ|nominalTrial| of this outlet on the item. */
  trial: number;
}

export interface WasteTopItemRow {
  itemId: number;
  itemName: string;
  satuan: string | null;
  totalWaste: number;
  wasteQty: number;
  /** #outlet aktif in the window. */
  outletsActive: number;
  /** #bulan aktif in the window. */
  monthsActive: number;
  /** share of the network total waste (0 when population is 0). */
  share: number;
  /** cumulative share from rank 1 (0 when population is 0). */
  cumulativeShare: number;
  /** Waste in the latest window month (0 when the item had none). */
  lastMonthWaste: number;
  /** Waste in the month before the latest (0 when absent). */
  prevMonthWaste: number;
  /** Sistematik = active in ≥ half the window months AND ≥ 2 outlets. */
  sistematik: boolean;
  byOutlet: WasteItemOutletBreakdown[];
  /**
   * W3 (additive): prevalence × persistence quadrant fields — null when the
   * quadrant round-trip wasn't run (e.g. the pure buildWasteTopItems path
   * without a distribution, or an empty window); filled by queryWasteTopItems
   * via buildQuadrant. Never removes/renames pre-W3 fields.
   */
  quadrant: WasteItemQuadrant | null;
  // ---- W11 (Paritas Susut & Trial) — ADDITIVE per-item fields. The
  // aggregate columns ride the SAME round-1 scan; the share fields are
  // computed by buildWasteTopItems (mechanical, like share/cumulativeShare);
  // the fingerprint block is filled by queryWasteTopItems via
  // ./fingerprint.ts (null default on the pure path). ----
  /** Σ|nominalSusut| over the window (parity companion of totalWaste). */
  susutNominal: number;
  /** Σ|qtySusut| over the window. */
  susutQty: number;
  /** Σ|nominalTrial| over the window. */
  trialNominal: number;
  /** Σ|qtyTrial| over the window. */
  trialQty: number;
  /** Σ|qtyBom| over the window — trial-screen ratio denominator. */
  bomQty: number;
  /** Distinct months with trial > 0 (trial persistence for the screen). */
  trialMonthsActive: number;
  /** susutNominal / susutPopulationTotal (0 when the population is 0). */
  susutShare: number;
  /** trialNominal / trialPopulationTotal (0 when the population is 0). */
  trialShare: number;
  /** Running Σ susutShare in the INPUT order — meaningful when the query
   *  ordered by susut (metric='susut'); the query edge guarantees that. */
  susutCumulativeShare: number;
  /** Running Σ trialShare in the INPUT order — meaningful under metric='trial'. */
  trialCumulativeShare: number;
  /** W11 fingerprint (W/S/T shares of explained loss + class) — null on the
   *  pure path / empty explained; filled by queryWasteTopItems. */
  fingerprint: WasteItemFingerprint | null;
}

export interface WasteTopItemsResult {
  items: WasteTopItemRow[];
  /** ΣABS nominalWaste across ALL items in scope (the 100% of the Pareto). */
  populationTotal: number;
  /** Latest + previous monthKeys of the window (for the trend column). */
  lastMonthKey: string | null;
  prevMonthKey: string | null;
  /** ACTUAL number of months in the window (≤ cap; e.g. 8-9 live) — the
   *  sistematik threshold is ceil(windowMonths / 2), NOT the 12-month cap
   *  (BUGHUNT-R1 FIX 2). Additive field. */
  windowMonths: number;
  /**
   * W3 (additive): network-level quadrant summary — adaptive persistence
   * threshold, paretoK, class distribution. Null on the same conditions as
   * the per-item field (no window / no items / distribution not run).
   */
  quadrant: WasteQuadrantSummary | null;
  // ---- W11 (additive) — see ./fingerprint.ts for the contracts. ----
  /** The metric the top-N was ordered by (echo of the query param; 'waste' default). */
  metric: WasteMetric;
  /** Σ|nominalSusut| across ALL items in scope (parity context vs populationTotal). */
  susutPopulationTotal: number;
  /** Σ|nominalTrial| across ALL items in scope. */
  trialPopulationTotal: number;
  /** Network-level fingerprint summary — null on empty windows/slices. */
  fingerprint: WasteFingerprintSummary | null;
  /** Trial-abuse screen rows over the RETURNED items (empty when none qualify). */
  trialScreen: WasteTrialScreenItem[];
}

// ------------------------------------------------------------
// W3 — Kuadran Sistemik vs Insiden (prevalence × persistence)
// ------------------------------------------------------------

/**
 * The four quadrants of the prevalence × persistence plane:
 *   - SISTEMIK     — widespread (prevalence ≥ PREVALENCE_MIN) AND persistent
 *                    (monthsActive ≥ ceil(windowMonths/2)): recipe/process
 *                    problem across outlets and months (action framing:
 *                    candidate for resep/proses-level fix, not outlet chase).
 *   - MUSIMAN      — widespread but not persistent: many outlets waste the
 *                    item only in some months (seasonal/supply-wave flavor).
 *   - LOKAL-KRONIS — few outlets but persistent: a handful of outlets with a
 *                    chronic problem on one item (outlet-level SOP chase).
 *   - INSIDEN      — neither: localized one-off incidents.
 */
export type WasteQuadrantClass = 'SISTEMIK' | 'MUSIMAN' | 'LOKAL-KRONIS' | 'INSIDEN';

/** Per-item W3 quadrant fields (see buildQuadrant in ./quadrant.ts). */
export interface WasteItemQuadrant {
  quadrantClass: WasteQuadrantClass;
  /**
   * FIX (AUDIT-B M1): outletsActiveWithBom / outletsWithBom — BOTH sides
   * on the BOM>0 usage basis (BUGHUNT-R1 FIX 1 family): the numerator
   * counts only outlets that USED the item (ABS(qtyBom) > 0) AND weighed
   * waste (waste > 0); the denominator counts only outlets that used it.
   * The pre-fix numerator (the item aggregate's outletsActive — any
   * waste>0 row) was not a subset of the denominator, so orphan-waste
   * outlets pushed the ratio above 1 (live: 11/6, 10/7). Semantics: "of
   * the outlets that use the item, how many weigh waste on it" — always
   * ≤ 1. Null when the item has NO BOM>0 outlet in scope (orphaned waste
   * — no usage basis); classification then treats prevalence as LOW
   * (conservative: no basis to claim "widespread").
   */
  prevalence: number | null;
  /** #outlets in scope with BOM>0 for the item (the denominator above). */
  outletsWithBom: number;
  /**
   * FIX (AUDIT-B M1, additive): #outlets with BOM>0 AND waste>0 (the
   * prevalence numerator above) — exposed so the UI shows the coherent
   * "X/Y outlet" pair; the item-level outletsActive (any waste>0 row)
   * overcounts it by the orphan-waste outlets (waste without BOM).
   */
  outletsActiveWithBom: number;
  /** monthsActive / windowMonths (0 when windowMonths is 0 — pure guard). */
  persistence: number;
  /**
   * HHI = Σ(share²) over the item's per-outlet waste shares (full
   * distribution, waste>0 outlets only — zero-waste outlets contribute
   * share 0). Null when the item has < WASTE_QUADRANT_HHI_MIN_OUTLETS
   * active outlets (guard) or no positive waste to distribute.
   */
  hhi: number | null;
}

/** Network-level W3 summary (top-level `quadrant` block of the response). */
export interface WasteQuadrantSummary {
  /** Persistence threshold in MONTHS — ceil(windowMonths/2), adaptive to the
   *  REAL window (BUGHUNT-R1 FIX 2 pattern; e.g. 9-month window → 5, not the
   *  12-cap's 6). monthsActive ≥ this = "persistent". */
  persistenceThresholdMonths: number;
  /**
   * #items needed to reach WASTE_QUADRANT_PARETO_SHARE (80%) cumulative
   * network waste share — the "how concentrated is the network's waste"
   * number. FIX (AUDIT-B M4): re-derived over a waste-share-DESC sort of
   * the returned rows, so the number is the WASTE rank regardless of the
   * metric that ordered the top-N slice (the input-order scan was only
   * valid under metric='waste'). Null when the returned top-N slice never
   * reaches the target (possible with a tight limit on a long tail).
   */
  paretoK: number | null;
  /** Class distribution over the returned items (all four keys always set). */
  classCounts: Record<WasteQuadrantClass, number>;
  /** Window months the classification ran on (echoes windowMonths). */
  windowMonths: number;
}

// ------------------------------------------------------------
// W11 — Paritas Susut & Trial: fingerprint W/S/T (additive)
// ------------------------------------------------------------

/**
 * W11: the dominant component of an item's EXPLAINED loss (w+s+t):
 *   - W-DOMINANT — loss yang dijelaskan W/S/T terutama WASTE (prep/handling flavor);
 *   - S-DOMINANT — primarily SUSUT (penyimpanan/cold-chain flavor);
 *   - T-DOMINANT — primarily TRIAL (R&D-vs-keran-pembuangan question —
 *     always presented as INDIKASI: the trial SEMANTICS are unverified).
 * Classification = simple max-share over (shareW, shareS, shareT) with a
 * deterministic W > S > T tie-break (see ./fingerprint.ts). Null when
 * explained == 0 (TANPA EXPLAINED — no decomposition to dominate).
 */
export type WasteFingerprintClass = 'W-DOMINANT' | 'S-DOMINANT' | 'T-DOMINANT';

/** W11: per-item fingerprint fields (see buildFingerprint in ./fingerprint.ts). */
export interface WasteItemFingerprint {
  /** Σ|nominalWaste| / explained (0 when explained is 0). */
  shareW: number;
  /** Σ|nominalSusut| / explained (0 when explained is 0). */
  shareS: number;
  /** Σ|nominalTrial| / explained (0 when explained is 0). */
  shareT: number;
  /** Σ|nominalWaste| + Σ|nominalSusut| + Σ|nominalTrial| (the W+S+T explained loss). */
  explainedNominal: number;
  /** Max-share class; null when explainedNominal is 0 (TANPA EXPLAINED). */
  fingerprintClass: WasteFingerprintClass | null;
}

/** W11: network-level fingerprint summary (top-level `fingerprint` block). */
export interface WasteFingerprintSummary {
  /** Class distribution over the returned items (all four keys always set). */
  classCounts: {
    wDominant: number;
    sDominant: number;
    tDominant: number;
    /** Items with explained == 0 (no W/S/T decomposition at all). */
    tanpaExplained: number;
  };
  /**
   * Epistemic label (house convention): the class is a PATTERN reading of
   * measured shares — indication for action framing, never a root cause;
   * T-DOMINANT additionally carries the unverified-trial-semantics caveat.
   */
  epistemicLabel: 'INDIKASI';
}

/**
 * W11: one trial-abuse screen row. All three signals must hold (see
 * ./fingerprint.ts for the thresholds + the not-derivable substitution
 * signal note). Always INDIKASI.
 */
export interface WasteTrialScreenItem {
  itemId: number;
  itemName: string;
  satuan: string | null;
  /** Σ|nominalTrial| over the window (the "high-value" signal). */
  trialNominal: number;
  /** Σ|qtyTrial| over the window. */
  trialQty: number;
  /** Σ|qtyBom| over the window (the usage basis). */
  bomQty: number;
  /** trialQty / bomQty; null when bomQty = 0 (no usage basis — not screened). */
  trialToBom: number | null;
  /** Distinct months with trial > 0 (the persistence signal). */
  trialMonthsActive: number;
  /**
   * FIX (AUDIT-B M2, additive): which signal-1 tier fired —
   *   - 'BLATAN'  : the absolute bar (trialToBom ≥
   *     WASTE_TRIAL_SCREEN_BOM_RATIO — ≥ 5% of theoretical usage booked as
   *     trial, far beyond R&D sampling);
   *   - 'OUTLIER' : the robust tier (trialToBom ≥ median + 3 × 1.4826 × MAD
   *     of the BOM-basis item population on this slice — unusually high
   *     vs the population even when far below the absolute bar).
   * BLATAN takes precedence when both hold. The two-tier calibration is
   * what makes the screen triggerable on live data (the absolute 5% bar
   * alone sat 10× above the live maximum ratio).
   */
  ratioSignal: 'BLATAN' | 'OUTLIER';
  /**
   * FIX (AUDIT-B M2, additive): the signal-1 threshold the item passed —
   * WASTE_TRIAL_SCREEN_BOM_RATIO for BLATAN rows, the computed robust
   * outlier threshold for OUTLIER rows. Null is unreachable on screened
   * rows but kept nullable for the UI mirror's stale-cache guard.
   */
  ratioThreshold: number | null;
  /** The item's fingerprint class at screen time (context; null when explained 0). */
  fingerprintClass: WasteFingerprintClass | null;
  /** Screen verdict — statistical indication, not proof. */
  epistemicLabel: 'INDIKASI';
}
