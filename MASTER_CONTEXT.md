# Master Context — Inventory Control Intelligence

> Dokumen ini adalah **master context** untuk project Inventory Control Intelligence.
> Berisi semua informasi penting: arsitektur, fitur, API, DB schema, aturan bisnis,
> audit findings, dan current state. Download file ini untuk handoff atau session baru.
>
> **Last updated:** Session AUDIT-1 to AUDIT-4 + FIX-HIGH + FIX-MEDIUM
> **Git commit terakhir:** `54859ba` (fix: 13 MEDIUM bugs from AUDIT-1 to AUDIT-4)

---

## 1. Project Overview

**Inventory Control Intelligence** adalah dashboard analitik untuk restoran (F&B)
untuk mendeteksi dan menyelidiki penyimpangan stock (deviation) antara
**Sistem (SOC/BOM)** vs **Aktual (Stok Fisik)**.

### Domain Problem
Setiap minggu, setiap outlet mengirim data stock opname (SO). Sistem membandingkan:
- **QTY BOM** (Bill of Materials — seharusnya dipakai berdasarkan resep)
- **QTY COM** (Cost of Materials — aktual pemakaian)
- **QTY Deviasi** (selisih = COM - BOM)
- **QTY Waste** (limbah terkontrol: gorengan gagal, dll)
- **QTY Susut** (penyusutan: evaporasi, pecah, dll)
- **QTY Trial** (trial produk baru)
- **QTY Loss/Surplus** (residual = Deviasi - Waste - Susut - Trial)

**Deviasi** didekomposisi menjadi 4 kategori untuk identifikasi root cause:
```
|QTY Deviasi| = |Waste| + |Susut| + |Trial| + |Residual|
```
- **Residual > 50%** = sebagian besar deviation TIDAK terjelaskan → indikasi fraud/salah input.

### Direction Convention (PENTING)
- **LOSS** = `nominalLossSurplus < 0` (aktual > SOC → rugi)
- **SURPLUS** = `nominalLossSurplus > 0` (aktual < SOC → untung)
- **NEUTRAL** = 0

---

## 2. Tech Stack

| Layer | Technology | Versi |
|-------|-----------|-------|
| Framework | Next.js 16 (App Router, Turbopack) | 16.1.3 |
| Language | TypeScript (strict mode) | 5.x |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) | - |
| Database | PostgreSQL (Supabase) via Prisma ORM | 6.11 |
| State (client) | Zustand (`useDashboard` hook) | - |
| State (server) | TanStack Query (React Query v5) | - |
| Charts | Recharts | - |
| Icons | Lucide React | - |
| Auth | NextAuth.js v4 (available, belum dipakai) | - |
| Rate Limiting | In-memory (per-IP) | - |
| Runtime | Bun (dev server) | latest |

### Connection String (Supabase)
```
postgresql://postgres.vefkgapveggbmkloaslw:***REDACTED-SUPABASE-PASSWORD-ROTATED***@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```
- **Port 6543** (transaction mode / PgBouncer) — untuk serverless
- **Port 5432** (session mode) — untuk migrasi
- `src/lib/db.ts` auto-switches ke 6543 + adds `pgbouncer=true`, `connection_limit=3`

### Environment Variables
```bash
DATABASE_URL=postgresql://...@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
# Optional (untuk AI features yang sudah di-disable):
# ZAI_API_KEY=...
```

---

## 3. Architecture

```
src/
├── app/
│   ├── page.tsx                      # Main dashboard (satu-satunya route)
│   ├── api/                          # 21 API routes (lihat §5)
│   └── layout.tsx
├── components/
│   ├── dashboard/                    # 15 komponen utama
│   │   ├── ExecutiveSummary.tsx      # KPI cards (top section)
│   │   ├── AnalysisCards.tsx         # Multi-period comparison + insights
│   │   ├── Charts.tsx                # GrowthComparison, DeviationBreakdown, TrendChart, LossVsSurplus
│   │   ├── CardDrillDown.tsx         # Generic drilldown modal (9 card configs)
│   │   ├── ItemDeepDive.tsx          # Modal detail item (klik dari top items)
│   │   ├── TopItems.tsx              # Top 10 items grid
│   │   ├── PrioritySummaryCard.tsx   # Top outlets ranking + recommendations
│   │   ├── RestoAnalysis.tsx         # Tab Resto Analysis (Ranking Nasional + Bahan Analysis)
│   │   ├── RestoRecommendationCard.tsx
│   │   ├── PeerComparison.tsx        # Tab Peer Comparison (scatter plot)
│   │   ├── InsightsPanel.tsx         # Auto-generated insights
│   │   ├── AdvancedAnalysis.tsx      # Variance + Historical analysis
│   │   ├── ExportDialog.tsx          # Export laporan Word
│   │   ├── FormulaInfo.tsx           # Tooltip info rumus
│   │   └── QuickSettings.tsx         # Inline settings editor
│   ├── drilldown/
│   │   ├── DrillDownDrawer.tsx       # Right-side sheet (klik row → raw records)
│   │   └── SourceDataModal.tsx       # Full-screen modal (all source records + CSV export)
│   ├── filters/                      # 6 komponen filter (FilterBar, PIC dialog, dll)
│   └── ui/                           # 50 shadcn/ui components
├── hooks/
│   ├── useDashboard.ts               # Zustand store (filters, drawers, modals)
│   ├── useAnalysis.ts                # React Query hook for /api/analysis + types
│   ├── useStatus.ts                  # (merged into useAnalysis)
│   └── useTheme.ts
├── lib/
│   ├── db.ts                         # Prisma client (lazy proxy, PgBouncer config)
│   ├── settings.ts                   # 43 runtime thresholds (DB-backed)
│   ├── format.ts                     # fmtIDR, fmtNum, fmtPct, directionColor, numberColor
│   ├── metrics/                      # 8 modules (Metric Engine)
│   │   ├── index.ts                  # Barrel export
│   │   ├── definitions.ts            # Metric definitions
│   │   ├── growth.ts                 # calcGrowth, calcGrowthAbs, computeGrowthResult
│   │   ├── deviation.ts              # computeNominalDeviationGrowth
│   │   ├── sales.ts                  # computeSalesModePerOutlet (MODE function)
│   │   ├── benchmark.ts              # computeBenchmark
│   │   ├── historical.ts             # computeHistoricalAnalysis
│   │   └── forecast.ts               # projectTrend
│   ├── queries/                      # 7 SQL query modules
│   │   ├── shared.ts                 # buildSqlFilters (area/outlet/item/PIC)
│   │   ├── dashboard.ts              # queryTrendAgg, queryExecSummary, queryDeviationBreakdown, dll
│   │   ├── items.ts                  # queryTopItemsByNominal, queryTopItemsByDeviasiRank, dll
│   │   ├── outlets.ts                # queryTopOutlets, queryTopOutletsBySales
│   │   ├── areas.ts                  # queryAreaAnalysis
│   │   └── historical.ts             # queryHistoricalStats
│   ├── ingestion.ts                  # Excel parser + multi-file ingest
│   ├── excel.ts                      # SheetJS wrapper
│   ├── month-resolver.ts             # Case-insensitive month label resolver
│   ├── rate-limit.ts                 # In-memory rate limiter
│   └── a11y.ts                       # clickableRowProps (keyboard a11y)
├── engine/
│   ├── analysis/                     # 8 modules
│   │   ├── analysis.ts               # Barrel export
│   │   ├── types.ts
│   │   ├── rankingService.ts         # computeVarianceAnalysis, computeOutletHealthRanking
│   │   ├── patternEngine.ts          # detectPatterns
│   │   ├── insightEngine.ts          # generateExecutiveInsights
│   │   ├── ruleService.ts            # getRootCauses
│   │   └── ...
│   ├── rules/
│   │   └── evaluator.ts              # evaluateRules (17 rules from rules.yaml)
│   └── transform.ts
├── config/
│   └── rules.yaml                    # 17 anomaly detection rules
├── types/
│   └── inventory.ts                  # ExecutiveSummary, InvestigationItem, dll
└── instrumentation.ts                # BigInt.prototype.toJSON polyfill
```

---

## 4. Database Schema (14 models)

File: `prisma/schema.prisma` (304 lines)

### Core Models
```
SourceFile (8 rows)        → metadata file Excel yang sudah di-upload
  ├─ Week (1:N)             → WEEK 1/2/4 per file
  └─ InventoryRecord (1:N)  → record per item×outlet×week

Outlet (340 rows)          → kode, nama, area
  └─ InventoryRecord (1:N)

Item (147 rows)            → nama, satuan
  └─ InventoryRecord (1:N)

InventoryRecord (293,436)  → TABEL UTAMA
  Fields: qtyBom, qtyCom, qtyDeviasi, qtyWaste, qtySusut, qtyTrial,
          qtyLossSurplus, nominalDeviasi, nominalWaste, nominalSusut,
          nominalTrial, nominalLossSurplus, nominalSales,
          residualQty, residualNominal, residualRatio,
          absQtyDeviasi, absNominalDeviasi, absQtyLossSurplus, absNominalLossSurplus,
          pctQtyDeviasiToBom, pctWasteSusut,
          tolerancePct, toleranceRaw, avgPrice,
          direction (LOSS/SURPLUS/NEUTRAL), area (denormalized),
          satuan, bulan, bulan2
```

### Supporting Models
```
OutletPIC (340 rows)       → assignment PIC ke outlet (outletCode → pic name)
Setting (43 rows)          → runtime thresholds (key/value/dataType)
DQIssue                    → Data Quality issues per SourceFile
AnomalyRule (empty)        → config mirror (engine uses rules.yaml instead)
AnomalyFlag (empty)        → per-record evaluated flags (in-memory only)
PeriodComparison (empty)   → pre-computed curr vs prev (computed on-the-fly)
AggregationCache (empty)   → DB-level cache (disabled, using in-memory LRU)
AuditLog                   → audit trail
FileChunk                  → chunked upload support
```

### Indexes (11 pada InventoryRecord)
- `monthLabel_weekLabel_idx` — composite filter utama
- `area_monthLabel_weekLabel_idx` — filter by area
- `outletId_weekId_idx`, `itemId_weekId_idx`
- `direction_idx`, `sourceFileId_idx`
- `absNominalDeviasi_idx` — sort by magnitude

### Current Data State
- **8 SourceFiles** (8 bulan: Januari–Agustus 2026)
- **340 Outlets** across 14 areas
- **147 Items**
- **293,436 InventoryRecords**
- **20 PICs** assigned to outlets
- Weeks: WEEK 1, WEEK 2, WEEK 4 (no WEEK 3 in source data)

### Areas (14)
```
BANTEN, JAKARTA, JAWA BARAT 1, JAWA BARAT 2, JAWA TENGAH 1, JAWA TENGAH 2,
JAWA TIMUR 1, JAWA TIMUR 2, KALIMANTAN 1, KALIMANTAN 2, PAPUA & MALUKU,
SULAWESI 1, SULAWESI 2, WCR
```

---

## 5. API Endpoints (21 routes)

### Main Data
| Endpoint | Method | Purpose | Duration |
|----------|--------|---------|----------|
| `/api/analysis` | GET | Main dashboard data (executive summary, top items, trends, growth drivers, deviation drivers) | 6–8s |
| `/api/status` | GET | Source files list, months, weeks, outlets, areas, PICs, stats | <2s |
| `/api/drilldown` | GET | Raw InventoryRecords by outletCode/itemName (case-insensitive) | <1s |
| `/api/outlet-items` | GET | Resto Analysis profile + 3 rankings (Financial/Operational/Unexplained) | 1–2s |
| `/api/item-history` | GET | Historical timeline for an item | <1s |
| `/api/recommendations` | GET | P1/P2/P3 outlet recommendations | <1s |

### Peer Comparison
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/peer-comparison` | GET | Outlet scatter plot (sales vs devBom) |
| `/api/peer-comparison/items` | GET | Peer items comparison |
| `/api/peer-comparison/trend` | GET | Peer trend comparison |

### Data Management
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ingest` | POST | Upload Excel file |
| `/api/ingest-upload` | POST | Chunked upload |
| `/api/ingest-process` | POST | Process uploaded chunks |
| `/api/import-drive` | POST | Import from Google Drive URL |
| `/api/data` | GET/DELETE | List/delete source files |
| `/api/pic` | GET/POST | PIC management |
| `/api/pic/import` | POST | Import PIC CSV |

### Config & Maintenance
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/settings` | GET/PUT | Runtime thresholds |
| `/api/setup` | GET | First-time setup check |
| `/api/migrate-direction` | POST | Re-run direction migration (idempotent) |
| `/api/export-report` | GET | Export laporan Word (.docx) |

### Query Parameters (analysis route)
```
/api/analysis?month=Agustus%202026&week=WEEK%201
  &compareWeek=WEEK%201|||Juli%202026   (cross-month compare)
  &area=JAWA%20TIMUR%201
  &outlet=1016.MLGJAK
  &item=MINYAK%20MIE
  &pic=Andi
```

---

## 6. Fitur Utama (Feature List)

### A. Dashboard (Tab 1)
1. **Executive Summary** — Sales, BOM, Deviasi (KPI cards with growth %)
2. **Health Status** — Normal/Warning/Abnormal count + rule breakdown
3. **Growth Comparison** — 4 metrics (Sales/BOM/QTY Deviasi/Nominal Deviasi) + **80% Pareto drill-down** (clickable badges, expandable panel showing top items contributing to growth/decline)
4. **Deviation Breakdown** — Waste/Susut/Trial/Residual bar chart + **80% Pareto drill-down** (clickable bars + badges, expandable panel per category)
5. **Loss vs Surplus** — Record count + nominal split
6. **Weekly Trend** — Dev/BOM % + Nominal Deviasi over weeks (dual-axis)
7. **Top Items** (10 cards, clickable → ItemDeepDive modal)
8. **Top Outlets** (by nominal, by sales, by loss, by surplus)
9. **Priority Summary** — P1/P2/P3 outlets + recommendations
10. **Insights Panel** — Auto-generated executive insights
11. **Multi-Period Comparison** — 8-week trend table
12. **Advanced Analysis** — Variance analysis (top worsened/improved) + Historical analysis (critical items vs historical avg)

### B. Resto Analysis (Tab 2)
1. **Resto Profile** (6 sections):
   - Performance (Sales, BOM, Deviasi, Dev/BOM)
   - Behavior (Waste/Susut/Trial/Residual composition)
   - Historical (current vs previous, trend DETERIORATING/IMPROVING/STABLE/INSUFFICIENT_DATA)
   - Benchmark (outlet vs area vs network, ABOVE_AREA/ABOVE_NETWORK/NORMAL)
   - Top Risk (top 5 per category)
   - Investigation (normal/warning/abnormal count + health score)
2. **Bahan Analysis** — 3 ranking tabs:
   - A. Financial Impact (by absNominalLossSurplus)
   - B. Operational (by Dev/BOM)
   - C. Unexplained (by Residual Ratio)
3. **Menu Analysis** — Group by first 2 words of item name, outlier detection (avg + 2σ)
4. **Ranking Item Nasional** — Top 50 item-outlet pairs by deviasi rank

### C. Peer Comparison (Tab 3)
1. **Scatter Plot** — Sales vs Dev/BOM (target outlet highlighted, peers = ±10% sales)
2. **Peer Items Table** — Item-level comparison with peers
3. **Peer Trend** — Multi-week trend comparison

### D. Drilldown (Overlay)
1. **DrillDownDrawer** — Right-side sheet, raw records (capped 100 rows, full via SourceDataModal)
2. **SourceDataModal** — Full-screen modal, all records (capped 100 display, Export CSV for full)
3. **ItemDeepDive** — Modal detail item (direction distribution pie, top 5 outlets, multi-period trend, Total Kemunculan from drilldown data with limit=500)

### E. Data Management
1. **Upload File** — Excel (.xlsx) drag-drop
2. **Import Drive** — Google Drive URL
3. **Kelola Data** — List/delete source files
4. **Kelola PIC** — PIC assignment management + CSV import
5. **Export Laporan** — Word (.docx) export with section toggles

---

## 7. Aturan Bisnis (Business Rules)

### 17 Anomaly Detection Rules (`src/config/rules.yaml`)
1. `SALES_DEVIATION_MISMATCH` — Deviasi naik > 2× sales
2. `SALES_DEV_DECREASE` — Sales turun tapi deviasi naik
3. `BOM_DEVIATION_MISMATCH` — Deviasi naik > 2× BOM
4. `BOM_DOWN_DEV_UP` — BOM turun tapi deviasi naik
5. `TOLERANCE_BREACH_HIGH` — Deviasi > 2× toleransi
6. `TOLERANCE_BREACH` — Deviasi > toleransi
7. `TOLERANCE_NOT_SET_HIGH_DEV` — Deviasi tinggi tapi toleransi belum diset
8. `OVER_EXPLAINED` — Waste+Susut+Trial > total deviasi (indikasi fraud)
9. `RESIDUAL_LOSS_HIGH` — Residual LOSS > threshold (critical)
10. `RESIDUAL_LOSS_WARN` — Residual LOSS > threshold (warning)
11. `HIGH_LOSS_NOMINAL` — Nominal loss > Rp 10Jt
12. `BENCHMARK_ABOVE_AREA` — Dev/BOM > area avg × factor
13. `BENCHMARK_ABOVE_NETWORK` — Dev/BOM > network avg × factor
14. `DIRECTION_FLIP` — LOSS ↔ SURPLUS antar periode
15. `HISTORICAL_ABNORMAL` — Z-score > threshold vs historical
16. `HISTORICAL_ABNORMAL_SURPLUS` — Same, untuk SURPLUS direction
17. `HISTORICAL_WARNING` — Z-score moderate

### 43 Runtime Thresholds (`src/lib/settings.ts`)
Dapat di-edit via Pengaturan dialog atau `/api/settings`. Contoh:
- `TOP_N_ITEMS` (default 10) — jumlah item di Top Items
- `TOP_N_OUTLETS` (default 10) — jumlah outlet di Top Outlets
- `RESIDUAL_LOSS_WARN_PCT` (0.3) — ambang residual warning
- `RESIDUAL_LOSS_HIGH_PCT` (0.5) — ambang residual critical
- `HIGH_LOSS_NOMINAL_THRESHOLD` (10Jt) — ambang nominal loss
- `BENCHMARK_AREA_FACTOR` (1.5) — multiplier untuk ABOVE_AREA
- `BENCHMARK_NETWORK_FACTOR` (2.0) — multiplier untuk ABOVE_NETWORK
- `STD_DEVIASI_BOM_PCT` (0.1) — threshold untuk computeGrowthResult
- `SALES_DEVIATION_FACTOR` (2.0) — faktor mismatch sales vs deviasi
- `BOM_DEVIATION_FACTOR` (2.0) — faktor mismatch BOM vs deviasi

### Direction Computation (FIX VERIFY3-8)
```typescript
// Computed on-the-fly (not stored r.direction which may be inverted):
if (nominalLossSurplus != null) {
  direction = nominalLossSurplus < 0 ? 'LOSS' : nominalLossSurplus > 0 ? 'SURPLUS' : 'NEUTRAL'
} else if (qtyDeviasi != null) {
  direction = qtyDeviasi < 0 ? 'LOSS' : qtyDeviasi > 0 ? 'SURPLUS' : 'NEUTRAL'
} else {
  direction = stored_r_direction // last resort fallback
}
```

### Sales Computation (MODE function)
Sales dihitung via **MODE** per outlet (bukan SUM), karena 1 outlet bisa punya
multiple baris dengan nominalSales berbeda (per akun penyesuaian). MODE mengambil
nilai yang paling sering muncul. Implementasi: `computeSalesModePerOutlet()` di
`src/lib/metrics/sales.ts`. Tie-break: nilai lebih kecil menang.

### Dev/BOM Ratio
```
Dev/BOM = SUM(ABS(qtyDeviasi)) / SUM(ABS(qtyBom))
```
Volume-weighted aggregate (bukan AVG per record). Diterapkan di semua level:
outlet, area, network, trend.

---

## 8. Audit History & Current State

### Session AUDIT-1 to AUDIT-4 (Deep Audit)
4 agent paralel mengaudit 4 area:
- **AUDIT-1**: Deviation Breakdown Pareto (fitur baru)
- **AUDIT-2**: Growth Comparison + Multi-Period + Pareto
- **AUDIT-3**: Ranking Nasional + Resto Analysis + Outlet Focus
- **AUDIT-4**: Card DrillDown + Item Deep Dive + Peer Comparison

### FIX-HIGH (9 bugs, semua fixed & pushed commit `0088ecf`)
| ID | Bug | Fix |
|----|-----|-----|
| H1 | Area benchmark silent 0 (ir.area ≠ Outlet.area) | JOIN Outlet, filter by o.area |
| H2 | pctLossSurplusToBom always green (SQL ABS, dead `< 0` check) | Color by nominalDeviasi sign |
| H3 | DETERIORATING false alarm (no prev period) | Guard `prevRecs.length === 0 → INSUFFICIENT_DATA` |
| H4 | itemName case-sensitive (lowercase returns 0) | `mode: 'insensitive'` |
| H5 | Drawer null-guards missing (crash on soft-deleted relation) | `?.` + `?? '—'` everywhere |
| H6 | Total Kemunculan from top-10 only (capped) | Use drilldown data (limit=500) |
| H7 | absDeviation = deviation (sometimes negative) | `Math.abs(r.nominal)` |
| H8 | Delta threshold `< 1` too coarse | Per-metric: currency→1000, qty→0.01 |
| H9 | Mismatch badge missed negative-sales case | `deviasiGrowth > 0 && salesGrowth < deviasiGrowth/2` |

### FIX-MEDIUM (13 bugs, semua fixed & pushed commit `54859ba`)
| ID | Bug | Fix |
|----|-----|-----|
| M-A | Badge touch target 20px (below 44px WCAG) | `py-2 min-h-[36px]` |
| M-B | No ARIA on badges/panels | `aria-expanded`, `aria-controls`, `role="region"`, `aria-label` |
| M-C | `expanded` not reset on data change | Adjust-state-during-render pattern |
| M-D | No LIMIT on deviationDrivers SQL | `LIMIT 500` |
| M-E | growthDrivers unbounded (119 items, 19KB) | Cap at top-20 + remainder |
| M-F | qtyDeviasi uses ABS (hides LOSS↔SURPLUS flips) | Signed accumulation for qtyDeviasi |
| M-G | MenuAnalysis group by 1 word (merges different items) | Group by 2 words |
| M-H | "Top 100"/"Semua" options but SQL caps at 50 | Removed options |
| M-K | operational+unexplained rankings computed but hidden | Added 2 tabs |
| M-L | P2/P3 badge contrast fail WCAG AA | 600→700 variants |
| M-J | bucket_avg CTE N×N (wasteful) | Refactored to 50×N |
| M-M | CardDrillDown color returns green for null | `v == null ? '' :` guard |
| M-N | Tables render 500 rows (jank) | Cap visible at 100 |
| M-P | `payload!.name` non-null assertion | `payload?.name ?? ''` |

### Bonus Fixes (included in FIX-HIGH)
- **M2**: Removed `(growthMetrics as any).multiPeriodComparison` cast
- **M6**: Added `staleTime: 30_000` to `useDrilldown` (avoid refetch on drawer reopen)

---

## 9. Known Issues & Technical Debt

### Dari Migration Audit (sebelumnya, masih ada beberapa)
- **MIG-9**: `src/lib/db.ts` tidak pakai `globalThis.prisma` singleton — dev hot-reload bisa leak connections. Production fine (serverless cold start).
- **MIG-10**: No `statement_timeout` configured — single hung query bisa block pool. Fix: add `statement_timeout=30000` to connection URL.
- **MIG-13**: `@libsql/client` + `@prisma/adapter-libsql` masih di package.json tapi tidak dipakai (PostgreSQL-only sekarang). Bisa di-`bun remove`.
- **MIG-19**: `skipDuplicates` try/catch SQLite fallback adalah dead code (PG support native). 5 sites, ~50 lines.
- **MIG-16/17/18**: `AggregationCache`, `AnomalyRule`, `AnomalyFlag`, `PeriodComparison` tables kosong (dead schema models, engine pakai in-memory/file-based).

### Data Quality Issues ( dari audit)
- **MIG-7**: 1 outlet punya area="BAKSO" (produk name, bukan region) — Excel source DQ issue. Perlu verifikasi business.
- **MIG-8**: monthLabel mixed-case ("MEI 2026" vs "Agustus 2026") — ditangani via `month-resolver.ts` shim.
- Weeks: WEEK 1, 2, 4 saja (no WEEK 3 in source data) — confirm with business apakah intentional.

### Performance Notes
- `/api/analysis` route: 6–8s (heaviest). `maxDuration = 60` set untuk Vercel.
- 16 queries parallel di `Promise.all` (analysis route).
- In-memory cache `analysisCache` **disabled** (CACHE_TTL_MS = 0) untuk serverless consistency.
- `statusCache` (5 min) dan `monthResolver` cache aktif.
- EXPLAIN verified: `InventoryRecord_monthLabel_weekLabel_idx` digunakan (Bitmap Index Scan), no full table scan.

### LOW/INFO Issues (belum difix, low priority)
- L1: Waste `#f59e0b` & Susut `#a16207` both amber variants — color-blind risk.
- L2: `key={i}` array-index keys di beberapa table rows — React anti-pattern (safe untuk read-only data).
- L3: `MultiPeriodComparisonRow.[key:string]:unknown` index signature — dead code, bisa dihapus.
- L4: `avgDeviasiByBom` misnamed — averages `absQtyDeviasi` (QTY), bukan Dev/BOM ratio. UI display correct, tapi column header misleading.
- L5: Zebra striping `bg-muted/10` overrides `priorityBg(r.priority)` pada odd rows di RestoAnalysis.

---

## 10. Cara Menjalankan

### Development
```bash
# Set DATABASE_URL (sudah di .env)
cd /home/z/my-project
bun run dev          # Start dev server di port 3000 (auto-restart, tee ke dev.log)
bun run lint         # ESLint check
npx tsc --noEmit     # TypeScript check
bun run db:push      # Push schema changes ke DB (accept-data-loss)
bun run db:generate  # Regenerate Prisma client
```

### Import Data
```bash
# Upload Excel via UI (Upload File button)
# Atau via script:
DATABASE_URL=<url> bun run scripts/upload-data.ts <excel-file.xlsx> <pic.csv>
```

### Migrate Direction (idempotent, safe)
```bash
DATABASE_URL=<url> bun run scripts/migrate-direction.ts
# Fixes rows where direction != sign(nominalLossSurplus)
```

### Production Deploy (Vercel)
- `vercel.json` ada maxDuration untuk ingest (300s), import-drive (300s), outlet-focus (60s).
- **PENTING**: analysis route butuh `maxDuration = 60` (sudah set di file, MIG-3 fixed).
- Environment variables: set `DATABASE_URL` di Vercel dashboard.

---

## 11. Glossary

| Term | Meaning |
|------|---------|
| **SOC** | Stock Opname Card — stok sistem (seharusnya) |
| **BOM** | Bill of Materials — resep standar pemakaaihan |
| **COM** | Cost of Materials — aktual pemakaian |
| **Deviasi** | Selisih COM - BOM |
| **Waste** | Limbah terkontrol (gorengan gagal, dll) |
| **Susut** | Penyusutan alami (evaporasi, pecah) |
| **Trial** | Trial produk baru |
| **Loss/Surplus** | Residual setelah dikurangi Waste+Susut+Trial |
| **Dev/BOM** | Rasio deviasi terhadap BOM (normalized deviation) |
| **PIC** | Person In Charge — penanggung jawab outlet |
| **Resto** | Outlet/restoran |
| **MODE** | Fungsi statistik — nilai paling sering muncul (untuk Sales) |
| **Pareto 80%** | Top items yang berkontribusi 80% dari total |
| **LOSS** | nominalLossSurplus < 0 (rugi) |
| **SURPLUS** | nominalLossSurplus > 0 (untung) |

---

## 12. Key Files Quick Reference

| File | Purpose | Lines |
|------|---------|-------|
| `src/app/page.tsx` | Main dashboard page (satu-satunya route) | ~600 |
| `src/app/api/analysis/route.ts` | Main data endpoint (16 parallel queries) | ~996 |
| `src/lib/queries/dashboard.ts` | Dashboard SQL queries (trend, exec, breakdown) | ~290 |
| `src/lib/queries/items.ts` | Item SQL queries (top items, deviasi rank) | ~620 |
| `src/lib/settings.ts` | 43 runtime thresholds | ~420 |
| `src/config/rules.yaml` | 17 anomaly detection rules | ~200 |
| `prisma/schema.prisma` | 14 models, 11 indexes | 304 |
| `src/hooks/useAnalysis.ts` | Types + React Query hooks | ~435 |
| `src/components/dashboard/RestoAnalysis.tsx` | Resto Analysis tab (3 rankings + menu) | ~975 |
| `src/components/dashboard/Charts.tsx` | GrowthComparison + DeviationBreakdown + Trend | ~565 |
| `worklog.md` | Full work log (semua task, audit, fix) | 15,151 |

---

## 13. Next Steps / Recommendations

### Immediate (kalau lanjut)
1. **Fix LOW/INFO issues** — minor cleanup, low priority.
2. **MIG-9**: Add `globalThis.prisma` singleton (dev hot-reload leak).
3. **MIG-10**: Add `statement_timeout=30000` to connection URL.
4. **MIG-13**: `bun remove @libsql/client @prisma/adapter-libsql`.
5. **MIG-16/17/18**: Remove dead schema models OR implement persistence.

### Medium Term
1. **DB-level caching** for analysis route (AggregationCache table sudah ada, tinggal implement).
2. **Pagination** for drilldown API (currently capped at 500, no cursor).
3. **Virtualization** for large tables (react-window atau @tanstack/react-virtual).
4. **Export PDF** (sekarang hanya Word via docx).
5. **User authentication** (NextAuth available, belum dipakai).

### Long Term
1. **Real-time updates** (WebSocket mini-service pattern sudah ada di examples).
2. **Mobile app** (PWA atau React Native).
3. **Multi-tenant** (sekarang single-tenant).
4. **AI narrative** (dulu pakai LLM, sudah di-disable untuk performance — bisa re-enable dengan caching).

---

## 14. Contact / Handoff

- **Repo:** https://github.com/anandategarch/Inventory-Control
- **Branch:** main
- **Last commit:** `54859ba` (fix: 13 MEDIUM bugs)
- **Worklog:** `/home/z/my-project/worklog.md` (15,151 lines — semua history)
- **Dev server:** `http://localhost:3000` (preview via Preview Panel, bukan direct access)

### Untuk Session Baru
1. Baca dokumen ini (MASTER_CONTEXT.md).
2. Baca `/home/z/my-project/worklog.md` (khususnya section terakhir per Task ID).
3. Cek `git log --oneline -20` untuk history commit.
4. Run `bun run dev` + `bun run lint` + `npx tsc --noEmit` untuk verify state.
5. Preview via Preview Panel di sebelah kanan interface.

---

*Dokumen ini generated oleh Z.ai Code setelah menyelesaikan deep audit (AUDIT-1 to AUDIT-4) + fix 9 HIGH + 13 MEDIUM bugs.*
