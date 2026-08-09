# Inventory Control Intelligence Platform

Dashboard analisis inventory untuk jaringan **19+ outlet F&B**. Bukan sekadar dashboard reporting — ini adalah **decision-support tool** yang membantu Inventory Controller menentukan apa yang harus diinvestigasi terlebih dahulu.

## ✨ Fitur Utama

- 📊 **Executive Summary** — Sales, Nominal Deviasi, QTY BOM, Loss/Surplus dengan growth vs previous period
- 🚦 **Health & Alert** — klasifikasi Normal / Warning / Abnormal per record
- 📈 **Growth Comparison** — deteksi mismatch antara Sales Growth vs Deviasi Growth
- 🎯 **Top Priority Items** — ranking by Nominal (financial) dan Deviation/BOM (operational)
- 🔍 **Investigation Worklist** — P1/P2/P3 priority dengan recommended action
- 🤖 **AI Narrative** — analisis otomatis dalam Bahasa Indonesia (LLM sebagai narrative layer, bukan calculation engine)
- 💡 **Recommendation Engine** — WHY / WHAT TO CHECK / PRIORITY berbasis evidence
- 📅 **Cross-Week & Cross-Month Comparison** — bandingkan periode manapun secara kronologis
- 📥 **Google Drive Import** — paste link folder Drive, semua file .xlsx otomatis di-download & diproses
- 🔎 **Drill-down** — klik baris mana saja → lihat source records dengan calculation trace

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) + TypeScript |
| Database | SQLite via Prisma ORM |
| UI | shadcn/ui (New York) + Tailwind CSS 4 |
| Charts | Recharts |
| Excel Parser | exceljs |
| AI Narrative | z-ai-web-dev-sdk (backend only) |
| Rule Config | YAML (human-editable, no recompile) |

## 🚀 Quick Start

### Prasyarat
- Node.js 20+ atau Bun
- File Excel bulanan dengan kolom standar (lihat `src/lib/excel.ts` untuk mapping)

### Install & Run

```bash
# Install dependencies
bun install

# Setup database
bun run db:push

# Start dev server
bun run dev
```

Buka `http://localhost:3000` di browser.

### Import Data

Ada 2 cara:

#### Cara 1: Google Drive (Recommended)
1. Upload file Excel ke Google Drive folder
2. Set folder sharing ke "Anyone with link can view"
3. Copy link folder
4. Di dashboard, klik **"Import from Drive"** → paste link → **"Import Now"**

#### Cara 2: Local Folder
1. Set env variable di `.env`:
   ```
   INVENTORY_DATA_DIR=C:\path\to\your\excel\folder
   ```
2. Klik **"Refresh Data** di dashboard

### Naming File yang Didukung

```
Januari 2026.xlsx         → tanpa prefix
13.JANUARI 2026.xlsx      → dengan prefix angka
14. FEBRUARI 2026.xlsx    → prefix + spasi
JULI 2026.xlsx            → uppercase
191.JULI 26.xlsx          → 2-digit year
```

## 📁 Struktur Folder

```
src/
├── app/
│   ├── api/                    # API routes
│   │   ├── ingest/             # Excel ingestion
│   │   ├── import-drive/       # Google Drive import
│   │   ├── analysis/           # Main analysis endpoint
│   │   ├── drilldown/          # Source records lookup
│   │   └── status/             # Available months/weeks/outlets
│   ├── layout.tsx
│   └── page.tsx                # Main dashboard
├── components/
│   ├── dashboard/              # KPI cards, charts, worklist, narrative
│   ├── filters/                # Period/area/outlet selectors
│   ├── drilldown/              # Slide-in drawer
│   └── ui/                     # shadcn/ui primitives
├── engine/
│   ├── calculations/           # Growth, ratios, price effect, residual
│   ├── rules/                  # YAML rule evaluator
│   ├── analysis/               # Ranking, benchmarking, priority, worklist
│   └── narrative/              # LLM client + structured summary builder
├── config/
│   ├── rules.yaml              # Anomaly rules (edit without recompile)
│   ├── thresholds.ts           # Tunable business thresholds
│   └── settings.ts             # Labels, NULL handling, week periods
├── lib/
│   ├── db.ts                   # Prisma client
│   ├── excel.ts                # Excel parser + month extractor
│   ├── drive-import.ts         # Google Drive downloader
│   └── format.ts               # IDR/percent formatters
└── types/inventory.ts          # TypeScript types
```

## ⚙️ Konfigurasi (Tanpa Coding)

### Edit Aturan Anomaly
Buka `src/config/rules.yaml` — tambah/ubah rule tanpa sentuh kode engine:

```yaml
rules:
  - code: SALES_DEVIATION_MISMATCH
    name: "Deviation growth far exceeds sales growth"
    severity: ABNORMAL
    priority: 90
    condition:
      all:
        - salesGrowth: { gt: 0 }
        - nominalDeviasiGrowth: { gt: { mul: [salesGrowth, 2] } }
```

### Edit Threshold
Buka `src/config/thresholds.ts` — ubah tolerance, growth factor, priority weights.

## 🔒 Data Privacy

- Database & file Excel **tidak pernah keluar dari server lokal** Anda
- Hanya **aggregated metrics** (angka summary) yang dikirim ke LLM untuk narrative
- LLM **tidak boleh** menghitung ulang angka — semua perhitungan deterministic di TypeScript

## 📊 Business Logic

### Sign Convention
- `QTY BOM`, `QTY COM`, `QTY WASTE/SUSUT/TRIAL` → **NEGATIF** (konsumsi)
- `QTY DEVIASI` → **+** = LOSS (actual > SOC), **−** = SURPLUS (actual < SOC)
- `PENJUALAN` → selalu positif

### NULL vs 0
- `NULL` = tidak ada record/input → `KOSONG`
- `0` = ada input tapi nol → `ADA` (configurable via `CFG_RECON_SETTINGS.TREAT_ZERO_AS`)

### Week Period
- `WEEK 1` = tanggal 1-7
- `WEEK 2` = tanggal 8-14
- `WEEK 3` = tanggal 15-30/31

## 🎯 Principle Utama

Dashboard ini tidak hanya bilang "deviation tinggi" — ia menjawab 16 pertanyaan kunci:

1. SEBERAPA BESAR?
2. DIBANDINGKAN DENGAN APA?
3. APAKAH WAJAR?
4. DIMANA TERJADI?
5. ITEM APA?
6. OUTLET APA?
7. APAKAH TERKAIT SALES?
8. APAKAH TERKAIT BOM?
9. APAKAH TERKAIT PRICE?
10. APAKAH TERKAIT WASTE/SUSUT/TRIAL?
11. APAKAH TERKAIT SOC?
12. APAKAH TERKAIT ADMINISTRASI?
13. APA KEMUNGKINAN ROOT CAUSE?
14. APA YANG HARUS DICEK?
15. APA PRIORITAS INVESTIGASINYA?
16. APA REKOMENDASI TINDAK LANJUTNYA?

**Tujuan akhir:** DATA → UNDERSTANDING → DETECTION → INVESTIGATION → ACTION

---

Built with ❤️ for Inventory Controllers
