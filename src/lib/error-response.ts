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
 * In production: returns "Internal server error"
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
      error: isDev ? message : 'Internal server error',
    },
    { status },
  );
}
