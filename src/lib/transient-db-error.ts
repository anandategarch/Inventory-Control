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
  // PERF-FILTER4 (25 Okt 2026): insiden "Gagal Memuat Analisis" periode
  // September WEEK 4 — fan-out 6 endpoint paralel memacu Supavisor, dan 3
  // endpoint mati pada ~54-58s dengan error yang TIDAK cocok pola manapun
  // di atas (body: {"error":"Gagal memproses permintaan"} tanpa retryable →
  // kartu MERAH permanen). Kelas baru yang lolos klasifikasi lama:
  //
  // Prisma P2034 — interactive transaction gagal karena koneksi underlying
  // putus di tengah transaksi / write conflict (teks: "Transaction failed
  // due to a write conflict or a connection failure"). Khas tepat saat
  // pooler kick koneksi saat jenuh:
  { re: /transaction failed due to a (?:write conflict|connection failure)/i, errorClass: 'connection-terminated' },
  // Node socket errno yang TIDAK memuat kalimat "connection ... by peer":
  // "read ECONNRESET" / "write ECONNRESET" / "connect ETIMEDOUT" /
  // "connect EPIPE" / "getaddrinfo EAI_AGAIN":
  { re: /\b(?:read|write) ECONNRESET\b/i, errorClass: 'connection-terminated' },
  { re: /\bECONNRESET\b/i, errorClass: 'connection-terminated' },
  { re: /\b(?:connect|read|write) ETIMEDOUT\b/i, errorClass: 'connection-terminated' },
  { re: /\bETIMEDOUT\b/i, errorClass: 'connection-terminated' },
  { re: /\bEPIPE\b/i, errorClass: 'connection-terminated' },
  { re: /\bECONNREFUSED\b/i, errorClass: 'connection-terminated' },
  { re: /\bEAI_AGAIN\b/i, errorClass: 'connection-terminated' },
  // Prisma engine socket-level init mid-session blip:
  { re: /socket connection timeout/i, errorClass: 'connection-terminated' },
];

// ============================================================
// PERF-FILTER4: klasifikasi by ERROR CODE + rantai cause.
// ------------------------------------------------------------
// Regex di atas hanya melihat `error.message`. Dua celah terbukti ikut
// bermain di insiden Sep-W4:
//   (1) Prisma error membawa KODE mesin (error.code = 'P2024' | 'P2028' |
//       'P2034') yang kadang TIDAK tercetak di message — atau tercetak
//       dalam bentuk yang tidak cocok regex (variasi antar versi engine).
//   (2) Error tingkat driver/undici membungkus penyebab aslinya di
//       `error.cause` (dan Prisma menaruh detail di `error.meta.cause`)
//       — message luarnya generik ("fetch failed" / "Error querying the
//       database: ..."), signature aslinya tersembunyi.
// Keduanya kini diperiksa SEBELUM regex message.
// ============================================================

// Kode Prisma yang pasti transient (mesin error-code resmi):
//   P2024 pool checkout timeout · P2028 interactive-transaction/query
//   timeout · P2034 transaction failed due to connection failure / write
//   conflict (koneksi diputus pooler di tengah transaksi).
const PRISMA_TRANSIENT_CODES: Readonly<Record<string, TransientErrorClass>> = {
  P2024: 'pool-timeout',
  P2028: 'statement-timeout',
  P2034: 'connection-terminated',
};

// Kode errno Node yang pasti network-level transient (muncul di .code
// untuk error syscall, dan/atau di teks message):
const SOCKET_TRANSIENT_CODES: Readonly<Record<string, TransientErrorClass>> = {
  ECONNRESET: 'connection-terminated',
  ETIMEDOUT: 'connection-terminated',
  EPIPE: 'connection-terminated',
  ECONNREFUSED: 'connection-terminated',
  EAI_AGAIN: 'connection-terminated',
};

/** Baca `.code` dari error (Prisma KnownRequestError / Node syscall). */
function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : null;
}

/**
 * Kumpulkan SEMUA teks pesan dari error: message + rantai .cause (≤3 level)
 * + Prisma `.meta.cause` / `.meta.message` bila string. Dipakai bersama
 * oleh classifyTransientDbError DAN errorResponse (prioritas
 * db-unreachable dicek dulu atas SEMUA teks — lihat error-response.ts).
 */
export function collectErrorMessages(error: unknown, maxDepth = 3): string[] {
  const out: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; cur && depth <= maxDepth; depth++) {
    if (typeof cur === 'string') {
      if (cur) out.push(cur);
      break;
    }
    if (typeof cur !== 'object') break;
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) out.push(msg);
    // Prisma: detail tambahan kadang di meta.cause / meta.message
    const meta = (cur as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object') {
      const metaCause = (meta as Record<string, unknown>).cause;
      if (typeof metaCause === 'string' && metaCause) out.push(metaCause);
      const metaMsg = (meta as Record<string, unknown>).message;
      if (typeof metaMsg === 'string' && metaMsg) out.push(metaMsg);
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * Klasifikasi error DB transient. Return kelas error (client-safe) bila
 * cocok, atau null bila bukan signature transient (error aplikasi biasa,
 * validasi, DB-down P1001/P1002, dsb. — biarkan penanganan yang sudah ada).
 *
 * PERF-FILTER4: urutan pemeriksaan —
 *   1. error.code (Prisma P-code / Node errno) — paling andal, kebal
 *      variasi teks message.
 *   2. SEMUA teks message + cause-chain (regex lama + pola baru).
 */
export function classifyTransientDbError(error: unknown): TransientErrorClass | null {
  if (!error) return null;

  // (1) Kode mesin — exact-match terhadap allowlist (bukan substring),
  // sehingga kode Node lain (ERR_INVALID_ARG_TYPE dsb.) TIDAK ikut
  // terklasifikasi transient.
  const code = readErrorCode(error);
  if (code) {
    const byPrismaCode = PRISMA_TRANSIENT_CODES[code];
    if (byPrismaCode) return byPrismaCode;
    const bySocketCode = SOCKET_TRANSIENT_CODES[code];
    if (bySocketCode) return bySocketCode;
  }

  // (2) Teks — message + cause chain + Prisma meta.
  const messages = collectErrorMessages(error);
  if (messages.length === 0) return null;
  for (const { re, errorClass } of TRANSIENT_DB_ERROR_PATTERNS) {
    for (const msg of messages) {
      if (re.test(msg)) return errorClass;
    }
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
