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
import { logger } from './logger';

function createPrismaClient(): PrismaClient {
  let dbUrl = process.env.DATABASE_URL || '';

  if (!dbUrl) {
    logger.error('DATABASE_URL is not set');
    throw new Error('DATABASE_URL is required (PostgreSQL/Supabase)');
  }

  // Accept only PostgreSQL URLs — schema.prisma is locked to postgresql provider
  if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
    // Auto-switch Supabase pooler from session mode (port 5432) to transaction mode (port 6543)
    if (dbUrl.includes('.pooler.supabase.com:5432/')) {
      dbUrl = dbUrl.replace('.pooler.supabase.com:5432/', '.pooler.supabase.com:6543/');
      logger.info('Using PostgreSQL (Supabase) — switched to transaction mode (port 6543)');
    } else {
      logger.info('Using PostgreSQL (Supabase)');
    }
    const url = new URL(dbUrl);
    if (!url.searchParams.has('pgbouncer')) url.searchParams.set('pgbouncer', 'true');
    // FIX (DEEP-AUDIT-ZEROS): FORCE connection_limit + pool_timeout — do NOT
    // check if already set. The .env file includes `connection_limit=3&pool_timeout=10`
    // which is too low for the analysis route (20+ parallel queries).
    // FIX (BUG6-POOL): increased from 10→20 because /api/analysis has 6 concurrent
    // withStatementTimeout calls per request (each holds a connection). With 2
    // concurrent users = 12 connections → pool exhaustion with limit=10.
    // Supabase transaction pooler allows up to 200 concurrent connections.
    url.searchParams.set('connection_limit', '20');
    url.searchParams.set('pool_timeout', '60');
    // FIX MIG-10: statement_timeout stripped by PgBouncer; see withStatementTimeout() for real enforcement.
    url.searchParams.set('statement_timeout', '30000');
    url.searchParams.set('idle_timeout', '20');
    return new PrismaClient({
      log: ['error', 'warn'],
      datasources: { db: { url: url.toString() } },
    });
  }

  // FIX AUDIT-7 #5: Removed non-functional SQLite dev fallback.
  // schema.prisma locks provider = "postgresql" — PrismaClient cannot connect
  // to SQLite. The fallback was dead code that crashed on first query.
  logger.error('DATABASE_URL must start with postgresql:// or postgres://');
  throw new Error(`Invalid DATABASE_URL protocol. Expected postgresql:// or postgres://`);
}

// FIX MIG-9: globalThis singleton — prevents connection pool exhaustion during
// Next.js dev hot-reload. In production (serverless), each cold start creates a
// fresh client, but warm invocations reuse the singleton.
//
// FIX M6 (AUDIT-7): Use lazy Proxy pattern — defers PrismaClient creation until
// first method call. This prevents crash at import time if DATABASE_URL is not
// set (e.g., during build step or lint). The singleton is stored on globalThis
// so hot-reload doesn't create a new client.
let _db: PrismaClient | null = null;

function getDb(): PrismaClient {
  if (!_db) {
    _db = createPrismaClient();
    // Store on globalThis for dev hot-reload reuse
    if (process.env.NODE_ENV !== 'production') {
      (globalThis as unknown as { prisma: PrismaClient | undefined }).prisma = _db;
    }
  }
  return _db;
}

// Check if we already have a singleton on globalThis (dev hot-reload reuse)
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
if (globalForPrisma.prisma && process.env.NODE_ENV !== 'production') {
  _db = globalForPrisma.prisma;
}

// Lazy Proxy — creates client on first use, not on module load.
// This avoids crashing at import time if DATABASE_URL is missing.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getDb();
    // @ts-ignore — Proxy intercepts all property access
    return client[prop];
  },
});
