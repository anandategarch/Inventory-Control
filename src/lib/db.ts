// ============================================================
//  DB — Prisma client with Turso (libsql) adapter
//  Lazy initialization to avoid reading env vars before they're ready
// ============================================================
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';

let _db: PrismaClient | null = null;

function createPrismaClient(): PrismaClient {
  const dbUrl = process.env.DATABASE_URL || '';
  const authToken = process.env.DATABASE_AUTH_TOKEN || '';

  if (!dbUrl) {
    console.error('[db] DATABASE_URL is not set! Falling back to local SQLite.');
    return new PrismaClient({ log: ['error', 'warn'] });
  }

  if (dbUrl.startsWith('libsql://') || dbUrl.startsWith('http://') || dbUrl.startsWith('https://')) {
    console.log('[db] Using Turso (libsql) adapter');
    const libsql = createClient({
      url: dbUrl,
      authToken: authToken || undefined,
    });
    const adapter = new PrismaLibSql(libsql);
    return new PrismaClient({ adapter, log: ['error', 'warn'] });
  }

  console.log('[db] Using local SQLite');
  return new PrismaClient({ log: ['error', 'warn'] });
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
