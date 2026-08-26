# Task: UI-TERMS-EXPLAIN — Revert display text to data terms + expand FormulaInfo tooltips

## Summary
Reverted simplified Indonesian UI terms back to actual Turso/Excel data terms across 9 files, and expanded all 16 FormulaInfo components with structured 4-section explanations (UNTUK APA / CARA BACA / CONTOH / ACTION).

## Files Edited (9)
1. `src/components/dashboard/ExecutiveSummary.tsx` — KPI labels, secondary cards, category labels/descriptions, financial impact summary
2. `src/components/dashboard/Charts.tsx` — All 4 FormulaInfo expanded; chart data names, legend names, axis labels updated to data terms
3. `src/components/dashboard/TopItems.tsx` — All 3 FormulaInfo expanded; card titles, table headers updated
4. `src/components/dashboard/AdvancedAnalysis.tsx` — All 4 FormulaInfo expanded; table headers updated
5. `src/components/dashboard/CostAccounting.tsx` — All 5 FormulaInfo expanded; chart data keys, axis labels, quadrant descriptions updated
6. `src/components/dashboard/CardDrillDown.tsx` — All 10 card titles + column labels updated to data terms
7. `src/components/drilldown/DrillDownDrawer.tsx` — Table headers + derived metric labels updated; directionLabel returns raw data term
8. `src/components/drilldown/SourceDataModal.tsx` — CSV headers + table headers updated to data terms

## Files Verified (no changes needed)
- `src/components/dashboard/Narrative.tsx` — Uses only analysis-specific terms (Narasi Otomatis, Rekomendasi, ALASAN, YANG PERLU DICEK)
- `src/app/page.tsx` — Only analysis section headings (Ringkasan Utama, Kondisi & Peringatan, Item Prioritas, Analisis Mendalam, Daftar Investigasi, Analisis Cost Accounting)
- `src/components/dashboard/FormulaInfo.tsx` — Component definition, no display text to change

## Term Mapping Applied
| Simplified (previous) | Data Term (now) |
|---|---|
| Selisih | DEVIASI |
| Nilai Selisih | NOMINAL DEVIASI |
| Jumlah Selisih | QTY DEVIASI |
| Standar Bahan | QTY BOM |
| Pemakaian Aktual | QTY COM |
| Lebih Pakai | LOSS |
| Hemat | SURPLUS |
| Tidak Terjelaskan | RESIDUAL |
| Limbah | WASTE |
| Susut | SUSUT |
| Uji Coba | TRIAL |
| Persen Selisih | % DEV TO BOM |
| Penjualan | PENJUALAN |
| Batas Toleransi | % TOLERANSI |
| Total Lebih Pakai | Total LOSS |
| Total Hemat | Total SURPLUS |
| Item | NAMA BAHAN |
| Outlet (table context) | RESTO |
| Dir / Arah | DIR / DIRECTION |

## FormulaInfo 4-Section Format
Every FormulaInfo now includes all 4 sections in the description prop (using \n line breaks):
- **UNTUK APA:** Purpose of the metric
- **CARA BACA:** How to interpret
- **CONTOH:** Concrete example with numbers
- **ACTION:** What to do with the information

## Code Preservation
- Variable names, API field references, DB column refs unchanged
- Direction string VALUES in code ('LOSS', 'SURPLUS', 'NEUTRAL') kept as-is
- Object keys in CARD_CONFIG (state keys) unchanged
- Category keys in CATEGORY_LABELS (API identifiers) unchanged
- Component/function names unchanged

## Verification
- ESLint: 0 errors, 20 warnings (all pre-existing, none from new edits)
- TypeScript (npx tsc --noEmit --skipLibCheck): 0 errors
- dev.log: clean (no compilation errors)
