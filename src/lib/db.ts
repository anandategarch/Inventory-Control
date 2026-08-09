// ============================================================
//  DB — Prisma client with Turso (libsql) adapter
//  Lazy initialization + strict validation to surface config
//  problems clearly instead of the misleading
//  "URL_INVALID: The URL 'undefined' is not in a valid format".
// ============================================================
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';

let _db: PrismaClient | null = null;

/**
 * Environment resolution summary — populated on first client build.
 * Exposed for the /api/health/db diagnostic route.
 */
export type DbEnvStatus = {
  hasDatabaseUrl: boolean;
  databaseUrlScheme: string | null;   // "libsql" | "https" | "http" | "file" | null
  hasAuthToken: boolean;
  mode: 'turso' | 'local-sqlite' | 'uninitialised';
  warnings: string[];
};

let _envStatus: DbEnvStatus = {
  hasDatabaseUrl: false,
  databaseUrlScheme: null,
  hasAuthToken: false,
  mode: 'uninitialised',
  warnings: [],
};

export function getDbEnvStatus(): DbEnvStatus {
  return { ..._envStatus, warnings: [..._envStatus.warnings] };
}

function detectScheme(url: string): string | null {
  const m = url.match(/^([a-zA-Z]+):\/\//);
  return m ? m[1].toLowerCase() : null;
}

function createPrismaClient(): PrismaClient {
  const rawUrl = process.env.DATABASE_URL;
  const rawToken = process.env.DATABASE_AUTH_TOKEN;

  const dbUrl = (rawUrl ?? '').trim();
  const authToken = (rawToken ?? '').trim();

  const warnings: string[] = [];
  const scheme = dbUrl ? detectScheme(dbUrl) : null;

  _envStatus = {
    hasDatabaseUrl: dbUrl.length > 0,
    databaseUrlScheme: scheme,
    hasAuthToken: authToken.length > 0,
    mode: 'uninitialised',
    warnings,
  };

  // ---- 1. Hard fail when DATABASE_URL is missing in production ----
  if (!dbUrl) {
    const msg =
      '[db] DATABASE_URL is not set. ' +
      'Add it in your deployment platform (Vercel → Settings → Environment Variables), ' +
      'enable it for Production/Preview/Development, then redeploy.';
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    warnings.push(msg + ' Falling back to local SQLite for dev.');
    console.warn(msg);
    _envStatus.mode = 'local-sqlite';
    return new PrismaClient({ log: ['error', 'warn'] });
  }

  // ---- 2. Turso / remote libsql path ----
  if (scheme === 'libsql' || scheme === 'https' || scheme === 'http') {
    if (!authToken && scheme !== 'http') {
      const tokenMsg =
        '[db] DATABASE_URL points to a remote libsql/Turso endpoint but ' +
        'DATABASE_AUTH_TOKEN is empty. Requests will fail with 401. ' +
        'Add DATABASE_AUTH_TOKEN in Vercel env vars and redeploy.';
      warnings.push(tokenMsg);
      console.warn(tokenMsg);
    }

    console.log(
      `[db] Using Turso (libsql) adapter — scheme=${scheme}, authToken=${
        authToken ? 'present' : 'MISSING'
      }`,
    );
    const libsql = createClient({
      url: dbUrl,
      authToken: authToken || undefined,
    });
    const adapter = new PrismaLibSql(libsql);
    _envStatus.mode = 'turso';
    return new PrismaClient({ adapter, log: ['error', 'warn'] });
  }

  // ---- 3. Local SQLite via file:// ----
  if (scheme === 'file' || dbUrl.startsWith('file:')) {
    console.log('[db] Using local SQLite (file:) — DATABASE_URL scheme=file');
    _envStatus.mode = 'local-sqlite';
    return new PrismaClient({ log: ['error', 'warn'] });
  }

  // ---- 4. Anything else is a misconfiguration ----
  const unknownMsg =
    `[db] DATABASE_URL has an unsupported scheme "${scheme ?? '(none)'}". ` +
    'Expected one of: libsql://, https://, http://, file:. Got: ' +
    dbUrl.slice(0, 24) + (dbUrl.length > 24 ? '…' : '');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(unknownMsg);
  }
  warnings.push(unknownMsg);
  console.warn(unknownMsg);
  _envStatus.mode = 'local-sqlite';
  return new PrismaClient({ log: ['error', 'warn'] });
}

// Lazy getter — creates client on first use, not on module load.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!_db) {
      _db = createPrismaClient();
    }
    // @ts-ignore — proxy through to the underlying client
    return _db[prop];
  },
});
