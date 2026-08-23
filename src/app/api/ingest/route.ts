// ============================================================
//  /api/ingest — Excel/CSV ingestion endpoint
//  Refactored (Bug #6 fix): delegate to shared processIngestion in lib/ingestion.ts
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { processIngestion } from '@/lib/ingestion';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // FIX Phase 1: prevent Vercel timeout

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // Bug #10 fix: Rate limiting
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Ingestion adalah operasi berat, tunggu beberapa menit.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    const body = await req.json().catch(() => ({}));

    const results = await processIngestion(body);
    return NextResponse.json({ success: true, results, durationMs: Date.now() - startedAt });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // Bug 7 fix: call processIngestion directly (no NextRequest mock)
  // ImportSpeed: support ?fast=true query param to skip DQ validation during ingest.
  // Pure import — validation can be run separately later via /api/dq-check.
  const startedAt = Date.now();
  try {
    // FIX-A-2 (BUG-5-3): GET handler triggers BULK INGESTION (heavier than POST —
    // reads all .xlsx in DATA_DIR, parses, inserts). Without rate limiting, an
    // attacker can DoS by hammering GET /api/ingest?fast=true. Apply the same
    // rate limiter used by POST.
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Ingestion adalah operasi berat, tunggu beberapa menit.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    const fastMode = req.nextUrl.searchParams.get('fast') === 'true';
    const results = await processIngestion({}, fastMode);
    return NextResponse.json({ success: true, results, durationMs: Date.now() - startedAt, fastMode });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: (e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
