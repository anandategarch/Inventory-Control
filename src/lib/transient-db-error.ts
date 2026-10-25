// ============================================================
//  Transient DB error classification (RETRYABLE-1)
//  --------------------------------------------------------
//  Insiden produksi 21 Okt 2026 (lanjutan DBDOWN-1): tepat
//  setelah project Supabase di-restore dari pause, dashboard
//  masih bisa menampilkan "Gagal Memuat Analisis /
//  Gagal memproses permintaan" (HTTP 500) saat user memfilter
//  resto. Chain of failure:
//    1. DB baru bangun (cache dingin) + Resto tab menembakkan
//       6 query berat BERSAMAAN → Prisma P2024 pool-timeout /
//       statement-timeout / koneksi terputus di tengah query.
//    2. errorResponse produksi menyembunyikan kelas error
//       ("Gagal memproses permintaan") → retry useAnalysis
//       yang match substring ('connection', 'timeout', …)
//       TIDAK PERNAH cocok di produksi → 0 auto-retry.
//    3. Query lain punya retry global (providers.tsx retry:1)
//       dan sembuh sendiri; HANYA /api/analysis (query utama
//       dashboard, pemilik ErrorState "Gagal Memuat Analisis")
//       yang mati permanen sampai user tekan Coba Lagi.
//
//  Helper ini mengenali signature error DB yang TRANSIENT
//  (DB tetap hidup — berbeda dari db-unreachable.ts yang
//  sengaja TIGHT mengecualikan P2024) sehingga errorResponse
//  bisa mengirim:
//    (a) pesan ramah yang menjelaskan kondisinya sementara,
//    (b) flag machine-readable `retryable: true` + `errorClass`
//        (client-safe — tanpa host/sql internal) agar frontend
//        bisa auto-retry.
// ============================================================

// Kelas error transient (machine-readable, client-safe).
export type TransientErrorClass =
  | 'pool-timeout' // Prisma P2024 — pool checkout timeout / PG max_connections
  | 'statement-timeout' // PG statement_timeout (query berat > batas)
  | 'connection-terminated'; // koneksi putus di tengah query (network blip / restart)

// Signature yang dicek terhadap error.message / String(error).
// URUTAN penting: cek isDbUnreachable (db-unreachable.ts) LEBIH DULU di
// errorResponse — P1001/P1002 adalah kondisi "DB down" (bukan transient),
// dan teks P1002 "could not be reached" tidak overlap dengan pattern di
// bawah (pattern di sini: "connection terminated", bukan "could not be
// reached" / "can't reach").
const TRANSIENT_DB_ERROR_PATTERNS: ReadonlyArray<{ re: RegExp; errorClass: TransientErrorClass }> = [
  // Prisma P2024 pool checkout timeout — teks persis produksi:
  { re: /timed out fetching a new connection from the connection pool/i, errorClass: 'pool-timeout' },
  // Kode P2024 kadang tercetak tanpa kalimat lengkapnya:
  { re: /\bP2024\b/, errorClass: 'pool-timeout' },
  // PG "sorry, too many clients already" (server max_connections):
  { re: /sorry, too many clients already/i, errorClass: 'pool-timeout' },
  // Supavisor/pooler client limit:
  { re: /max_connections|max_clients/i, errorClass: 'pool-timeout' },
  // PG statement_timeout (raw atau terbungkus PrismaClientKnownRequestError):
  { re: /canceling statement due to statement timeout/i, errorClass: 'statement-timeout' },
  { re: /canceling statement due to statement_timeout/i, errorClass: 'statement-timeout' },
  // Prisma interactive-transaction timeout ("Timed out during ... transaction"):
  { re: /timed out during.*transaction|transaction.*timed out/i, errorClass: 'statement-timeout' },
  // PERF-FILTER3 (22 Okt 2026): kelas lanjutan dari insiden "Gagal Memuat
  // Analisis / Gagal memproses permintaan" tiap ganti filter — fan-out 6
  // endpoint berat paralel menjenuhkan Supabase free tier, dan error yang
  // muncul (40-60 detik) TIDAK cocok pola manapun di atas → kartu MERAH
  // tanpa auto-retry. Pola baru:
  // Prisma P2028 — interactive-transaction/query timeout (withStatementTimeout
  // membungkus hampir semua query berat pipeline ini dengan $transaction):
  { re: /\bP2028\b/, errorClass: 'statement-timeout' },
  { re: /timed out during query execution|query execution timed out/i, errorClass: 'statement-timeout' },
  // Supavisor/Supabase pooler "connection pool exhausted" (menunggu slot
  // koneksi > batas waktu pooler):
  { re: /connection pool exhausted/i, errorClass: 'pool-timeout' },
  // PgBouncer-style "no more connections in pool":
  { re: /no more connections in pool/i, errorClass: 'pool-timeout' },
  // PG 53300 "remaining connection slots are reserved ..." (max_connections
  // server tercapai — teksnya TIDAK memuat "too many clients"):
  { re: /remaining connection slots are reserved/i, errorClass: 'pool-timeout' },
  // Koneksi terputus DI TENGAH query (bukan saat init — itu P1001/P1002,
  // milik db-unreachable). Terjadi saat network blip / DB restart / restore:
  { re: /connection terminated( unexpectedly| due to connection timeout)?/i, errorClass: 'connection-terminated' },
  { re: /connection closed unexpectedly/i, errorClass: 'connection-terminated' },
  // Network-level reset di tengah round-trip TLS serverless→DB (blip singkat):
  { re: /connection reset by peer/i, errorClass: 'connection-terminated' },
];

/**
 * Klasifikasi error DB transient. Return kelas error (client-safe) bila
 * cocok, atau null bila bukan signature transient (error aplikasi biasa,
 * validasi, DB-down P1001/P1002, dsb. — biarkan penanganan yang sudah ada).
 */
export function classifyTransientDbError(error: unknown): TransientErrorClass | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return null;
  for (const { re, errorClass } of TRANSIENT_DB_ERROR_PATTERNS) {
    if (re.test(message)) return errorClass;
  }
  return null;
}

// Pesan kanonik (client-safe — tidak membocorkan host/sql internal).
// Prefix stabil "Server database sedang sibuk" dipakai ErrorState
// (src/components/dashboard/shared/index.tsx) sebagai marker untuk cabang
// tampilan amber + hint "mencoba ulang biasanya berhasil" — JANGAN ubah
// prefix tanpa menyamakan marker di ErrorState.
export const TRANSIENT_ERROR_MESSAGE =
  'Server database sedang sibuk — permintaan bersamaan terlalu banyak atau koneksi sesaat terputus. Kondisi ini biasanya pulih dalam beberapa detik; sistem juga mencoba ulang otomatis. Tekan Coba Lagi bila masih gagal.';
