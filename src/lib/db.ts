// ============================================================
//  DB — Prisma client (PostgreSQL / Supabase only)
//  Temuan #1 fix: removed Turso/SQLite/libsql adapter logic
//  schema.prisma is locked to postgresql provider — runtime must match.
//  If DATABASE_URL is not set or is file://, we error out (no silent fallback).
// ============================================================
import { PrismaClient } from '@prisma/client';

let _db: PrismaClient | null = null;

function createPrismaClient(): PrismaClient {
  const dbUrl = process.env.DATABASE_URL || '';

  if (!dbUrl) {
    console.error('[db] DATABASE_URL is not set!');
    throw new Error('DATABASE_URL is required (PostgreSQL/Supabase)');
  }

  // Accept only PostgreSQL URLs — schema.prisma is locked to postgresql provider
  if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
    console.log('[db] Using PostgreSQL (Supabase)');
    return new PrismaClient({ log: ['error', 'warn'] });
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
