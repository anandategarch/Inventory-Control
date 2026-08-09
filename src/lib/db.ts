// ============================================================
//  DB — Prisma client singleton
//  Auto-create database file if it doesn't exist (for Railway/production)
// ============================================================
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

function ensureDatabaseExists() {
  const dbUrl = process.env.DATABASE_URL || 'file:./db/custom.db';
  // Extract file path from DATABASE_URL (format: file:./path/to/db)
  if (dbUrl.startsWith('file:')) {
    const dbPath = dbUrl.replace('file:', '').replace(/^\.\//, '');
    const fullPath = path.resolve(process.cwd(), dbPath);
    const dir = path.dirname(fullPath);
    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Create empty file if it doesn't exist (Prisma will create schema)
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, '');
    }
  }
}

try {
  ensureDatabaseExists();
} catch (e) {
  console.error('Failed to ensure database exists:', e);
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
