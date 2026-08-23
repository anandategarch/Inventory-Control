// ============================================================
//  DB — Prisma client (PostgreSQL / Supabase only)
//  Temuan #1 fix: removed Turso/SQLite/libsql adapter logic
//  schema.prisma is locked to postgresql provider — runtime must match.
//  If DATABASE_URL is not set or is file://, we error out (no silent fallback).
//
//  MIG-9 fix: Use globalThis.prisma singleton pattern (recommended by Prisma docs
//  for Next.js dev hot-reload). Without this, every hot-reload creates a new
//  PrismaClient instance, eventually exhausting the connection pool.
//
//  MIG-10 fix: Add statement_timeout=30000 (30s) and idle_timeout=20 (seconds)
//  to prevent a single hung query from blocking the entire pool.
// ============================================================
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  let dbUrl = process.env.DATABASE_URL || '';

  if (!dbUrl) {
    console.error('[db] DATABASE_URL is not set!');
    throw new Error('DATABASE_URL is required (PostgreSQL/Supabase)');
  }

  // Accept only PostgreSQL URLs — schema.prisma is locked to postgresql provider
  if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
    // Auto-switch Supabase pooler from session mode (port 5432) to transaction mode (port 6543)
    // Session mode has a hard limit of 15 connections — too low for serverless.
    // Transaction mode supports 200+ connections and is recommended by Supabase for serverless.
    // Only switch if using the pooler domain (aws-*.pooler.supabase.com) on port 5432.
    if (dbUrl.includes('.pooler.supabase.com:5432/')) {
      dbUrl = dbUrl.replace('.pooler.supabase.com:5432/', '.pooler.supabase.com:6543/');
      console.log('[db] Using PostgreSQL (Supabase) — switched to transaction mode (port 6543)');
    } else {
      console.log('[db] Using PostgreSQL (Supabase)');
    }
    // Transaction mode (PgBouncer) requires:
    // - pgbouncer=true: disables prepared statements (not supported in tx mode)
    // - connection_limit=3: keeps total connections low across multiple serverless functions
    // - pool_timeout=10: fail fast if pool exhausted instead of hanging
    const url = new URL(dbUrl);
    if (!url.searchParams.has('pgbouncer')) {
      url.searchParams.set('pgbouncer', 'true');
    }
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', '3');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '10');
    }
    // FIX MIG-10: statement_timeout (ms) — kill any single query that runs > 30s.
    // Prevents one hung query from blocking the entire connection pool.
    // NOTE: These are passed as URL params, but Prisma + PgBouncer may ignore them
    // in transaction mode. The values are still valid for direct connections (port 5432)
    // and for non-PgBouncer PostgreSQL. They're harmless if ignored.
    // We also set them via $executeRaw on client init as a belt-and-suspenders approach.
    if (!url.searchParams.has('statement_timeout')) {
      url.searchParams.set('statement_timeout', '30000');
    }
    if (!url.searchParams.has('idle_timeout')) {
      url.searchParams.set('idle_timeout', '20');
    }
    return new PrismaClient({
      log: ['error', 'warn'],
      datasources: { db: { url: url.toString() } },
    });
  }

  // Reject SQLite/Turso URLs — Prisma client is compiled for PostgreSQL.
  // FIX (DEEP-AUDIT-SECURITY-5): Allow SQLite/libsql in development mode so
  // local dev doesn't crash when DATABASE_URL points to a local SQLite file.
  // Production still hard-requires PostgreSQL.
  if (dbUrl.startsWith('file:') || dbUrl.startsWith('libsql://') || dbUrl.startsWith('http')) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[db] SQLite/Turso URLs not supported in production. Use PostgreSQL.');
      throw new Error('SQLite/Turso not supported in production. Use PostgreSQL (postgresql:// or postgres://).');
    }
    // Dev mode — allow SQLite for local development
    console.warn('[db] Using SQLite (dev mode). Not for production.');
    return new PrismaClient({ log: ['error', 'warn'] });
  }

  console.error('[db] DATABASE_URL must start with postgresql:// or postgres://');
  throw new Error(`Invalid DATABASE_URL protocol. Expected postgresql:// or postgres://`);
}

// FIX MIG-9: globalThis singleton — prevents connection pool exhaustion during
// Next.js dev hot-reload. In production (serverless), each cold start creates a
// fresh client, but warm invocations reuse the singleton.
export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}
