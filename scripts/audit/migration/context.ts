import type { Pool } from 'pg';

// ============================================================
//  context.ts — shared state + issue tracker for audit-migration
//  ---------------------------------------------------------
//  SPLIT-F (pure code motion): `issues`/`addIssue`/`OLD_REACHABLE`/
//  `TABLES` were module-level in the former single-file script.
//  They are unchanged except OLD_REACHABLE (a `let` boolean) is now
//  a field on the shared mutable `state` object so the entry's
//  connectivity ping can flip it and every check can read it —
//  identical read/write sequence to the original.
// ============================================================

export interface Issue {
  id: string;
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  finding: string;
  impact: string;
  fix: string;
}

// All 12 tables per task spec (note: schema.prisma also defines 12 models)
export const TABLES = [
  'SourceFile',
  'Week',
  'Outlet',
  'Item',
  'OutletPIC',
  'FileChunk',
  'AuditLog',
  'InventoryRecord',
  'OutletPeriodSales',
  'DQIssue',
  'Setting',
  'AggregationCache',
];

export function createMigrationAuditContext(oldPool: Pool, newPool: Pool) {
  const issues: Issue[] = [];
  // Track OLD DB reachability — if false, skip cross-DB checks.
  // The entry's connectivity ping flips this to false when OLD is down.
  const state = { oldReachable: true };
  function addIssue(id: string, severity: Issue['severity'], title: string, finding: string, impact: string, fix: string) {
    issues.push({ id, severity, title, finding, impact, fix });
  }
  return { oldPool, newPool, state, issues, addIssue };
}

export type MigrationAuditContext = ReturnType<typeof createMigrationAuditContext>;
