// ============================================================
//  Error Response Helper (DS-13)
//  --------------------------------------------------------
//  Returns generic error message to client in production,
//  full error in development. Prevents DB schema/SQL leakage.
// ============================================================
import { NextResponse } from 'next/server';
import { logger } from './logger';

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
  return NextResponse.json(
    {
      success: false,
      error: isDev ? message : 'Gagal memproses permintaan',
    },
    { status },
  );
}
