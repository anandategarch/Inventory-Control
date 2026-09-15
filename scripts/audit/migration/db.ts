import { Pool } from 'pg';

// ============================================================
//  db.ts — DB connection + query helper for audit-migration
//  ---------------------------------------------------------
//  SPLIT-F (pure code motion): `createPools` reproduces the two
//  `new Pool(...)` statements (verbatim config) that used to sit at
//  module level in the old script; `q` is unchanged.
// ============================================================

export function createPools(oldUrl: string, newUrl: string): { oldPool: Pool; newPool: Pool } {
  const oldPool = new Pool({ connectionString: oldUrl || 'postgresql://invalid.invalid:5432/none', connectionTimeoutMillis: 15000, max: 4 });
  const newPool = new Pool({ connectionString: newUrl, connectionTimeoutMillis: 15000, max: 4 });
  return { oldPool, newPool };
}

export async function q(pool: Pool, sql: string, params?: any[]) {
  const c = await pool.connect();
  try { return await c.query(sql, params); } finally { c.release(); }
}
