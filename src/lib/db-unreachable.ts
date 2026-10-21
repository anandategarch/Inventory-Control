// ============================================================
//  DB-Unreachable detection (DBDOWN-1)
//  --------------------------------------------------------
//  Insiden produksi 21 Okt 2026: SELURUH API (status, analysis,
//  dst.) mengembalikan HTTP 500 "Gagal memproses permintaan"
//  setelah ~5,5 detik, di setiap percobaan. Root cause BUKAN bug
//  aplikasi: project Supabase (free tier) PAUSED setelah >7 hari
//  tanpa aktivitas (aktivitas terakhir ~9 Okt). Bukti probe:
//    • Wire-protocol ke pooler: FATAL XX000
//      "(ENOTFOUND) tenant/user postgres.<ref> not found"
//      (signature identik dengan tenant bogus — routing backend
//      project sudah tidak ada)
//    • DNS db.<ref>.supabase.co / <ref>.supabase.co: TIDAK ada
//      record sama sekali (saat aktif per worklog DB-SIZE-2 host
//      ini resolve AAAA)
//    • Probe Prisma lokal: PrismaClientInitializationError
//      "Can't reach database server at `<host>:<port>`" dalam
//      5034ms ≈ durasi 500 yang dilihat user di Vercel
//
//  Helper ini mengenali signature error "database tidak bisa
//  dijangkau" sehingga route bisa:
//    (a) mengembalikan pesan spesifik + flag dbUnreachable:true
//        (bukan 500 generik yang menyesatkan), dan
//    (b) frontend menampilkan panduan restore Supabase, bukan
//        "HTTP 500" tanpa arah (bug rantai: useStatus fallback
//        `e.message || HTTP n` — body API memakai field `error`).
// ============================================================

// Signature yang dicek terhadap error.message / String(error).
// Sengaja TIGHT — jangan samakan dengan:
//  • P2024 "Timed out fetching a new connection from the
//    connection pool" → pool exhaustion saat beban tinggi
//    (transient; DB tetap hidup — salah klaim "DB down")
//  • P2021/P2022 "table/database does not exist" → masalah
//    schema (branch EMPTY_STATE /api/status yang sudah ada)
//  • ECONNREFUSED/ETIMEDOUT telanjang → bisa berasal dari fetch
//    layanan EKSTERNAL (mis. Google Drive), bukan database —
//    salah klaim akan menunjuk user ke Supabase padahal bukan.
const DB_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  // Prisma P1001-class (PrismaClientInitializationError) — teks
  // persis dari probe produksi 21 Okt 2026:
  /can't reach database server/i,
  // Prisma P1002-class (connect attempt timed out):
  /database could not be reached/i,
  // Supavisor pooler raw (bila error lolos tanpa dibungkus Prisma):
  /tenant\/user [^\s]+ not found/i,
  // Kode error Prisma yang kadang ikut tercetak di message:
  /\bP1001\b/,
];

export function isDbUnreachable(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return DB_UNREACHABLE_PATTERNS.some((re) => re.test(message));
}

// Pesan kanonik (client-safe — tidak membocorkan host/schema internal).
// Prefix stabil "Database tidak dapat dijangkau" dipakai ErrorState
// (src/components/dashboard/shared/index.tsx) sebagai marker untuk
// cabang tampilan amber + tombol restore — JANGAN ubah prefix tanpa
// menyamakan marker di ErrorState.
export const DB_UNREACHABLE_MESSAGE =
  'Database tidak dapat dijangkau — server database tidak merespons. Jika memakai Supabase free tier, project otomatis berhenti (pause) setelah beberapa hari tanpa aktivitas. Buka supabase.com/dashboard → pilih project → Restore project (butuh beberapa menit), lalu tekan Coba Lagi.';
