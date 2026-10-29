// ============================================================
//  window-config — kebijakan jendela data
//  (PERF-FILTER3 / "3 BULAN" → HIST-WINDOW-5 / "5 BULAN")
//  --------------------------------------------------------
//  [RIWAYAT] PERF-FILTER3 ("3 BULAN", 22 Okt 2026): insiden
//  "Gagal Memuat Analisis" TIAP ganti filter (fan-out 6 endpoint
//  dengan jendela 12-24 bulan mendarat serentak di Supabase free
//  tier; waste-rate-league 504 di detik-60 — batas Hobby 60s yang
//  mengabaikan maxDuration route). User saat itu minta "hanya tarik
//  data 3 bulan terakhir dari filter terpilih agar ringan" →
//  jendela interaktif dipangkas ke 3 bulan; kartu merah padam.
//
//  [SEKARANG] HIST-WINDOW-5 (29 Okt 2026, opsi B pilihan user): 3 → 5.
//  Alasan: jendela 3 bulan membuat baseline z-score tab Historical
//  maksimal 2 bulan pembanding same-week (2 < HISTORICAL_MIN_WEEKS 4)
//  → kartu "Data historis belum cukup untuk Z-Score" menyala PERMANEN
//  untuk semua kombinasi bulan/minggu (terverifikasi produksi).
//  Dengan 5 bulan: bulan terpilih + 4 pembanding same-week → z-score
//  hidup dengan statistik benar. Kondisi yang membuat 5 bulan kini
//  aman (berbeda dari era insiden):
//    1. MIGRASI-REGION (25 Okt 2026): DB pindah sin1 → us-east-1,
//       RTT ke function Vercel iad1 turun ~230ms → ~1-3ms;
//       cold analysis terukur 25-41s → 1,7-3,1s.
//    2. HEATMAP-REMOVE: endpoint terberat (satu-satunya yang tidak
//       ter-gate stagger) sudah dihapus.
//    3. PERF-FILTER4 (gate stagger + klasifikasi retry by-code) tetap
//       aktif — fan-out ganti filter tetap dibatasi.
//  Derivat yang ikut melebar otomatis (semua baca konstanta ini):
//  WASTE_WINDOW_MONTHS, PEER_BAND_SCAN_WINDOW_MONTHS,
//  OUTLET_RECURRENCE_WINDOW_MONTHS, OUTLET_MONTHLY_SERIES_WINDOW_MONTHS,
//  slice trend run-queries, baseline fetch-records, dan cache key
//  `lb:` (auto-fork — row lama lb=3 tidak akan terbaca). Dua literal
//  pin terpisah disinkronkan manual + di-pin test:
//  WASTE_TOP_ITEMS_WINDOW_MONTHS, WASTE_RATE_LEAGUE_WINDOW_MONTHS.
//
//  Jalur /api/export-report (laporan PDF deep — sekali per klik,
//  UX progress sendiri, bukan sumber kartu merah) MEMPERTAHANKAN
//  jendela 12 bulan lewat parameter eksplisit DEEP_REPORT_WINDOW_MONTHS.
//
//  Catatan trade-off yang DISCLOSURE ke user: klasifikasi "kronis"
//  (butuh ≥6 bulan riwayat, WASTE_KRONIS_MIN_MONTHS) masih TIDAK bisa
//  terpicu di jendela 5 bulan — naikkan DASHBOARD_LOOKBACK_MONTHS ke 6
//  bila user ingin klasifikasi kronis kembali. Batas keras Hobby 60s
//  juga tetap ada: endpoint berat pertama-tama mengandalkan cache
//  q-* (TTL 30 menit) agar fan-out ganti filter tetap dingin-aman.
// ============================================================

/**
 * Jendela bulan untuk SEMUA endpoint interaktif — TERMASUK bulan terpilih.
 * PERF-FILTER3: 12 → 3 (22 Okt 2026). HIST-WINDOW-5: 3 → 5 (29 Okt 2026).
 */
export const DASHBOARD_LOOKBACK_MONTHS = 5;

/** Jendela bulan untuk jalur export-report (laporan PDF deep). */
export const DEEP_REPORT_WINDOW_MONTHS = 12;
