---
Task ID: SPLIT-G
Agent: full-stack-developer (context deadline tercapai sebelum pelaporan; diverifikasi & dilaporkan oleh Main)
Task: Split 4 komponen dashboard besar (TopGrowthCard 555, RestoAnalysis 551, PeerComparison 525, narrative/OutletPriorityPanel 527) menjadi folder modul — pure code motion, bagian batch SPLIT-2.

Work Log:
- Agent mengerjakan split namun sesi berakhir (context deadline) sebelum menulis laporan; hasilnya di working tree, diverifikasi ulang oleh Main.
- Struktur akhir (20 file baru, 4 file lama dihapus, 2.822 baris total):
  - `TopGrowthCard.tsx` 555 → `TopGrowthCard/`: index 252 + growth-row 148 + contributor 77 + empty-states 72 + period-legend 60 + format 59.
  - `RestoAnalysis.tsx` 551 → `RestoAnalysis/`: index 268 + profile-cards 132 + bahan-analysis-card 131 + outlet-header-card 85 + state-cards 82.
  - `PeerComparison.tsx` 525 → `PeerComparison/`: index 215 + use-peer-queries 256 + peer-table-card 184 + no-outlet-card 61.
  - `narrative/OutletPriorityPanel.tsx` 527 → `OutletPriorityPanel/`: index 219 + compact-row 172 + build-display-rows 136 + use-lens-data 151 + lens-model 62.
- `'use client'` terverifikasi di keempat index.tsx entry.
- Import path caller (`@/components/dashboard/<Nama>` dan `@/components/dashboard/narrative/OutletPriorityPanel`) resolve tanpa perubahan via folder index — dibuktikan tsc 0 error seluruh repo (page.tsx & parent panel tidak tersentuh; props signature kompatibel, kalau tidak tsc akan error).
- Verifikasi Main: tsc 0 err; eslint 0 err; vitest 512/512; tidak ada file yatim (semua subkomponen ter-import).
- Rekan sejenis `tabs/ItemTrendTab/ItemPeerComparison.tsx` (domain SPLIT-B, agent lain) tidak tersentuh sesuai batasan domain.

Stage Summary:
- 4 kartu dashboard (2.158 baris) → 20 file modul (index 215–268 + subkomponen/hook 59–256); props publik tidak berubah; caller tidak berubah.
- Gerbang: tsc 0 err · eslint 0 err · vitest 512/512.
- Catatan: tanpa verifikasi visual runtime (dev server proyek tidak berjalan di sesi ini); kompatibilitas props dibuktikan lewat tsc terhadap semua caller.
