// ============================================================
//  DB — Prisma client (PostgreSQL / Supabase only)
//  Temuan #1 fix: removed Turso/SQLite/libsql adapter logic
//  schema.prisma is locked to postgresql provider — runtime must match.
//  If DATABASE_URL is not set or is file://, we error out (no silent fallback).
// ============================================================
import { PrismaClient } from '@prisma/client';

let _db: PrismaClient | null = null;

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
    return new PrismaClient({
      log: ['error', 'warn'],
      datasources: { db: { url: url.toString() } },
    });
  }

  // Reject SQLite/Turso URLs — Prisma client is compiled for PostgreSQL
  if (dbUrl.startsWith('libsql://') || dbUrl.startsWith('file:') || dbUrl.startsWith('http')) {
    console.error('[db] SQLite/Turso URLs are no longer supported. Schema is locked to PostgreSQL.');
    throw new Error('DATABASE_URL must be PostgreSQL (postgresql:// or postgres://). SQLite/Turso not supported.');
  }

  console.error('[db] DATABASE_URL must start with postgresql:// or postgres://');
  throw new Error(`Invalid DATABASE_URL protocol. Expected postgresql:// or postgres://`);
}

// Lazy getter — creates client on first use, not on module load
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!_db) {
      _db = createPrismaClient();
    }
    // @ts-ignore
    return _db[prop];
  },
});
