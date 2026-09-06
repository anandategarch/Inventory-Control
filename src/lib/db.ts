// ============================================================
//  DB — Prisma client (PostgreSQL / Supabase only)
//  --------------------------------------------------------
//  PERF-FASE5-MEDIUM: switched from URL-based connection to
//  @prisma/adapter-pg for better connection management with
//  Supabase PgBouncer transaction pooler. The adapter handles
//  connection lifecycle more efficiently than URL params,
//  reducing pool exhaustion risk under concurrent load.
//
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
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { logger } from './logger';

function createPrismaClient(): PrismaClient {
  let dbUrl = process.env.DATABASE_URL || '';

  if (!dbUrl) {
    logger.error('DATABASE_URL is not set');
    throw new Error('DATABASE_URL is required (PostgreSQL/Supabase)');
  }

  // Accept only PostgreSQL URLs — schema.prisma is locked to postgresql provider
  if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
    logger.error('DATABASE_URL must start with postgresql:// or postgres://');
    throw new Error(`Invalid DATABASE_URL protocol. Expected postgresql:// or postgres://`);
  }

  // Auto-switch Supabase pooler from session mode (port 5432) to transaction mode (port 6543)
  if (dbUrl.includes('.pooler.supabase.com:5432/')) {
    dbUrl = dbUrl.replace('.pooler.supabase.com:5432/', '.pooler.supabase.com:6543/');
    logger.info('Using PostgreSQL (Supabase) — switched to transaction mode (port 6543)');
  } else {
    logger.info('Using PostgreSQL (Supabase)');
  }

  // PERF-FASE5-MEDIUM: Use PrismaPg adapter instead of URL-based connection.
  // The adapter uses pg.Pool under the hood with proper connection lifecycle
  // management. This is more efficient than URL params for PgBouncer transaction
  // mode — the adapter handles idle connection cleanup, reconnection, and
  // query queueing automatically.
  //
  // Connection params:
  // - max: 30 (match previous connection_limit — Supabase allows up to 200)
  // - idleTimeoutMillis: 20000 (20s — match previous idle_timeout)
  // - connectionTimeoutMillis: 60000 (60s — match previous pool_timeout)
  const pool = new Pool({
    connectionString: dbUrl,
    max: 30,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 60000,
  });

  const adapter = new PrismaPg(pool);

  const logQueries = process.env.PRISMA_LOG_QUERIES === 'true';
  const client = new PrismaClient({
    adapter,
    log: logQueries
      ? ['error', 'warn', { emit: 'stdout', level: 'query' }]
      : ['error', 'warn'],
  });

  logger.info('Prisma client created with @prisma/adapter-pg (pool max=30)');
  return client;
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
