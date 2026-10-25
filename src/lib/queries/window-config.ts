// ============================================================
//  window-config — kebijakan jendela data (PERF-FILTER3 / "3 BULAN")
//  --------------------------------------------------------
//  Insiden produksi 22 Okt 2026 (lanjutan PERF-FILTER1/B2): user
//  melaporkan "Gagal Memuat Analisis / Gagal memproses permintaan"
//  TIAP KALI ganti filter. Reproduksi live (fan-out paralel 6
//  endpoint pada kombinasi filter baru — Juli 2026 W4):
//    - /api/analysis, waste-series, waste-top-items, pareto →
//      HTTP 500 generik pada detik 40-60 (error DB tak-terklasifikasi,
//      kemungkinan besar P2028 transaction-timeout / pooler-exhausted
//      yang TIDAK cocok pola transient-db-error manapun → kartu MERAH
//      tanpa auto-retry);
//    - /api/waste-rate-league → HTTP 504 FUNCTION_INVOCATION_TIMEOUT
//      tepat di detik ke-60 (batas plan Hobby — maxDuration=120 di
//      route DIABAIKAN platform).
//  Akar beban: endpoint interaktif menjalankan scan national
//  (344 outlet) dengan jendela 12-24 BULAN + trend/historical
//  TANPA batas bulan — 6 endpoint seperti itu mendarat bersamaan
//  di Supabase free tier (2 shared vCPU) tiap ganti filter.
//
//  Permintaan user: "bisa gak diganti sekarang hanya tarik data
//  3 bulan terakhir dari filter terpilih agar ringan?"
//  → Jendela INTERAKTIF (dashboard, Resto tab, Waste tab) kini
//    = bulan terpilih + 2 bulan sebelumnya.
//
//  Jalur /api/export-report (laporan PDF deep — sekali per klik,
//  UX progress sendiri, bukan sumber kartu merah) MEMPERTAHANKAN
//  jendela 12 bulan lewat parameter eksplisit DEEP_REPORT_WINDOW_MONTHS.
//
//  Catatan trade-off yang DISCLOSURE ke user: klasifikasi "kronis"
//  (butuh ≥6 bulan riwayat, WASTE_KRONIS_MIN_MONTHS) tidak akan
//  menandai item di jendela 3 bulan; naikkan DASHBOARD_LOOKBACK_MONTHS
//  ke 6 bila user ingin klasifikasi kronis kembali.
// ============================================================

/** Jendela bulan untuk SEMUA endpoint interaktif — TERMASUK bulan terpilih. */
export const DASHBOARD_LOOKBACK_MONTHS = 3;

/** Jendela bulan untuk jalur export-report (laporan PDF deep). */
export const DEEP_REPORT_WINDOW_MONTHS = 12;
