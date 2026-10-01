// GODSPLIT-W1-A: split dari monolithic validation.ts (483 LOC) — barrel
// re-export menjaga public API `@/lib/validation`; 43 importer + test
// tidak berubah.
//
// Struktur (semua kode & komentar FIX dipindah VERBATIM dari file lama):
//   shared.ts   — 11 atom schema bersama (noControlChars, month/week/
//                 outlet/item/area/pic/compareWeek/kelompok/limit/cursor)
//                 + helper validateQuery / validateBody
//   analysis.ts — /api/analysis, drilldown, outlet-items, item-history,
//                 recommendations, pareto, change-analysis ×2,
//                 area-item-heatmap, item-trend
//   peer.ts     — /api/peer-comparison ×4, peer-track-record,
//                 benchmark-opportunity
//   waste.ts    — /api/waste-series, waste-top-items, waste-peer-zscore,
//                 outlet-monthly-series (jendela multi-bulan DEEP-RESTO-1)
//   export.ts   — /api/export-report (+ EXPORT_SECTION_KEYS private)
//   settings.ts — /api/settings POST
//   upload.ts   — /api/ingest, ingest-upload, ingest-process ×2,
//                 import-drive
//   misc.ts     — /api/pic ×2, data ×2, migrate-direction, status
export * from './shared';
export * from './analysis';
export * from './peer';
export * from './waste';
export * from './export';
export * from './settings';
export * from './upload';
export * from './misc';
