// ============================================================
//  Shared filter builder for raw SQL aggregate queries.
//  Used by all query modules in this directory:
//    dashboard.ts, items.ts, outlets.ts, areas.ts, historical.ts
// ============================================================
import { Prisma } from '@prisma/client';

// ============================================================
//  Build filter conditions for raw SQL (Prisma.sql fragments)
//  Returns an empty Prisma.sql fragment when no filters apply
//  (Prisma.join requires ≥1 element, so handle empty case explicitly)
// ============================================================
export function buildSqlFilters(opts: {
  area?: string | null;
  outletCode?: string | null;
  itemName?: string | null;
  picOutletCodes?: string[] | null;
}): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (opts.area) {
    parts.push(Prisma.sql`AND ir.area = ${opts.area}`);
  }
  if (opts.outletCode) {
    parts.push(Prisma.sql`AND ir."outletId" IN (SELECT id FROM "Outlet" WHERE code = ${opts.outletCode})`);
  }
  if (opts.picOutletCodes && opts.picOutletCodes.length > 0) {
    parts.push(Prisma.sql`AND ir."outletId" IN (SELECT id FROM "Outlet" WHERE code IN (${Prisma.join(opts.picOutletCodes)}))`);
  }
  if (opts.itemName) {
    parts.push(Prisma.sql`AND ir."itemId" IN (SELECT id FROM "Item" WHERE name LIKE ${'%' + opts.itemName + '%'})`);
  }
  // Prisma.join requires ≥1 element; return empty fragment when no filters
  if (parts.length === 0) return Prisma.sql``;
  if (parts.length === 1) return parts[0];
  return Prisma.join(parts, ' ');
}
