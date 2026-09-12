# MASTER CONTEXT — VISUAL HIERARCHY (DASHBOARD ANALISIS)

> **BACA DULU SEBELUM TUGAS UI/APPEARANCE APA PUN.** Dokumen ini adalah master context
> khusus **visual hierarchy** — single source of truth untuk urutan, bobot, dan perilaku
> visual seluruh section analisa dashboard Inventory Control Intelligence.
>
> **STATUS: v1.0 — APPROVED USER.** Approval eksplisit atas keseluruhan rancangan
> (termasuk rekomendasi D1-D10): *"aku approve dan setujua dengan rancangan anda,
> kerjakan sekarang dengan no mistake"*. Dokumen ini dipromosikan ke repo
> (berdampingan dengan `MASTER_CONTEXT.md`) — semua perubahan UI wajib patuh padanya.
> Revisi hanya lewat changelog §14.
>
> Sumber otoritas bersama: (1) Master Context bisnis 67 pasal (upload) — khususnya
> §46, §49–§54, §61–§63, §65, §67; (2) `MASTER_CONTEXT.md` (engineering, repo) — khususnya
> "UI Design Principles" (PC-focused); (3) audit UI/UX H-14-a/H-14-b (worklog);
> (4) inventaris as-is VH-1-a/VH-1-b + brief teori VH-1-d + riset web VH-1-c (2026).

---

## 1. MASALAH YANG DISELESAIKAN (KONDISI AS-IS)

Hasil inventaris `@5617faf` (verifikasi file:baris oleh VH-1-a/VH-1-b):

1. **Semua konten analisa hidup DI DALAM tab** (`page.tsx:236-317`). Tidak ada layer naratif
   global: user harus masuk tab "Dashboard" dulu untuk melihat KPI, dan 13 section di dalamnya
   disajikan **rata tanpa ritme** (`space-y-4` seragam, tanpa label layer, tanpa penanda
   zona kerja vs zona baca).
2. **Urutan section DashboardTab saat ini** (DashboardTab.tsx:61-227): ExecutiveSummary →
   Item Prioritas → Resto Prioritas → Insights → Health+Growth+Breakdown (grid-3) → Top
   Growth → Multi-Periode → Price Effect → Area+Ranking → Pola Item → Historis (Z-Score +
   BOM Korelasi) → Loss vs Surplus → Heatmap. Urutan ini **sudah hampir naratif yang benar**
   (status → prioritas → insight → diagnosis), tetapi tidak diberi bobot visual berbeda,
   dan semuanya tenggelam setara dalam satu tab.
3. **Struktur penting terselip di dalam**: skor Health 0-100 hanya hidup di dalam
   `HealthAlert` (grid-3 baris ke-5); Residual & Dev/BOM hanyalah "kartu sekunder"
   (ExecutiveSummary.tsx:225-254); label periode hanya ada di badge ExecutiveSummary,
   bukan di header.
4. **Inkonsistensi penamaan** section-header vs card-title (mis. "Ranking Kondisi Resto"
   vs "Ranking Kondisi Outlet"; "Pola Item (Massal/Regional/Lokal)" vs "Analisis Pola Item";
   Heatmap tanpa SectionHeader sama sekali).
5. Temuan H-14-a/b yang berkaitan hierarchy: touch target tab ~26px, tab bar mobile tanpa
   affordance scroll, format angka campur (koma vs titik desimal lintas 15+ file).

**Inti masalah (bahasa teori):** dashboard saat ini adalah *flat dump* — 13 kartu dengan
bobot setara = tidak ada hierarchy = tidak ada jawaban 5 detik (Stephen Few). Konsep
user memperbaiki persis ini.

---

## 2. LANDASAN TEORI (RINGKAS, DENGAN RUJUKAN)

| Prinsip | Inti | Terjemahan ke konsep user |
|---|---|---|
| **Piramida terbalik** (Minto, *The Pyramid Principle*) | Jawaban dulu, bukti kemudian | L2 jawab "kondisi apa", L3 "di mana", L4-L5 "mengapa", L6 bukti lengkap |
| **Shneiderman's Mantra** (IEEE 1996, "Overview first, zoom and filter, details on demand") | Overview → filter → detail sesuai permintaan | L2-L3 = overview; L1 = filter; L5-L6 = details on demand (drilldown drawer/modal = detail tingkat dua) |
| **5-second rule** (Stephen Few, *Information Dashboard Design*) | Kondisi bisnis terbaca <5 detik tanpa scroll; <30 detik tahu di mana masalahnya | L2-L4 harus above-the-fold di viewport kerja PC |
| **F-shaped pattern** (NN/g eyetracking 2006) | Mata berat ke kiri-atas, menyapu horizontal | KPI pertama (Deviasi Rp) & Resto Prioritas di posisi kiri; jangan taruh hero di kanan |
| **Progressive disclosure** (NN/g; pencilandpaper.io) | Tunda kompleksitas ke lapisan berikutnya | L3 default top-3 (+expand), L6 menampung semua modul berat |
| **Data storytelling** (Knaflic, *Storytelling with Data*) | what → so what → why → now what | EXECUTIVE STATUS → WHAT NEEDS ATTENTION → WHY IT HAPPENED → (DIAGNOSIS) → DEEP ANALYSIS |
| **IBCS SUCCESS** (Hichert) | Semantik konsisten: warna = data, bukan dekorasi; struktur standar | Merah=kondisi buruk, emerald=baik, amber=watch di SEMUA layer; satu format angka |
| **Gestalt** (proximity, common region) | Jarak & wilayah = pengelompokan | Gap antar-layer ≥ 2× gap antar-kartu; zona L6 dibedakan sebagai band |
| **Preattentive processing** (Ware) | Ukuran/warna diproses <250ms sebelum fokus sadar | Hero KPI `text-4xl`; satu-satunya angka merah langsung ketemu |

Risiko bila urutan dilanggar: deep-analysis tampil sebelum status → analyst menjumlah
sendiri angka; insight terpisah dari angkanya → bolak-balik scroll (biaya foraging naik).

---

## 3. STRUKTUR LAYER FINAL (TO-BE) — KONSEP USER, DIPERKAYA

```text
┌──────────────────────────────────────────────────────────────────────┐
│ L0 HEADER (sticky top)                                                │
│ [logo] Inventory Control · 12 outlet        [Memperbarui…] [Export ⋯]│
│ JUL 2026 · WEEK 4 · vs JUN 2026   ← label periode global (NAIK ke sini)│
├──────────────────────────────────────────────────────────────────────┤
│ L1 FILTER BAR (di dalam header sticky)                                │
│ [Bulan][Minggu][Pembanding] | PIC ▾  AREA ▾  KELOMPOK ▾  OUTLET ▾    │
│                                          [Filter (3) ▸] [Reset] [⚙] │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   01 · EXECUTIVE STATUS                          ← jawab WHAT/HOW MUCH│
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌─────────────┐             │
│ │ DEVIASI   │ │ RESIDUAL  │ │ DEV/BOM   │ │ HEALTH      │             │
│ │ Rp 12,4Jt │ │ 340 qty   │ │ 3,2%      │ │ 87 · SEHAT  │             │
│ │ ▲ 8,1% vs │ │ 62% dev   │ │ tol 2%    │ │ ▓▓▓▓▓░ 87  │             │
│ └───────────┘ └───────────┘ └───────────┘ └─────────────┘             │
│ (hero = kartu 1, terbesar; kaskade GROSS→W/S/T→NET tetap wajib §50)    │
│                                                                       │
│   02 · WHAT NEEDS ATTENTION                        ← jawab WHERE       │
│ ┌────────────────────────────┐ ┌────────────────────────────┐        │
│ │ RESTO PRIORITAS  #1 #2 #3  │ │ ITEM PRIORITAS #1 #2 #3    │        │
│ │ (klik → tab Resto)         │ │ (klik → drilldown item)    │        │
│ └────────────────────────────┘ └────────────────────────────┘        │
│                                                                       │
│   03 · WHY IT HAPPENED                          ← jawab WHY (hipotesis)│
│ ┌────────────────────────────────────────────────────────────────┐   │
│ │ INSIGHT OTOMATIS — 2 kritis · 3 warning · 1 positif  [≤5 kartu]│   │
│ └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│   04 · DIAGNOSIS                        ← jawab WHY (terukur, 3 lensa) │
│ ┌──────────────┐ ┌──────────────────┐ ┌──────────────────┐            │
│ │ GROWTH       │ │ BREAKDOWN        │ │ PRICE EFFECT     │            │
│ │ Sales/BOM/Dev│ │ Gross→W/S/T→Net  │ │ Harga vs Kuantitas│           │
│ └──────────────┘ └──────────────────┘ └──────────────────┘            │
│                                                                       │
╞═══════════════════════════════════════════════════════════════════════╡
│ 05 · DEEP ANALYSIS — band full-bleed, tab strip sticky saat scroll    │
│ [AREA] [RESTO] [ITEM] [PARETO] [HISTORICAL] [HEATMAP] (+[PEER]? → D2) │
│ ── isi tab: mode kerja, keep-alive, semua modul berat ──              │
╚═══════════════════════════════════════════════════════════════════════╝
│ L7 FOOTER (sticky bottom) — stats + hint drill-down                  │
└──────────────────────────────────────────────────────────────────────┘
```

**Prinsip struktural non-negosiabel:**

1. **L2-L5 berada DI LUAR `<Tabs>`** di `page.tsx` — di atasnya dalam DOM. Konsekuensi:
   ganti tab **tidak pernah** me-remount/unmount layer naratif; posisi scroll naratif
   bertahan; state filter tetap level page (sudah benar as-is).
2. Tab strip L6 = satu-satunya zona "band" (full-bleed `bg-muted/25`, `border-t-2`) —
   sinyal peralihan "dari membaca → bekerja".
3. Kaskade bisnis **GROSS → W/S/T → NET** (pasal §50, §56-57) TIDAK BOLEH hilang dari
   layar utama. Bila L2 dipangkas jadi 4 KPI, kaskade wajib tetap hadir di BREAKDOWN (L5).
4. Semua angka bertanda memakai konvensi sign dulu baru ABS (§59): LOSS merah, SURPLUS
   emerald — di layer mana pun.
5. PC-first (keputusan user tercatat di MASTER_CONTEXT.md "UI Design Principles"):
   target utama 1280-1600px; mobile = degradasi fungsional, bukan target desain (→ D10).

---

## 4. SPESIFIKASI PER LAYER

### L0 — Header (sticky top, `z-40` — sudah ada, dipertajam)

- Elemen kiri: logo 28px + `h1` "Inventory Control" (`text-sm font-semibold tracking-tight`
  — sudah benar as-is) + badge "{N} outlet".
- **BARU**: label periode global `JUL 2026 · WEEK 4 · vs JUN 2026` sebagai baris kedua
  header (`text-xs font-medium text-muted-foreground tracking-wide tabular-nums`) —
  dipromosikan dari badge ExecutiveSummary (as-is ExecutiveSummary.tsx:200-203). Filter
  ganti periode → label ikut berubah tanpa scroll.
- Kanan: badge "Memperbarui…" + badge cache (existing), tombol **Export** (existing),
  tombol ⋯ (menu ringkas: Keyboard shortcut, Pengaturan — opsional, → D7).
- Sticky `top-0 z-40` + `backdrop-blur-xl` + `border-b border-amber-500/60` (existing) dipertahankan.

### L1 — Filter Bar (di dalam header sticky — sudah ada, 2 perubahan)

- Urutan kontrol tetap as-is (Bulan, Minggu, Pembanding | PIC, Area, Kelompok, Outlet |
  Reset) — sudah sesuai pasal §49 (6 filter utama + Kelompok).
- **BARU**: badge jumlah filter aktif **"Filter (n)"** di tombol toggle bila FilterBar
  di-collapse (mockup user) — as-is hanya tombol Reset kondisional (FilterBar.tsx:407-423).
- Tombol aksi data (Settings/Kelola Data/PIC/Import/Upload/Refresh) tetap di ujung kanan
  FilterBar (existing) — jangan naik ke L0 agar header tetap tipis (→ D7).

### L2 — EXECUTIVE STATUS (4 KPI, grid `grid-cols-2 md:grid-cols-4 gap-4`)

Mapping mockup → as-is:

| KPI mockup | Sumber as-is | Rumus/pasal |
|---|---|---|
| **Deviasi (Rp)** — HERO `text-4xl` | Nominal Deviasi (ExecutiveSummary KPI#2, amber, inverse) | §13, §66: QTY Deviasi × Price |
| **Residual (qty)** | Residual Loss (kartu sekunder #1; amber) | §11.3, §62: Net yang belum terjelaskan |
| **Dev/BOM (%)** | Deviation/BOM (kartu sekunder #2; zinc) | §19: QTY Deviasi / QTY BOM |
| **Health (87)** | Skor 0-100 + verdict SEHAT/PERLU PERHATIAN/KRITIS (HealthAlert:340-367) | = normal/total×100 |

- Anatomi kartu (turunan dari KPICard as-is yang sudah bagus): label
  `text-xs font-medium` + InfoTooltip rumus (bukan hover-only — tetap ada ikon persisten);
  nilai `text-3xl font-bold tabular-nums tracking-tight` (hero `text-4xl` + SATU penanda,
  mis. `border-t-2 border-amber-500`); delta `text-xs font-semibold tabular-nums` + ikon
  panah; caption "vs {pembanding}"; DeltaBar bidirectional (komponen sudah ada).
- Warna = data: merah loss / emerald surplus / amber watch / muted netral. Token
  `--chart-loss/surplus/waste` (globals.css:80-90) — dilarang hardcode warna baru.
- **D1 (keputusan user)**: KPI yang tidak masuk mockup (Sales, QTY BOM, Gross Deviation,
  Explained W+S+T, Net Loss/Surplus) — turun ke BREAKDOWN L5, atau tetap strip mini
  kaskade di bawah 4 KPI. Kaskade §50 wajib terlihat di suatu tempat L2/L5.

### L3 — WHAT NEEDS ATTENTION (2 kartu, grid `lg:grid-cols-2 gap-4`)

- **Resto Prioritas** ← `RestoRecommendationCard` (as-is top-5; klik → `setFocusOutlet` →
  tab Resto). Anatomi baris: rank badge `h-7 w-7 rounded-full` (#1 inversi
  `bg-foreground text-background`), nama + meta area, skor priority kanan (merah ≥55 /
  amber ≥30 / emerald), mini-bar proporsional; `min-h-11`; footer "Top 3 dari N outlet —
  X% dari deviasi · lihat semua →" (loncat tab Resto terfilter).
- **Item Prioritas** ← 2 varian as-is (ByNominal = dampak finansial; ByDevBom =
  abnormalitas ternormalisasi) — **D5**: tampil berdampingan dalam satu kartu (2 kolom
  internal) atau default varian Nominal + toggle varian. Ranking memakai ABS setelah
  direction (§36, §42, §59); volume sales diakui lewat Dev/BOM (bukan nominal saja).
- Default **top-3** (mockup) + expand ke 5/10; uji kumulatif: bila top-3 <50% total
  deviasi → naikkan default ke 5.

### L4 — WHY IT HAPPENED — Insight Otomatis (1 panel lebar)

- ← `InsightsPanel` (9 rule client-side `buildInsights`, 4 severity). Maks **≤5 kartu
  insight** tampil + badge ringkasan hitungan (existing) + "N lainnya".
- Bentuk: `ui/callout` (border-l-4) — critical `border-red-500 bg-red-500/5`, warning
  `border-amber-400 bg-amber-50/40`, positive emerald, info zinc. **Pembeda dari kartu
  data: border kiri saja + prose** (Gestalt similarity) — dua bentuk, dua makna.
- Disiplin konten pasal §53-54: bahasa "indikasi/kemungkinan/perlu ditelusuri"; klaim +
  angka pendukung + arah tindakan; dilarang klaim root cause. Setiap insight punya tombol
  aksi filter/loncat (existing).

### L5 — DIAGNOSIS (3 kartu, grid `lg:grid-cols-3 gap-4`)

| Kartu | Modul as-is | Isi wajib |
|---|---|---|
| **Growth** | `GrowthComparison` (bar 4 metrik + mismatch badge + driver 2×2) | Sales vs Deviasi mismatch (§52 rule 1) |
| **Breakdown** | `DeviationBreakdownChart` (W/S/T/Residual + badge residual >50%) | Kaskade **GROSS → W/S/T → NET** (§50, §57) + penampung KPI yang turun dari L2 (→ D1) |
| **Price Effect** | `PriceEffectCard` (self-fetch /api/price-effect, dekomposisi Bennet) | Harga vs Kuantitas (§22, §55) + badge Dominasi |

- Kartu L5 = versi **ringkas** (default collapse ke inti: 1 chart/badge + 2-3 angka;
  expand untuk tabel penuh) — progressive disclosure; detail penuh tetap ada di L6/Historical.
- Kandidat modul yang ikut turun/naik ke sini → D4 (Top Growth, Loss vs Surplus,
  Multi-Periode, BOM Correlation, HealthAlert detail).

### L6 — DEEP ANALYSIS (band + tab strip 6 [+1?] tab)

Mapping tab usulan → isi as-is (basis VH-1-b):

| Tab | Isi (modul as-is) | Status migrasi |
|---|---|---|
| **AREA** | AreaComparison (tabel 14 area) + Top-Areas quadrant (dari Pareto, opsional) | Promosi section → tab; konten sudah ada |
| **RESTO** | Tab Resto penuh: Priority Summary, Resto Profile 6 kartu, Menu Analysis, Bahan Analysis 3-ranking, Ranking Item Nasional, Item Detail Modal | Sudah ada 1:1 |
| **ITEM** | TopItems 2 varian (pindah dari DashboardTab) + Trend Item penuh (search, line chart, rank chart, table, flip matrix, flip ranking) + Pola Item (Massal/Regional/Lokal) + Item Peer Comparison | Merge Dashboard-section + tab Trend |
| **PARETO** | Tab Pareto penuh (5 quadrant, nested, abnormal, gap rank, action plan footer) | Sudah ada 1:1 |
| **HISTORICAL** | HistoricalZScoreCard + Multi-Periode + BOM Correlation + (opsional: Flip Ranking cross-item, Trend Dev/BOM peer) | Klaster modul historis dipromosikan |
| **HEATMAP** | AreaItemHeatmap + HeatmapSheet (sudah self-fetch, self-contained) | Promosi section → tab; paling murah |
| **PEER (?)** | 8 modul peer comparison (efficiency, gap, ranking, scatter, peer table 11-metric, item-level, trend, correlation) | **TIDAK ada di mockup → D2 WAJIB diputuskan** |

- Tab strip: label `text-xs font-medium` + ikon `h-3.5 w-3.5` + indikator aktif amber
  (pola `after:h-0.5 after:bg-amber-500` existing dipertahankan); `min-h-9` desktop;
  sticky saat scroll `sticky top-[offset-header] z-30` + `bg-background/85 backdrop-blur`
  (offset diukur dari tinggi aktual header+filter; → D7).
- Keep-alive `forceMount + data-[state=inactive]:hidden` + gating `visitedTabs`
  dipertahankan (pola teruji PAKET A + H-8).
- Shortcut keyboard 1-6 (+7 bila Peer) — remap dari 1-5; E (export), R (refresh) tetap.

### L7 — Footer (sticky bottom — sudah benar as-is, tidak berubah)

Statistik "N outlet · N item · N record" + "Analisis terakhir: Xms" + hint drill-down
(DashboardFooter.tsx:21-54). Pertahankan `sticky bottom-0 mt-auto` (kontrak sticky
footer wajib).

---

## 5. DESIGN TOKENS (KONVERSI & NORMALISASI)

### 5.1 Label layer (eyebrow) — komponen baru `LayerHeader`

Menggantikan pemakaian SectionHeader untuk 5 layer naratif (SectionHeader tetap dipakai
DI DALAM tab L6 untuk sub-section):

```text
[01] EXECUTIVE STATUS ─────────────────────────────────────────
text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground
nomor "01" tabular-nums text-foreground/40 · garis pengisi h-px flex-1 bg-border
```

- Eyebrow = `h2` SUNGGUHAN (bukan div) + `<section id="l2-status" aria-labelledby>`
  + `scroll-mt-32` (kompensasi header sticky). Referensi: CFPB Design System
  ("eyebrow heading — secondary, concise, above main heading"), Cedar/REI, Uxcel.
- Bahasa label: bahasa mockup user (EN uppercase) — → D8 konfirmasi final.

### 5.2 Skala tipografi (final, PC-first)

| Peran | Kelas | Asal |
|---|---|---|
| Judul halaman (L0) | `text-sm font-semibold tracking-tight` | as-is (benar) |
| Label periode (L0) | `text-xs font-medium text-muted-foreground tracking-wide tabular-nums` | baru |
| Eyebrow layer (h2) | `text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground` | baru |
| Nilai KPI | `text-3xl font-bold tabular-nums tracking-tight`; hero `text-4xl` | as-is 2xl → naik |
| Label KPI | `text-xs font-medium text-muted-foreground` | as-is 11px → normalisasi |
| Judul kartu (h3) | `text-sm font-semibold` | as-is (benar) |
| Skor besar | `text-3xl font-bold tabular-nums` | as-is (benar) |
| Body/insight | `text-sm leading-relaxed text-foreground/90` | baru (prose wajib lega) |
| Caption/meta | `text-xs text-muted-foreground` | as-is (benar) |
| Header/sel tabel | `text-xs uppercase tracking-wider` / `text-xs font-mono tabular-nums` | as-is (benar) |

`tabular-nums` wajib untuk semua angka yang dibandingkan/di-filter. Font Geist
Sans/Mono dipertahankan.

### 5.3 Ritme spacing (mengganti `space-y-4` seragam)

- **Antar-layer naratif (L2-L5): `space-y-8 md:space-y-10` (32-40px)** — aturan Gestalt:
  gap layer ≥ 2× gap kartu.
- Antar-kartu grid: `gap-4` (16px) — as-is dipertahankan.
- Intra-kartu: `gap-2/gap-3` (8-12px) — as-is dipertahankan.
- Band L6: `border-t-2 border-border bg-muted/25` full-bleed
  (`-mx-3 px-3 sm:-mx-6 sm:px-6` menembus padding container) — pemisah zona kerja.

### 5.4 Semantik warna (konsolidasi, IBCS)

- Merah `text-red-600` = LOSS/kondisi buruk/priority TINGGI; emerald `text-emerald-600` =
  SURPLUS/membaik; amber = watch/aksi/priority SEDANG/identitas brand (tab aktif, hero);
  zinc/muted = netral (BOM, Dev/BOM, info). Token `--chart-*` (globals.css) = satu-satunya
  sumber untuk chart; dilarang hex baru (menutup temuan ScatterPlotCard hardcode).
- **Normalisasi wajib menyertai implementasi**: satu konvensi desimal koma (fmtPct/fmtIDR)
  di seluruh komponen yang diangkat (menutup backlog H-14-a/b: fmtGrowth titik-desimal,
  ~15 file .toFixed campur).
- Dark mode: tetap terkunci light (as-is providers.tsx) → D9.

### 5.5 Komponen yang DIPAKAI ULANG (jangan bangun baru)

DeltaBar, SparkLine, BarList, TargetComparison, Callout, InfoTooltip, QuickSettings,
FormulaInfo, SearchableComboBox, ScrollArea tabel sticky-header, DrillDownDrawer,
ItemDeepDive, PrioritySummaryCard — semua sudah teruji. Komponen baru HANYA:
`LayerHeader` (eyebrow) + `PeriodLabel` (L0) + badge "Filter (n)".

---

## 6. ATURAN INTERAKSI & PERILAKU

1. **Ganti tab L6**: tidak menyentuh L2-L5 (di luar `<Tabs>`) — tanpa remount, tanpa
   refetch layer naratif, scroll naratif tidak berpindah.
2. **Ganti filter/periode**: SEMUA layer L2-L6 dipicu invalidate (paket H-14/T3
   `invalidateAllData` 18-key sudah benar — perilaku dipertahankan); tab aktif tidak reset.
3. **Klik entitas prioritas (L3)**: resto → `setFocusOutlet` → tab RESTO aktif; item →
   drilldown/ItemDeepDive. Klik = narasi berhenti, kerja dimulai.
4. **Insight (L4)**: tombol aksi mem-filter dashboard/loncat tab terkait (existing).
5. **Sticky berjenjang**: header+filter `z-40` (existing) → tab strip L6 `z-30` saat
   sticky → back-to-top `z-20` → overlay Radix `z-50`. Total chrome sticky di mobile
   jangan >30% viewport.
6. **Anchor & scroll**: id `l1-filter, l2-status, l3-attention, l4-why, l5-diagnosis,
   l6-deep` + `scroll-mt-32`; opsional chip mini 01-05 sebagai daftar isi (desktop).
7. **Drilldown traceability (§63)**: setiap angka naratif tetap punya jalur
   klik → DrillDownDrawer → SourceDataModal → record sumber. Tidak boleh ada angka
   "dead-end" di layer naratif baru.
8. **Keyboard**: 1-6(/7) tab, E export, R refresh, Esc tutup overlay — remap + tooltip
   shortcut diperbarui.

---

## 7. PETA MIGRASI MODUL (AS-IS → TO-BE, LENGKAP)

| Modul as-is (file) | Rumah to-be | Catatan |
|---|---|---|
| ExecutiveSummary 6 KPI + 2 sekunder | L2 (4 terpilih) + sisanya → D1 (Breakdown L5 / strip kaskade) | grid 2/4 baru |
| HealthAlert (ring skor + verdict) | L2 kartu HEALTH (ringkas) + detail → L5/D4 | skor+bar, bukan gauge |
| RestoRecommendationCard (top-5) | L3 kiri, default top-3 + expand | klik→Resto (existing) |
| TopItemsByNominal + ByDevBom | L3 kanan (ringkas) + versi penuh → tab ITEM | D5 varian |
| InsightsPanel | L4 | ≤5 kartu + ringkasan |
| GrowthComparison | L5 GROWTH (ringkas) + expand penuh | |
| DeviationBreakdownChart | L5 BREAKDOWN + penampung kaskade §50 | |
| PriceEffectCard | L5 PRICE EFFECT (penuh — sudah ringkas) | self-fetch |
| TopGrowthCard | → D4 (kandidat: L5 baris ke-2 / tab RESTO+ITEM / Historical) | vs compare-period |
| MultiPeriodComparisonCard | → tab HISTORICAL | |
| AreaComparison | tab AREA (inti) | |
| OutletHealthRanking | tab AREA (kandidat) / L3 pendukung → D4 | klik→Resto |
| ItemConsistencyAnalysis (Pola Item) | tab ITEM | + item-anomali-outlets fetch |
| HistoricalZScoreCard + BomCorrelationCard | tab HISTORICAL | |
| LossVsSurplusChart | → D4 (L5 ringkas / Historical) | |
| AreaItemHeatmap + Sheet | tab HEATMAP (promosi murah) | |
| Tab Resto (Profile, Priority Summary, Menu, Bahan, Ranking Nasional) | tab RESTO | 1:1 |
| Tab Pareto (5 quadrant, nested, abnormal, gap, action plan) | tab PARETO | 1:1 |
| Tab Trend Item (search, chart, rank, table, flip matrix, flip ranking) | tab ITEM | merge |
| Tab Peer (8 modul) | **D2 WAJIB** — tab ke-7 ATAU pecah ke RESTO/ITEM | |
| DrillDownDrawer, SourceDataModal, ItemDeepDive, Export, dialogs | overlay global (tetap) | |
| DashboardFooter | L7 (tetap) | |

---

## 8. KEPUTUSAN TERBUKA — DIPUTUSKAN v1.0 (SETELAH APPROVAL USER)

| # | Keputusan | Opsi | Keputusan final (dengan alasan) |
|---|---|---|---|
| **D1** | Komposisi KPI L2 | (a) 4 KPI mockup persis; (b) 6+2 as-is; (c) 4 KPI + strip mini kaskade GROSS→W/S/T→NET | **(c)** — mockup tetap bersih, pasal §50 tetap terpenuhi, Breakdown tidak overload |
| **D2** | Nasib Peer Comparison (8 modul) | (a) tab ke-7 "PEER"; (b) pecah: peer-resto → RESTO, peer-item → ITEM; (c) sub-mode | **(a)** — fitur matang, murah, business-valuable; 7 tab masih muat |
| **D3** | Urutan & nama tab final | (a) AREA RESTO ITEM PARETO HISTORICAL HEATMAP; (b) +PEER di posisi? | **AREA · RESTO · ITEM · PEER · PARETO · HISTORICAL · HEATMAP** (PEER setelah ITEM) |
| **D4** | Modul ambig: Top Growth, Loss vs Surplus, Multi-Periode, BOM Corr, Health detail, OutletHealthRanking | lihat §7 | Top Growth + Loss/Surplus → **L5 baris-2 ringkas** (2 kartu kecil); Multi-Periode + BOM Corr → **HISTORICAL**; Health detail → **Resto Profile**; OutletHealthRanking → **tab AREA** (satu rumah, satu label — menutup inkonsistensi "Resto/Outlet") |
| **D5** | Bentuk Item Prioritas L3 | (a) 2 varian berdampingan; (b) toggle Nominal/Dev-BOM | **(b)** — hemat ruang, paralel D1 |
| **D6** | Top-3 vs top-5 default L3 | 3 (mockup) / 5 (as-is resto) / adaptif | **3 default + expand** (Miller 7±2; kumulatif <50% → 5) |
| **D7** | "Filter (n)" + konsolidasi tombol header | badge collapse di L1; tombol data tetap di FilterBar; tab strip sticky | **sesuai spesifikasi L1/L6** (dikonfirmasi) |
| **D8** | Bahasa label layer | (a) EN uppercase (mockup); (b) ID ("RINGKASAN EKSEKUTIF") | **(a)** EN uppercase untuk eyebrow; subjudul kartu tetap ID |
| **D9** | Dark mode | tetap light-only / buka bersamaan | **tetap light-only** (PR terpisah) |
| **D10** | PC-first dikonfirmasi | ya (sesuai MASTER_CONTEXT) / mobile-parity | **ya** — mobile degradasi fungsional saja |

> Keputusan implementasi tambahan (turunan D3): tab default saat load = **AREA** —
> kontennya (AreaComparison + OutletHealthRanking) dirender dari payload /api/analysis
> yang sudah ada, tanpa fetch tambahan; termasuk tab termurah untuk eager-mount.

---

## 9. ABOVE-THE-FOLD BUDGET (PC-FIRST)

| Viewport | Konten terlihat (tanpa scroll) | Target |
|---|---|---|
| 1440×900 (utama) | header ~104px → L2+L3+L4 utuh, L5 menyembul | IDEAL — kontrak 5 detik |
| 1280×720 (minimum) | L2+L3 utuh, L4 sebagian | CUKUP — hero Deviasi + resto #1 wajib terlihat |
| 375px (degradasi) | KPI 2×2 + judul Resto Prioritas | minimum: hero Deviasi + delta + resto #1 |

Bila L2-L4 tidak muat di 1280×720 → pangkas konten, JANGAN kecilkan font.

---

## 10. AKSESIBILITAS

- Heading: tepat satu `h1` (L0) → `h2` = eyebrow layer (5-6) + judul band L6 → `h3` =
  judul kartu → `h4` sub-grup. Tanpa lompatan level.
- KPI grid = `<dl>` (dt label, dd nilai+delta); landmark `<section aria-labelledby>`;
  skip-link `#main-content` (existing) dipertahankan.
- Kontras: `text-amber-700` untuk teks amber di atas putih (~4,6:1); `amber-500` hanya
  garis/non-teks. Angka besar ≥24px bold boleh 3:1.
- `prefers-reduced-motion` (sudah ada globals.css) — semua animasi dekoratif `motion-safe:`.
- PC-first: touch target 44px bukan target desain (keputusan tercatat), tetapi tab &
  baris prioritas tetap dibuat `min-h-9`+ agar mudah diklik mouse-area lega.

---

## 11. ANTI-PATTERN (TOLAK DI REVIEW IMPLEMENTASI)

1. Gauge/pie dekoratif untuk Health/Deviasi ( Few: chrome tanpa presisi).
2. Rainbow color — maks 3 warna semantik + muted per viewport (IBCS).
3. Semua kartu sama bobot (= kondisi as-is yang diperbaiki).
4. Border+ring+shadow+tint sekaligus — SATU mekanisme penekanan per elemen.
5. KPI carousel/slider (menyembunyikan angka dari tatapan).
6. Dump section rata tanpa eyebrow/ritme.
7. Warna di chrome, bukan di data.
8. Count-up animation angka (menunda baca 5 detik).
9. Hover-only information (rumus wajib punya ikon persisten).
10. Truncation tanpa tooltip.
11. Sticky-ception (header+filter+tab+kartu sticky >30% viewport).
12. Judul kartu netral padahal bisa judul-pesan IBCS ("5 outlet = 78% deviasi").
13. Klaim root cause tanpa evidence (§53-54, §65).

---

## 12. CHECKLIST APPROVAL (satu "TIDAK" = revisi)

1. Deviasi Rp + arah delta terbaca <5 detik tanpa scroll (1440 & 375)?
2. Hanya SATU elemen dominan per layer (hero KPI di L2, resto #1 di L3)?
3. Merah/emerald/amber HANYA di data (kecuali identitas amber L0/hero)?
4. Tiap layer: eyebrow bernomor + h2 + anchor + `scroll-mt` benar?
5. Gap antar-layer ≥ 2× gap antar-kartu; L6 = band terpisah?
6. Semua KPI punya pembanding + akses rumus non-hover?
7. Ganti tab TIDAK me-remount L2-L5; ganti filter tidak me-reset tab?
8. Kaskade GROSS→W/S/T→NET masih terlihat (L2 strip / L5 Breakdown)?
9. h1→h2→h3 utuh; KPI = `<dl>`; tiap section ber-landmark?
10. `prefers-reduced-motion` matikan semua animasi dekoratif; nol anti-pattern §11?
11. Setiap angka naratif punya jalur drill-down ke record sumber (§63)?
12. Format angka satu konvensi koma-desimal di semua layer yang diangkat?

---

## 13. RENCANA IMPLEMENTASI (SETELAH APPROVAL — TANPA KODE SEKARANG)

Fase terpisah, tiap fase lolos 4 gerbang (tsc 0 err · vitest 446/446 · eslint 0 err ·
next build) + browser verification, commit per fase gaya `VH-1..n`:

- **VH-1 — Kerangka layer (struktur saja)**: `page.tsx` — pindahkan layer naratif keluar
  `<Tabs>`; buat `LayerHeader` + `PeriodLabel`; ritme spacing L2-L5; band L6. Komponen
  dipindah TANPA redesain kartu. File: page.tsx, shared/index.tsx (LayerHeader baru),
  DashboardTab.tsx (menyusut), ExecutiveSummary.tsx, DashboardHeader.tsx.
- **VH-2 — Tab strip 6/7 + migrasi modul antar tab**: AREA/HEATMAP/HISTORICAL dipromosikan;
  merge ITEM; keputusan D2-D4 dieksekusi; remap shortcut + visitedTabs; visited-tab gating
  untuk tab baru. File: page.tsx, tabs/*, AdvancedAnalysis, AreaItemHeatmap, dll.
- **VH-3 — Reskin sesuai token**: KPI 4-up + hero; L3 top-3 anatomy; L4 callout; L5 ringkas
  + expand; normalisasi format angka di semua komponen yang diangkat; badge Filter (n).
- **VH-4 — A11y + anchor + sticky tab strip + audit checklist §12** (browser verify
  1280/1440/375, heading order, dl semantics, reduced-motion).

> Catatan eksekusi (v1.0): fase dieksekusi dalam 3 gelombang — VH-IMP-1 = VH-1+VH-2
> (struktur + migrasi tab; 2 commit terpisah), VH-IMP-2 = VH-3 (reskin; 1 commit),
> VH-IMP-3 = VH-4 (a11y + verifikasi browser; 1 commit). ID worklog VH-IMP-* dipakai
> agar tidak bentrok dengan task riset VH-1-a/b/c/d + VH-2 yang sudah ada di worklog.

Estimasi dampak: ~15-20 file komponen + page.tsx; NOL perubahan API/DB/logika bisnis
(murni presentation layer); semua query key & cache tidak berubah.

---

## 14. CHANGELOG & KEPUTUSAN STATUS

- **v0.1 (DRAFT — riset)**: disusun dari (1) inventaris as-is VH-1-a/VH-1-b
  (`@5617faf`, file:line); (2) brief teori VH-1-d (Minto/Shneiderman/Few/IBCS/NN/g);
(3) pasal master context bisnis §36-67; (4) riset web 12 kueri VH-1-c (GoodData, DataCamp,
ThoughtSpot, ClearPoint, IEEE, IBCS/zebrabi/inforiver, NN/g, CFPB, Cedar, Eleken, dst.);
(5) temuan review UI/UX H-14-a/b. Menunggu: approval D1-D10 + konfirmasi struktur §3-§4.
- **v1.0 (APPROVED — eksekusi)**: user menyetujui keseluruhan rancangan ("kerjakan
  sekarang dengan no mistake"); D1-D10 diputuskan mengikuti rekomendasi (§8) + keputusan
  turunan: tab default = AREA. Dipromosikan ke repo sebagai
  `MASTER-CONTEXT-VISUAL-HIERARCHY.md`, dirujuk oleh `MASTER_CONTEXT.md`, diikat ke
  gerbang review setiap PR UI. Implementasi §13 dieksekusi (commit VH-1..VH-4).
