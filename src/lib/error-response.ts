// ============================================================
//  Error Response Helper (DS-13)
//  --------------------------------------------------------
//  Returns generic error message to client in production,
//  full error in development. Prevents DB schema/SQL leakage.
// ============================================================
import { NextResponse } from 'next/server';
import { logger } from './logger';
import { isDbUnreachable, DB_UNREACHABLE_MESSAGE } from './db-unreachable';
import { classifyTransientDbError, collectErrorMessages, TRANSIENT_ERROR_MESSAGE } from './transient-db-error';

/**
 * Log error server-side + return generic 500 to client.
 * In production: returns "Gagal memproses permintaan"
 * (P23 D4: Indonesian — matches the 'Gagal …' convention of route-level
 * messages; D4 swept 12 route-level English 500s to the same phrasing)
 * In development: returns the actual error message (for debugging)
 */
export function errorResponse(
  error: unknown,
  context: string,
  status: number = 500,
): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[${context}] error`, { error: message });

  const isDev = process.env.NODE_ENV === 'development';

  // PERF-FILTER4: prioritas db-unreachable kini dicek atas SEMUA teks
  // error (message + cause-chain + Prisma meta) — P1001 yang tersembunyi
  // di error.cause dulunya lolos cabang ini dan jatuh ke 500 generik.
  const allMessages = collectErrorMessages(error);
  const dbDown = allMessages.some((m) => isDbUnreachable(m)) || isDbUnreachable(message);

  // FIX (DBDOWN-1): "database tidak bisa dijangkau" (mis. project Supabase
  // paused — insiden 21 Okt 2026) BUKAN bug aplikasi, dan 500 generik
  // "Gagal memproses permintaan" membuat user tidak tahu satu-satunya jalan
  // keluar: restore project dari dashboard Supabase. Kembalikan pesan
  // spesifik + flag dbUnreachable agar frontend menampilkan panduan restore.
  // Teks DB_UNREACHABLE_MESSAGE client-safe (tanpa host/schema internal);
  // detail mentah hanya ikut di development.
  if (dbDown) {
    return NextResponse.json(
      {
        success: false,
        dbUnreachable: true,
        error: DB_UNREACHABLE_MESSAGE,
        ...(isDev ? { detail: message } : {}),
      },
      { status },
    );
  }

  // FIX (RETRYABLE-1): error DB TRANSIENT (pool-timeout P2024, statement
  // timeout, koneksi terputus di tengah query) BUKAN bug — kondisinya
  // pulih dalam hitungan detik (khas tepat setelah Supabase restore /
  // beban paralel berat). Produksi dulu mengembalikan 500 generik
  // "Gagal memproses permintaan", dan retry useAnalysis hanya match
  // substring teks mentah ('connection', 'timeout', …) yang TIDAK PERNAH
  // sampai ke client di produksi → 0 auto-retry (insiden filter resto
  // 21 Okt 2026). Sekarang: pesan ramah + flag machine-readable
  // `retryable:true` + `errorClass` (client-safe) agar frontend tahu
  // kapan boleh mencoba ulang otomatis.
  // PERF-FILTER4: klasifikasi kini menerima ERROR OBJECT (bukan hanya teks)
  // — cek error.code (P2024/P2028/P2034, errno socket) + cause-chain.
  const transientClass = classifyTransientDbError(error);
  if (transientClass) {
    return NextResponse.json(
      {
        success: false,
        retryable: true,
        errorClass: transientClass,
        error: TRANSIENT_ERROR_MESSAGE,
        ...(isDev ? { detail: message } : {}),
      },
      { status },
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: isDev ? message : 'Gagal memproses permintaan',
    },
    { status },
  );
}
