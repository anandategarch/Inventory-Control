// ============================================================
//  API Error Response Helpers — standardized pattern
//  All API routes should use these for consistent error handling
// ============================================================
import { NextResponse } from 'next/server';

export interface ApiErrorResponse {
  success: false;
  error: string;
  code: string;
}

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

// Standard error response
export function apiError(
  message: string,
  status: number = 500,
  code: string = 'INTERNAL_ERROR'
): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

// Standard success response
export function apiSuccess<T>(data: T, status: number = 200): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json({ success: true, data }, { status });
}

// Common error patterns
export const ApiErrors = {
  badRequest: (msg: string = 'Bad request') => apiError(msg, 400, 'BAD_REQUEST'),
  notFound: (msg: string = 'Not found') => apiError(msg, 404, 'NOT_FOUND'),
  internal: (msg: string = 'Internal server error') => apiError(msg, 500, 'INTERNAL_ERROR'),
  database: (msg: string) => apiError(`Database error: ${msg}`, 500, 'DATABASE_ERROR'),
};

// Wrap an async handler with standard error handling
export function withErrorHandler<T>(
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  return handler().catch((e: unknown) => {
    console.error('[API Error]', e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('no such table') || msg.includes('does not exist')) {
      return ApiErrors.database(msg);
    }
    return ApiErrors.internal(msg);
  });
}
