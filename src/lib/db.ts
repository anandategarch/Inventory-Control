// ============================================================
//  DB — Prisma client with Turso (libsql) adapter
//  Works with:
//    - Turso cloud (libsql://...) — for Vercel/Railway production
//    - Local SQLite (file:...) — for local dev
// ============================================================
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';

function createPrismaClient(): PrismaClient {
  const dbUrl = process.env.DATABASE_URL || 'file:./db/custom.db';

  // If Turso (libsql://), use adapter
  if (dbUrl.startsWith('libsql://') || dbUrl.startsWith('http://') || dbUrl.startsWith('https://')) {
    const libsql = createClient({
      url: dbUrl,
      authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    });
    const adapter = new PrismaLibSql(libsql);
    return new PrismaClient({ adapter, log: ['error', 'warn'] });
  }

  // Local SQLite (file:...) — standard Prisma
  return new PrismaClient({ log: ['error', 'warn'] });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
