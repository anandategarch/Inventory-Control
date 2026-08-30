# Product Requirements Document (Retroactive)

> **Product Requirements Document (Retroactive)** — Describes what this app does.
> Read when adding features.

This document is written retroactively: the product has been live for several iterations
(AUDIT-1 → AUDIT-4, FIX-HIGH, FIX-MEDIUM, Phase A & B shipped). This PRD captures the
**as-built** behaviour from a user's point of view so future contributors can decide
whether a new feature fits the product, conflicts with an existing one, or belongs on
the roadmap.

> **Scope note.** This is a *product* document (what & why), not an *engineering*
> document (how). For architecture, schema, API surface and rule DSL, read
> `MASTER_CONTEXT.md`. For implementation history, read `worklog.md`.

---

## 1. Product Overview

| Attribute | Value |
|-----------|-------|
| **Name** | Inventory Control Intelligence Platform |
| **Tagline** | Deviation analytics for F&B chain inventory — BOM vs COM reconciliation. |
| **Purpose** | Detect, investigate and report stock deviations between the system-of-record (SOC / BOM) and physical reality (COM / Stock Opname) for a multi-outlet F&B chain. |
| **Primary users** | Inventory analysts at F&B chains (Indonesian market, currently single-user). |
| **Domain** | F&B operations / Inventory control / Loss prevention. |
| **Data cadence** | Weekly stock opname (SO) per outlet, rolled up monthly for reporting. |
| **Deployment** | Web app (responsive, desktop-first). No mobile app. |
| **Current state** | Production, single-tenant, manual Excel import. NextAuth wired but not exposed. |

### 1.1 Problem being solved

Every week each outlet submits a stock opname. The back-office produces an Excel sheet
comparing:

- **QTY BOM** — Bill of Materials: how much should have been used, per recipe.
- **QTY COM** — Cost of Materials: how much was actually used.
- **QTY Deviasi** — Deviation = COM − BOM.
- **QTY Waste / Susut / Trial** — explained losses (controlled waste, shrinkage, trials).
- **QTY Loss/Surplus** — residual deviation = Deviasi − Waste − Susut − Trial.

Without tooling, the analyst manually pivots 50K+ rows per month in Excel, eyeballs
outliers, and writes a Word report by hand. This platform automates the detection,
drill-down and reporting loop.

### 1.2 Data scale (typical working set)

- **54,000+** inventory records per analysis period.
- **333 outlets** across **14 areas** (Banten, Jakarta, Jawa Barat 1/2, Jawa Tengah 1/2,
  Jawa Timur 1/2, Kalimantan 1/2, Papua & Maluku, Sulawesi 1/2, WCR).
- **109 items** (raw materials / SKUs).
- **3–4 weeks** per month (some months ship 4 SOs, most ship 3).
- ~20 PICs (Persons In Charge) assigned to outlets.

> Numbers above reflect the analyst's working subset per period. Cumulative DB state
> (8 months retained) is larger; see `MASTER_CONTEXT.md` §4.

---

## 2. User Personas

### 2.1 Primary — Inventory Analyst ("Rizka")

- **Role**: Inventory Control Analyst at HQ.
- **Goal**: Monitor weekly deviations, investigate anomalies, export monthly reports.
- **Day**: Opens the dashboard first thing Monday morning, scans the anomaly summary,
  drills into the worst outlets, exports a Word memo for the Ops Manager.
- **Pain points the app addresses**:
  - Cannot see "which outlet is worst" at a glance in Excel → Top Outlets + Priority Summary.
  - Hard to compare this week vs last week → Multi-Period Comparison + Growth Drivers.
  - Anomalies are subtle (not just "big number") → 19-rule engine + signed Z-Score (Dev/BOM + QTY Deviasi).
- **Success metric**: Time-to-insight per anomaly < 5 min.

### 2.2 Secondary — Operations Manager ("Bu Sari")

- **Role**: Reviews monthly reports, sets tolerance thresholds per item category.
- **Goal**: Decide which outlets need an ops visit; calibrate thresholds quarterly.
- **Day**: Reads the Word report end-of-month, opens the dashboard to verify a finding,
  occasionally tunes thresholds via the Settings dialog.
- **Pain points the app addresses**:
  - Narrative report was written by hand → auto-generated Word export with section toggles.
  - Tolerance tuning required a developer → Settings UI with runtime thresholds.
- **Success metric**: Report turnaround < 1 day (was 3–5 days pre-platform).

### 2.3 Tertiary — Outlet Manager ("Pak Budi") — *future*

- **Role**: Runs a single outlet, wants to see how their outlet performs vs peers.
- **Goal**: Self-serve check on their own outlet before HQ asks.
- **Status**: Not yet supported (no per-user auth, no RBAC). Will arrive in Phase C.
- **Success metric** (target): Outlet Manager logs in weekly without HQ nudge.

---

## 3. User Journeys

### 3.1 Daily monitoring

```
Open dashboard (Tab 1)
  → Executive Summary KPI cards (Sales, BOM, Deviasi, Dev/BOM %)
  → Health Status bar (Normal / Warning / Abnormal counts)
  → Anomalies panel (top 19-rule violations this period)
  → Click anomaly row
  → DrillDownDrawer opens (right sheet, raw records capped at 100)
  → "View all source records" → SourceDataModal (full-screen, CSV export)
  → Identify root cause → close drawer → next anomaly
  → Scroll to Heatmap Area × Item → scan color-coded grid (default Pareto 80%
     mode auto-selects items contributing 80% of total magnitude; each cell
     shows Total magnitude + Ø avg per resto for nominal metrics)
  → Click a heatmap cell → AreaItemHeatmapSheet opens (right sheet) with
     per-outlet drill-down (qtyBom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial,
     nominalLossSurplus, Dev/BOM%) — footer shows TOTAL + Ø PER RESTO rows
  → Close sheet → next heatmap cell of interest
```

**Exit criteria**: Analyst has triaged all P1 anomalies and noted follow-ups.

### 3.2 Monthly reporting

```
Select month + week in FilterBar
  → Optionally compare vs previous month (compareWeek parameter)
  → Verify KPIs reflect the right period
  → Click "Export Laporan"
  → ExportDialog opens:
      ☐ Executive Summary
      ☐ Top Items
      ☐ Top Outlets
      ☐ Priority Summary
      ☐ Insights
      ☐ Recommendations
  → Toggle sections as needed
  → Click "Generate Word"
  → .docx downloads (~30–60 s for full report)
  → Share .docx with management
```

**Exit criteria**: Word report delivered to Ops Manager within 1 working day.

### 3.3 Data upload

```
Get Excel from back-office (.xlsx, multi-sheet: Week 1 / Week 2 / Week 4)
  → Click "Upload File" in FilterBar
  → Drag-drop the .xlsx (or paste a Google Drive URL)
  → Ingestion runs (parser, dedup, direction computation, residual calc)
  → On success: success toast, dashboard auto-refreshes
  → On error: DQIssue list shown (e.g. "outlet BAKSO is not a region", "month mixed-case")
  → Resolve DQ issues in source Excel → re-upload
```

**Exit criteria**: New month visible in dropdown, KPIs updated.

### 3.4 Anomaly investigation

```
See red badge in Top Outlets or Priority Summary (P1 outlet)
  → Click outlet name
  → Resto Analysis tab opens with outlet profile:
      - Performance (Sales / BOM / Deviasi / Dev/BOM)
      - Behavior (Waste / Susut / Trial / Residual composition)
      - Historical (current vs previous, trend DETERIORATING / IMPROVING / STABLE)
      - Benchmark (outlet vs area vs network — ABOVE_AREA / ABOVE_NETWORK / NORMAL)
      - Top Risk (top 5 items per category)
      - Investigation (normal / warning / abnormal count + health score)
  → Switch to Bahan Analysis sub-tab
  → Sort by "Unexplained" (Residual Ratio) — biggest red flags
  → Click item → ItemDeepDive modal:
      - Direction distribution (LOSS vs SURPLUS pie)
      - Top 5 outlets for this item
      - Multi-period trend
      - Total Kemunculan (count of appearances)
  → (Optional) Switch back to Dashboard tab → scroll to "Analisis Historis"
      → BomCorrelationCard shows a per-record findings table (Outlet × Item × Rule ×
         Growth × Ratio) with per-rule count badges. Each row is one (outlet, item,
         adjustment) tuple flagged by one of the 6 BOM-category rules. Use the table
         to spot the worst offenders at a glance; the aggregate alignment table
         below it shows whether Deviasi/Waste/Susut/Trial grew in the same
         direction as BOM.
  → Identify root cause (e.g. "MINYAK MIE residual 80% + Waste naik saat BOM turun
     → likely fraud or wrong SO")
  → Note in Word report
```

**Exit criteria**: Root cause documented; outlet flagged for ops visit if P1.

### 3.5 Settings tuning

```
Open Pengaturan dialog (gear icon)
  → Tabs: Thresholds, Weights, Display
  → Adjust e.g. RESIDUAL_LOSS_HIGH_PCT (0.50 → 0.60) — "loosen critical threshold"
  → Adjust BOM_DISPROPORTIONATE_FACTOR (1.5 → 1.2) — "tighten disproportionate rule:
     catch Deviasi growing only 1.2× faster than BOM, not 1.5×"
  → Adjust WEIGHT_HISTORY (10 → 15) — "give historical zScore more priority weight"
  → Click "Simpan"
  → Settings persist to DB (Setting table, 43 rows)
  → Dashboard refetches with new thresholds
  → Verify P1/P2/P3 distribution changed as expected
  → Iterate or revert
```

**Exit criteria**: Thresholds reflect new business reality without code deploy.

---

## 4. Feature Inventory (existing)

### 4.1 Analytics

| Feature | Tab / Surface | Purpose |
|---------|---------------|---------|
| Executive Summary | Dashboard | KPI cards: Sales, BOM, Deviasi, Dev/BOM % with growth % vs previous period |
| Health Status | Dashboard | Normal / Warning / Abnormal counts + rule-breakdown bar |
| Growth Comparison | Dashboard | 4 metrics (Sales / BOM / QTY Deviasi / Nominal Deviasi) + 80% Pareto drill-down per metric |
| Deviation Breakdown | Dashboard | Waste / Susut / Trial / Residual bar chart + Pareto drill-down per category |
| Loss vs Surplus | Dashboard | Record count + nominal split (LOSS red, SURPLUS green) |
| Top Items | Dashboard | 10 clickable cards → ItemDeepDive modal |
| Top Outlets | Dashboard | By nominal / by sales / by loss / by surplus (signed display, abs sort) |
| Priority Summary | Dashboard | P1 / P2 / P3 outlets + recommendations (card-only display — no drilldown) |
| Insights Panel | Dashboard | Auto-generated executive insights (rule-based, no LLM) |
| Multi-Period Comparison | Dashboard | 8-week trend table |
| Advanced Analysis | Dashboard | Variance analysis (top worsened / improved) + Historical Z-Score analysis (SIGNED: positive=worse/red, negative=better/green; 2-metric selector: Dev/BOM + QTY Deviasi) |
| BOM Correlation | Dashboard | Per-record findings table (Outlet × Item × Rule × Growth × Ratio) + per-rule count badges + aggregate Deviasi/Waste/Susut/Trial vs BOM alignment table + narrative findings (`BomCorrelationCard`) |
| Heatmap Area × Item | Dashboard | Color-coded Area × Item grid (`AreaItemHeatmap`) with 5 metric selectors (Deviasi / Waste / Susut / Dev/BOM % / Record Count). Default mode **Pareto 80%** — auto-selects items contributing to 80% of total magnitude (banner shows "Menampilkan X dari Y item · Kontribusi: Z%"). Each cell displays **Total magnitude (bold) + Ø avg per resto (muted)** for nominal metrics (Deviasi/Waste/Susut). Cell tooltip shows Total + Avg + Outlet Count + Record Count. Click any cell → `AreaItemHeatmapSheet` (right-side Sheet, lazy-loaded via `next/dynamic`) with per-outlet drill-down: qtyBom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial, nominalLossSurplus, Dev/BOM%. Sheet footer: TOTAL row + Ø PER RESTO row. API: `/api/area-item-heatmap` + `/api/area-item-heatmap/cell-detail`. |
| Resto Profile | Resto Analysis | 6-section outlet profile (Performance / Behavior / Historical / Benchmark / Top Risk / Investigation) |
| Bahan Analysis | Resto Analysis | 3 ranking tabs: Financial Impact / Operational / Unexplained |
| Menu Analysis | Resto Analysis | Group by first 2 words of item name; outlier detection (avg + 2σ) |
| Ranking Item Nasional | Resto Analysis | Top 50 item-outlet pairs by deviation rank |
| Peer Comparison Scatter | Peer Comparison | Sales vs Dev/BOM; target outlet highlighted; peers = ±10% sales |
| Peer Items Table | Peer Comparison | Item-level comparison with peer outlets |
| Peer Trend | Peer Comparison | Multi-week trend comparison vs peers |
| Item Deep Dive | Modal | Direction pie, top 5 outlets, multi-period trend, Total Kemunculan |

> **Removed (FIX-DOCS):** "Weekly Trend" (dual-axis Dev/BOM % + Nominal Deviasi chart) and "Trend Dev/BOM per Area" (`AreaTrendChart`) were removed from the Dashboard tab to make room for BOM Correlation — the `AreaTrendChart.tsx` file has since been deleted as dead code. `CardDrillDown.tsx` was also deleted; ExecutiveSummary KPI cards are now static display (no click-through drilldown). The RestoAnalisa priority-score drilldown is also a static card display.

### 4.2 Data Management

| Feature | Surface | Purpose |
|---------|---------|---------|
| Upload File | FilterBar | Drag-drop `.xlsx` (multi-sheet) → parser, dedup, direction computation, residual calc |
| Chunked Upload | API | Large files split into chunks (`/api/ingest-upload` + `/api/ingest-process`) |
| Import from Drive | FilterBar | Paste Google Drive URL → SSRF-allowlisted fetch + ingest |
| Kelola Data | Dialog | List / delete source files (with cascade) |
| Kelola PIC | Dialog | PIC assignment management + CSV import (`/api/pic`, `/api/pic/import`) |
| Migrate Direction | API | Idempotent recompute of `direction` field (admin trigger) |
| First-time Setup | API | `/api/setup` — bootstrap check |

### 4.3 Reporting

| Feature | Surface | Purpose |
|---------|---------|---------|
| Export Laporan Word | ExportDialog | `.docx` with section toggles (Exec Summary, Top Items, Top Outlets, Priority, Insights, Recommendations) — cached per (month, week, compareWeek, compareMonth, sections) |
| Export CSV | SourceDataModal | Full raw records (bypass 100-row display cap) |
| Audit Log | AuditLogDialog | Paginated audit trail (action / detail / duration) |

### 4.4 Configuration

| Feature | Surface | Purpose |
|---------|---------|---------|
| Pengaturan (Settings) | Dialog, 3 tabs | 43 runtime thresholds (Tolerance, Weights, Display, Historical Z-Score, Benchmarks) — persisted to `Setting` table |
| Quick Settings | Inline editor | Edit current threshold without opening dialog |
| Formula Info | Tooltip | Hover info explaining the formula behind each KPI |

### 4.5 Audit

| Feature | Surface | Purpose |
|---------|---------|---------|
| AuditLog table | DB | Append-only trail of mutations (ingest, delete, settings change, migration) |
| Audit Log Dialog | Dialog | Paginated viewer (admin-only — protected by middleware) |
| DQIssue | DB | Per-SourceFile data-quality issues (e.g. "outlet BAKSO is not a region") |

---

## 5. Business Rules

### 5.1 The 19 anomaly detection rules

Source of truth: `src/config/rules.yaml` (sole source of truth — the previous `src/config/rules.ts` TS mirror was deleted as dead code in FIX-DOCS). SQL evaluator: `src/lib/queries/rule-evaluation.ts` (16 rules evaluated in SQL push-down) + JS post-process (`evaluateHistoricalRulesJs`) for the 3 zScore-based rules. Each rule has a **severity** (`NORMAL` / `WARNING` / `ABNORMAL`) and a **priority** (higher = more important, used for tie-break in Priority Summary).

| # | Code | Category | Severity | Priority | Trigger |
|---|------|----------|----------|----------|---------|
| 1 | `SALES_DEVIATION_MISMATCH` | SALES | ABNORMAL | 90 | Deviation growth > 2× sales growth (both positive) |
| 2 | `SALES_DEV_DECREASE` | SALES | ABNORMAL | 85 | Sales down but deviation up |
| 3 | `BOM_DEVIATION_MISMATCH` | BOM | ABNORMAL | 88 | QTY Deviation growth > 2× BOM growth |
| 4 | `BOM_DOWN_DEV_UP` | BOM | ABNORMAL | 82 | BOM down but deviation up |
| 5 | `WASTE_BOM_MISMATCH` | BOM | WARNING | 55 | Waste growth opposite sign to BOM growth (e.g. BOM ↑ but Waste ↓) |
| 6 | `SUSUT_BOM_MISMATCH` | BOM | WARNING | 54 | Susut growth opposite sign to BOM growth |
| 7 | `TRIAL_BOM_MISMATCH` | BOM | WARNING | 53 | Trial growth opposite sign to BOM growth |
| 8 | `BOM_DEVIATION_DISPROPORTIONATE` | BOM | WARNING | 56 | Both BOM and Deviation growing but Deviation/BOM ratio > `BOM_DISPROPORTIONATE_FACTOR` (default 1.5×, configurable) and ≤ `BOM_DEVIATION_FACTOR` (default 2×, else rule 3 fires) |
| 9 | `TOLERANCE_BREACH_HIGH` | TOLERANCE | ABNORMAL | 80 | `|Dev/BOM|` > 2× `|tolerancePct|` |
| 10 | `TOLERANCE_BREACH` | TOLERANCE | WARNING | 70 | `|Dev/BOM|` > `|tolerancePct|` |
| 11 | `TOLERANCE_NOT_SET_HIGH_DEV` | TOLERANCE | WARNING | 65 | High `|Dev/BOM|` but tolerance is NULL (analytics flag) |
| 12 | `OVER_EXPLAINED` | RESIDUAL | ABNORMAL | 76 | Waste + Susut + Trial > total deviation (fraud red flag) |
| 13 | `RESIDUAL_LOSS_HIGH` | RESIDUAL | ABNORMAL | 75 | Residual ratio > `residualLossHighPct` (default 0.50) AND direction = LOSS |
| 14 | `RESIDUAL_LOSS_WARN` | RESIDUAL | WARNING | 60 | Residual ratio > `residualLossWarnPct` (default 0.30) AND ≤ high AND LOSS |
| 15 | `HIGH_LOSS_NOMINAL` | DIRECTION | ABNORMAL | 80 | `|nominalLossSurplus|` > `highLossNominalThreshold` (default Rp 10 jt) AND LOSS |
| 16 | `DIRECTION_FLIP` | HISTORICAL | WARNING | 60 | Direction flipped LOSS ↔ SURPLUS vs previous period |
| 17 | `HISTORICAL_ABNORMAL` | HISTORICAL | ABNORMAL | 78 | zScore > `historicalZscoreHigh` (default 2.0) AND LOSS |
| 18 | `HISTORICAL_ABNORMAL_SURPLUS` | HISTORICAL | ABNORMAL | 77 | zScore > `historicalZscoreHigh` AND SURPLUS |
| 19 | `HISTORICAL_WARNING` | HISTORICAL | WARNING | 58 | warn < zScore ≤ high |

> **Removed (FIX-RULE-CONFIG CONFIG-05):** `BENCHMARK_ABOVE_AREA` (was P50, WARNING) + `BENCHMARK_ABOVE_NETWORK` (was P72, ABNORMAL) — duplicates of `HISTORICAL_WARNING` / `HISTORICAL_ABNORMAL` (same zScore condition, different name). True area/network comparison lives in `computeBenchmark()` and surfaces as `ABOVE_AREA` / `ABOVE_NETWORK` flags on the Resto Profile, not as rules.

### 5.1.1 BOM Correlation Analysis

Rules 5–8 form the **BOM Correlation** group. They detect when a metric that should
track BOM volume (Waste, Susut, Trial, or Deviation magnitude) is moving in the
opposite direction (or at a disproportionate rate) vs BOM growth.

**Why this matters.** When BOM goes up (more production), Waste / Susut / Trial /
Deviation should also rise — they scale with production volume. If they go the
other way, it's a sign of:
- Manual entry error (forgot to record waste / recorded wrong sign).
- Process change not reflected in recipes (e.g. less frying waste due to new
  technique, but BOM still assumes old waste rate).
- Possible fraud: hiding waste by recording it elsewhere.

**Where the user sees it.**
1. **As rule flags** in the Anomalies panel and Priority Summary (severity = WARNING, lower priority than tolerance/residual rules).
2. **As the `BomCorrelationCard`** on the Dashboard tab (under "Analisis Historis").
   The card has three sections:
   - **Per-record findings table** (primary): one row per (outlet, item, adjustment)
     flagged by one of the 6 BOM-category rules (rules 3–8). Columns: Outlet |
     Item | Rule | BOM Growth | Metric Growth | Ratio. Per-rule count badges at
     the top show how many records each rule fired on (only rules with count > 0
     are shown). Sorted by rule priority DESC (most severe first). Reads from the
     `bomCorrelationFindings` + `bomCorrelationCounts` fields on the
     `/api/analysis` response.
   - **Aggregate alignment table**: 5-row table — QTY BOM (baseline), QTY Deviasi,
     QTY Waste, QTY Susut, QTY Trial — showing Current, Growth, Previous, and a
     ✓ Ya / ⚠ Tidak "Sejalan?" (aligned?) badge computed by comparing the
     metric's growth sign against BOM's growth sign.
   - **Narrative findings** below both tables spell out each mismatch in plain
     Indonesian.

**Interpretation guide.**
- "Waste turun X% saat BOM naik Y% — harusnya ikut naik" → check whether the
  outlet changed frying procedure or under-reported waste.
- "Deviasi naik 30% tidak proporsional dengan BOM naik 10% (rasio 3.0×)" → the
  deviation growth is faster than production growth — investigate the items
  driving the gap (Top Items / Bahan Analysis).
- If all metrics show "✓ Ya" → no correlation anomalies; deviation growth is
  explained by BOM growth.

**Condition logic for the 4 new rules** (from `src/config/rules.yaml`):

```yaml
# WASTE_BOM_MISMATCH (P55) — same shape for SUSUT_BOM_MISMATCH, TRIAL_BOM_MISMATCH
condition:
  any:
    - all:
        - bomGrowth: { lt: 0 }       # BOM down
        - wasteGrowth: { gt: 0 }     # Waste up
    - all:
        - bomGrowth: { gt: 0 }       # BOM up
        - wasteGrowth: { lt: 0 }     # Waste down

# BOM_DEVIATION_DISPROPORTIONATE (P56)
condition:
  all:
    - bomGrowth: { gt: 0 }
    - qtyDeviasiGrowth: { gt: 0 }
    - deviationBomRatio: { gt: bomDisproportionateFactor }   # default 1.5×
                                       # (configurable via BOM_DISPROPORTIONATE_FACTOR setting)
                                       # — catches the 1.5×–2× band that
                                       # BOM_DEVIATION_MISMATCH (rule 3) misses
```

Growth fields (`wasteGrowth`, `susutGrowth`, `trialGrowth`) are computed in the
rule-evaluation SQL CTE using `ABS(qty)` magnitude and div-by-zero guards — see
`src/lib/queries/rule-evaluation.ts` (lines 184–192).

### 5.2 Z-Score formula

```
Z-Score (SIGNED) = (|current value| − mean(weekly |historical values|))
                   / STDDEV_SAMP(weekly |historical values|)
```

- Value + baseline use **ABS (magnitude)** per the formula above.
- The **result is SIGNED**: positive = current above mean (worse), negative = below (better).
- Only positive zScore triggers anomaly rules.

The platform computes Z-Score for **two metrics** (Dev/BOM + QTY Deviasi) in the
HistoricalZScoreCard, with Z-Score fields also computed for Waste/Susut/Trial in the
backend (used by rule evaluation, not surfaced in UI selector):

| Metric | Field on criticalItems[] | UI Selector |
|--------|---------------------------|-------------|
| Dev/BOM (default) | `zScore` (Dev/BOM ratio) | ✅ Yes |
| QTY Deviasi | `qtyDeviasiZScore` (current `\|QTY Deviasi\|` vs weekly baseline) | ✅ Yes |
| Waste | `wasteZScore` | ❌ No (removed from selector) |
| Susut | `susutZScore` | ❌ No (removed from selector) |
| Trial | `trialZScore` | ❌ No (removed from selector) |

Each metric has its own historical baseline (mean + stddev) computed from the
same `queryHistoricalStatsMultiMetric` SQL CTE. The `HistoricalZScoreCard`
Dashboard component lets the analyst switch between **2 metrics** (Dev/BOM + QTY Deviasi)
with a selector; the same per-outlet-per-item criticalItems ranking is re-sorted by
the selected metric's zScore. Waste/Susut/Trial zScores are computed in the backend
but not surfaced in the UI selector. The BOM Correlation rules (5–7) do NOT use Z-Score
— they compare growth signs, which is a different signal.

**Rules of computation** (apply to all metrics identically):

- Each week = **1 observation**. Observation = aggregate value for that
  outlet+item pair (e.g. for Dev/BOM: `SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))`).
  **Not** per-row average.
- **Sample variance** (N−1, Bessel's correction) — appropriate because we treat the
  observed weeks as a sample of the outlet's behaviour.
- **Exclude current period** from the historical baseline (no leakage).
- Require `n ≥ HISTORICAL_MIN_WEEKS` (default **4**) — `n` = week count, not row count.
- Z-Score is **SIGNED** (not non-negative). Value + baseline use ABS (magnitude), but the
  **result** is signed so users can see direction:
  - **Positive** = current magnitude ABOVE historical mean (worse than usual) → RED
  - **Negative** = current magnitude BELOW historical mean (better than usual) → GREEN
  - **Zero** = current equals historical mean
  - Only POSITIVE zScore triggers anomaly rules (HISTORICAL_ABNORMAL / HISTORICAL_WARNING).
  - Items with zScore ≤ 0 (better than historical) are NOT shown as anomalous.
  - Direction (LOSS/SURPLUS) is tracked separately via `nominalLossSurplus` sign.

**Thresholds** (runtime-editable via Settings):

| Threshold | Default | Meaning |
|-----------|---------|---------|
| `HISTORICAL_MIN_WEEKS` | 4 | Min weeks of history before zScore is computed |
| `HISTORICAL_ZSCORE_WARN` | **1.5** | zScore > 1.5 (positive only) → `HISTORICAL_WARNING` flag + rule 19 |
| `HISTORICAL_ZSCORE_HIGH` | **2.0** | zScore > 2.0 (positive only) → `HISTORICAL_HIGH` flag + rules 17/18 |
| `BOM_DEVIATION_FACTOR` | **2.0** | Deviation growth > `bomDeviationFactor` × BOM growth → rule 3 fires (ABNORMAL) |
| `BOM_DISPROPORTIONATE_FACTOR` | **1.5** | Deviation growth > `bomDisproportionateFactor` × BOM growth (and ≤ `BOM_DEVIATION_FACTOR`) → rule 8 fires (WARNING). Range 1.0–5.0. Added in FIX-SETTINGS — decoupled from `BOM_DEVIATION_FACTOR` so lowering `BOM_DEVIATION_FACTOR` no longer silently disables rule 8. |

### 5.3 Priority scoring (P1 / P2 / P3)

Each outlet-item-record is assigned a priority tier using **OR logic** (any one
condition suffices — fixing audit issue #5 from the prior AND-based version that missed
high-residual-but-low-nominal cases).

| Tier | Condition (any one) |
|------|----------------------|
| **P1 — Critical** | `absNominalLossSurplus > P1_NOMINAL_THRESHOLD` (Rp 50 jt) **OR** `residualRatio > RESIDUAL_LOSS_HIGH_PCT` (0.70) **OR** `zScore > HISTORICAL_ZSCORE_HIGH` (2.0) **OR** `isOverExplained` (fraud flag) |
| **P2 — Watch** | `absNominalLossSurplus > P2_NOMINAL_THRESHOLD` (Rp 10 jt) **OR** `residualRatio > RESIDUAL_LOSS_WARN_PCT` (0.50) **OR** `absDevBom > STD_DEVIASI_BOM_PCT` (0.05) |
| **P3 — Normal** | None of the above |

#### 5.3.1 Operational priority score (5-weighted)

In addition to the tier assignment above, a continuous **operational priority score**
(0–100) is computed as a weighted sum across 5 signals. Weights are runtime-editable
via the Settings dialog (must sum to 100).

| Signal | Setting key | Default weight | What it measures |
|--------|-------------|---------------|------------------|
| Deviation/BOM ratio | `WEIGHT_DEV_BOM` | **30%** | Magnitude of deviation relative to expected usage |
| Growth mismatch | `WEIGHT_GROWTH` | **25%** | How much current deviates from prior-period trend |
| Residual loss | `WEIGHT_RESIDUAL` | **20%** | Share of deviation not explained by Waste/Susut/Trial |
| Tolerance breach | `WEIGHT_TOLERANCE` | **15%** | How far above the per-item tolerance threshold |
| Historical Z-Score | `WEIGHT_HISTORY` | **10%** | How abnormal vs the outlet's own historical pattern |

Each signal is normalised to 0–100 (100 = worst). Final score = Σ (weight × signal).
Higher score → higher priority in the Priority Summary ranking.

> **Health Score** (displayed on Resto Profile) is a *different* 4-weighted composite
> (Dev/BOM 30%, Residual 25%, Loss/Sales 25%, Abnormal rate 20%) where 100 = healthy.
> Do not confuse with the operational priority score above (where 100 = worst).

### 5.4 Sales MODE calculation

Sales is **not** summed per outlet. A single outlet can have multiple rows with
different `nominalSales` values (one per accounting adjustment line). Summing would
double-count.

```
Sales(outlet, period) = MODE(nominalSales)
```

- **Tie-break**: smaller value wins (deterministic across SQL and JS implementations).
- Computed in `computeSalesModePerOutlet()` (`src/lib/metrics/sales.ts`).
- Persisted in `OutletPeriodSales` (unique on `[outletId, monthLabel, weekLabel]`).

### 5.5 Direction convention

| Direction | Sign of `nominalLossSurplus` | Meaning |
|-----------|------------------------------|---------|
| **LOSS** | `< 0` | Aktual > SOC → rugi (over-consumption) |
| **SURPLUS** | `> 0` | Aktual < SOC → untung (under-consumption) |
| **NEUTRAL** | `= 0` | No deviation |

**Fallback chain** (when `nominalLossSurplus` is null):
1. Sign of `qtyDeviasi` (gross deviation).
2. Stored `direction` field (last resort; may be stale).

**Important**: The Excel convention treats **WASTE, SUSUT, TRIAL as negative** numbers
(they represent losses). Engine code uses `Math.abs()` before comparing magnitudes.
Sign confusion here was the root cause of audit issues H2, CALC-1 — now fixed.

### 5.6 Dev/BOM ratio (aggregate)

```
Dev/BOM = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))
```

**Volume-weighted aggregate**, not a per-row average. A per-row average would let
low-BOM items with high deviation skew the ratio. Applied consistently at every level:
outlet, area, network, trend.

### 5.7 Three-layer deviation decomposition

```
|QTY Deviasi|  =  |Waste|  +  |Susut|  +  |Trial|  +  |Residual|
   (Gross)         (Explained losses)         (Unexplained)
```

- **Residual > 50%** → majority of deviation is unexplained → strong indicator of
  fraud, wrong SO, or missing explanation category.
- **Over-explained** (Waste + Susut + Trial > Gross) → red-flag fraud (rule 8).

---

## 6. Known Limitations

These are **current** limitations, not bugs. Each is tracked for a future phase
(see §7).

| # | Limitation | Impact | Workaround |
|---|------------|--------|------------|
| L1 | **Single-user** — no auth UI exposed, no RBAC, no per-user audit | Anyone with the URL can use the platform; cannot attribute actions to individuals | Run behind VPN / IP allowlist; rely on audit log for traceability |
| L2 | **Manual Excel import** — no POS / ERP integration | Analyst must wait for back-office to export Excel weekly | (Phase D will add POS integration) |
| L3 | **Weekly data cadence** — not real-time | Anomalies discovered up to 7 days late | Acceptable for monthly reporting cycle |
| L4 | **No scheduled reports** — analyst must click "Export" manually | Risk of forgetting monthly report | Calendar reminder; (Phase C will add scheduling) |
| L5 | **No PDF export** — Word (`.docx`) only | PDF conversion requires manual step via Word | Open `.docx` in Word → Save As PDF |
| L6 | **No mobile app** — responsive web only | Outlet Managers cannot self-serve on the floor | Use desktop / tablet browser; (Phase D will add PWA) |
| L7 | **Single-tenant** — one F&B chain per deployment | Cannot sell to multiple chains on same instance | Separate deploy per chain |
| L8 | **Weeks are 1, 2, 4 only** (no WEEK 3 in source data) | Analyst must confirm with business whether intentional | Treat as a data-quality quirk; document in monthly report |
| L9 | **`/api/analysis` route is 12.6s cold** | Dashboard first-paint is slow on cold cache | 5-min DB cache (`AggregationCache`) + in-flight dedup + SWR for 7 sibling routes → warm cache hit returns in <50ms. See §6.5. |
| L10 | **AI narrative disabled** | Insights are rule-based, not LLM-generated | Re-enable with caching in Phase D |
| L11 | **No alerting** — analyst must poll the dashboard | Anomaly could sit unnoticed between Monday check-ins | (Phase C will add email/Slack alerts) |

### 6.5 Performance (as-shipped benchmarks)

After the PERF-API / PERF-DB / PERF-FE / PERF-CACHE passes (Tasks PERF-*, see
`worklog.md`), the dashboard's hot paths are:

| Route | Cold (uncached) | Warm (cached) | Speedup | Cache layers |
|-------|-----------------|---------------|---------|--------------|
| `/api/analysis` | 12.6 s → 0.56 s* | ~50 ms (cache hit) | 3–5× warm | DB AggregationCache (5 min) + in-flight dedup + HTTP SWR + TanStack `keepPreviousData` |
| `/api/pareto` | 3.87 s | 0.22 s | ~18× | DB cache + SWR (PERF-CACHE-09) |
| `/api/recommendations` | 1.82 s | 0.21 s | ~8.6× | DB cache + SWR |
| `/api/outlet-items` | 1.06 s | 0.25 s | ~3.8× | DB cache (PERF-API-01) + SWR |
| `/api/item-history` | 0.65 s | 0.23 s | ~2.2× | DB cache (PERF-API-02) + SWR |
| `/api/drilldown` | 0.42 s | 0.23 s | similar (reliable) | DB cache (PERF-API-03) + SWR |
| `/api/area-item-heatmap` | ~2–3 s | ~50 ms | ~30× | DB cache (PERF-CACHE-08) + SWR |

*After PERF-API-04 parallelisation of post-process sub-steps; was 12.60 s.

**SWR pattern** (`PERF-CACHE-09`): the 7 JSON cached routes (pareto, recommendations,
resto-bahan-matrix, outlet-items, item-history, drilldown, heatmap) return the
stale DB cache entry immediately (`stale: true` flag) on the first request after
the 5-min TTL expires, while a fire-and-forget background recompute refreshes
the cache. Concurrent requests during the recompute get fresh data (via in-flight
dedup). Mutations (`invalidateAnalysisCache`) delete all 9 route prefixes so no
stale entry is served after a write.

**Frontend cache warming** (`prefetchAnalysis` + `prefetchHeatmap`): on the
first `/api/status` load, `useDashboardEffects` fires both prefetches for the
latest period so the dashboard's first paint doesn't wait for the user to
interact. FilterBar additionally prefetches `analysis` on month/week dropdown
hover.

**Bundle / rendering** (`PERF-FE`):
- `page.tsx` split from 735 → 227 lines: dashboard sections live in
  `tabs/{DashboardTab,RestoTab,PeerTab,ParetoTab}.tsx`; side-effects in
  `hooks/{useDashboardEffects,useDashboardActions}.ts`; chrome in
  `DashboardHeader.tsx` + `DashboardFooter.tsx`.
- 4 tabs wrapped in `React.memo` (TanStable `data` ref → skips re-render on
  unrelated Zustand state changes).
- `AreaItemHeatmapSheet` (drill-down Sheet, ~240 lines) extracted + lazy-loaded
  via `next/dynamic` — not in the eager heatmap chunk.
- `refetchOnWindowFocus: false` on `useAnalysis` + `useStatus` + `useDrilldown`
  (was triggering 6–8s analysis refetches on every browser-tab switch).
- `optimizePackageImports` extended from 5 → 16 packages (recharts, lucide-react
  + 14 Radix primitives used by the 29 shadcn/ui components).

**DB / query** (`PERF-DB`):
- `rule-evaluation.ts` `curr` CTE slimmed from 21 → 14 columns (dropped 7
  unused columns — `qtyLossSurplus`, `absNominalDeviasi`, `absQtyDeviasi`,
  `absNominalLossSurplus`, `absQtyLossSurplus`, `residualQty`, `direction`).
- `heatmap.ts` queries gain `LIMIT 500` / `LIMIT 1000` safety (no-op today,
  defense-in-depth against future catalog growth or multi-tenant scenarios).
- New composite index `InventoryRecord(monthLabel, weekLabel, itemId)` — speeds
  up the heatmap cells query when the item `IN` list is small (typical case) and
  reduces sort cost in `historical.ts` GROUP BY.

**Cache-Control dev vs prod fix** (`AUDIT-CACHE`): `next.config.ts` now gates
the `immutable` static-asset cache header on `NODE_ENV === 'production'`.
Turbopack dev mode uses stable module-ID hashes (not content hashes), so
`immutable` in dev caused "old chunks keep appearing" after source edits.

---

## 7. Feature Roadmap

### Phase A — Quick wins (DONE)

Shipped as part of AUDIT-1 to AUDIT-4 + FIX-HIGH + FIX-MEDIUM:

- Info banner explaining data freshness (last uploaded month/week).
- Dedup rules for ingestion (idempotent re-upload).
- Test scaffolding for Z-Score computation (`tests/lib/metrics/historical.test.ts`,
  23 cases).
- Settings UI (Pengaturan dialog with 3 tabs and 43 thresholds).

### Phase B — Feature enhancement (DONE)

- Timeline chart (Multi-Period Comparison, 8-week trend table).
- Severity filter on anomaly list (NORMAL / WARNING / ABNORMAL).
- Pagination on drilldown API (cursor-based, capped at 500 → virtualised).
- Tooltip on every KPI explaining the formula behind it (FormulaInfo component).
- Multi-metric Z-Score selector on Historical Z-Score card (Dev/BOM / Waste / Susut /
  Trial).
- Pareto 80% drill-down on Growth Comparison + Deviation Breakdown charts.
- A11y hardening (44px touch targets, ARIA on expandable panels, keyboard nav).

### Phase B+ — Heatmap + performance pass (DONE)

Shipped as part of PERF-API / PERF-DB / PERF-FE / PERF-CACHE / AUDIT-CACHE:

- **Heatmap Area × Item** (`AreaItemHeatmap.tsx` + `AreaItemHeatmapSheet.tsx`):
  color-coded grid with Pareto 80% default mode, dual display (Total + Ø avg per
  resto), click-cell drill-down Sheet with per-outlet detail + TOTAL / Ø PER RESTO
  footer. API: `/api/area-item-heatmap` + `/api/area-item-heatmap/cell-detail`.
- **page.tsx split** (735 → 227 lines): dashboard sections moved to
  `tabs/{DashboardTab,RestoTab,PeerTab,ParetoTab}.tsx`; effects to
  `hooks/{useDashboardEffects,useDashboardActions}.ts`; chrome to
  `DashboardHeader.tsx` + `DashboardFooter.tsx`.
- **DB migration** to Supabase project `proosjqivxadwgftofry` (ap-southeast-1),
  626,739 rows migrated from prior project (`vefkgapveggbmkloaslw` — now paused).
- **SWR cache pattern** (`PERF-CACHE-09`) on 7 JSON cached routes — stale hit
  returns in <50ms while background recompute refreshes.
- **9 cached routes** (was 5) — added `outlet-items`, `item-history`, `drilldown`,
  `area-item-heatmap`. All invalidated on any mutation.
- **`prefetchHeatmap`** alongside existing `prefetchAnalysis` — fired on first
  status load in `useDashboardEffects`.
- **20 perf fixes across 4 agents** — DB cache on 3 new routes, parallelise
  metadata + post-process, slim `SELECT` columns, drop unused CTE columns, LIMIT
  safety, composite index, lazy Sheet, `React.memo` on 4 tabs, `refetchOnWindowFocus:
  false` on 3 queries, `optimizePackageImports` 5 → 16 packages.
- **Cache-Control dev vs prod fix** — `immutable` static-asset header gated on
  `NODE_ENV === 'production'` (was breaking Turbopack dev HMR).
- **Pre-push hook** (`.githooks/pre-push`) blocks force-push to `main`.

### Phase C — Foundation (PLANNED)

Multi-quarter effort, prerequisites for enterprise readiness:

1. **Multi-user auth** — NextAuth.js v4 already wired; expose UI, add RBAC roles
   (Analyst / Manager / Outlet-Manager / Auditor).
2. **Scheduled reports** — Cron-style monthly Word/PDF email to distribution list.
3. **Alerting** — Email / Slack / WhatsApp push when a P1 anomaly fires.
4. **PDF export** — In addition to `.docx` (likely via Playwright headless render).
5. **DB-level caching** — `AggregationCache` table now enabled across 9 routes
   (see §6.5); Phase C work is to surface `stale: true` flag in the UI + add
   SWR to `/api/analysis` (currently uses bespoke pipeline + in-flight dedup
   only).
6. **Statement timeout** on DB pool — single hung query no longer blocks the pool.

### Phase D — Growth (FUTURE)

Tentative, depends on Phase C adoption:

1. **POS integration** — Direct feed from POS / ERP (replaces manual Excel).
2. **ML anomaly detection** — Replace rule engine with isolation forest / autoencoder
   trained on historical patterns.
3. **Natural-language query** — "Show me outlets in Jawa Timur with rising residual
   this month" (LLM-backed, with strict schema validation).
4. **Mobile PWA** — Outlet Manager self-service (read-only profile + peer comparison).
5. **Multi-tenant** — White-label deployment for multiple F&B chains.
6. **AI narrative** — Re-enable LLM-generated executive insights with response caching.

---

## 8. Non-Goals (explicitly NOT doing)

To prevent scope creep, the following adjacent features are **explicitly excluded**
from this product. They belong to other systems (POS, ERP, recipe management, HACCP).

| # | Non-Goal | Why excluded |
|---|----------|--------------|
| NG1 | **Full inventory management** (stock levels, purchase orders, receiving, transfers) | This is a *deviation analytics* platform, not a WMS. The POS/ERP owns stock levels. |
| NG2 | **Recipe management / costing** | BOM is an input to this platform, not managed here. Recipe engineering lives in the culinary system. |
| NG3 | **HACCP / food safety compliance** | Out of scope — different regulatory regime, different data model. |
| NG4 | **Supplier management** | Procurement owns supplier data; this platform only sees item-level costs. |
| NG5 | **Multi-currency** | Indonesian Rupiah (IDR) only. Currency conversion belongs in the ERP. |
| NG6 | **Real-time stock adjustment** | Weekly cadence is intentional — daily noise would mask the signal. |
| NG7 | **Predictive demand forecasting** | Demand forecasting is a POS/analytics-suite feature; this platform consumes the forecast (via BOM) but does not produce one. |
| NG8 | **Employee scheduling / time-and-attendance** | HR system territory. |
| NG9 | **Customer-facing menu / ordering** | POS territory. |

> **Rule of thumb.** If a proposed feature does not advance the core loop
> *(detect deviation → investigate → report → tune thresholds)*, it likely belongs on
> this list. Push back in PR review.

---

## 9. Success Metrics (how we know the product works)

| Metric | Target | Source |
|--------|--------|--------|
| Time-to-insight per P1 anomaly | < 5 min | Analyst self-report |
| Monthly report turnaround | < 1 working day | Audit log timestamps |
| Anomalies auto-detected vs manual | > 90% auto | Rule engine coverage vs Excel findings |
| False-positive rate (rules firing on benign rows) | < 10% | Analyst feedback, quarterly review |
| Dashboard first-paint (TTFB) | < 8 s | `/api/analysis` duration in audit log |
| Settings changes without code deploy | 100% | Git history (no deploys for threshold tuning) |

---

## 10. Related Documents

| Document | Purpose |
|----------|---------|
| `MASTER_CONTEXT.md` | Architecture, DB schema, API surface, rule DSL, audit history. **Read first** for any code change. |
| `CONVENTIONS.md` | Code conventions (API route pattern, cache pattern, component pattern, rule DSL, performance + git conventions). Read before writing any new code. |
| `worklog.md` | Full chronological task history (every agent run, every fix). Search by Task ID. |
| `src/config/rules.yaml` | The 19 anomaly rules (15 original + 4 BOM correlation) — edit here to add/tune rules without touching engine code. Sole source of truth (legacy `rules.ts` mirror deleted). |
| `src/lib/settings.ts` | The 43 runtime thresholds — defaults + descriptions. |
| `src/lib/metrics/definitions.ts` | Single source of truth for metric formulas (Dev/BOM, Z-Score, Health Score, Priority, Direction, Three-Layer). |
| `src/config/thresholds.ts` | Static default thresholds (overridden at runtime by `Setting` table). |
| `prisma/schema.prisma` | 14 DB models, 12 indexes (added composite `(monthLabel, weekLabel, itemId)` in PERF-DB-09). |

---

*Authored retroactively by Agent DOC-PRD. Last updated by Agent DOC-UPDATE-2
(Heatmap drill-down + Pareto 80/20 + dual display, page.tsx split, DB migration
to `proosjqivxadwgftofry`, SWR cache, 9 cached routes, prefetchHeatmap, 20
perf fixes, Cache-Control dev/prod fix, pre-push hook). Update this document
whenever a Phase C+ feature ships or a Non-Goal is reconsidered.*
