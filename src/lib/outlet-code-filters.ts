// ============================================================
//  resolveOutletCodeFilters — shared kelompok + PIC → outletCodes
//  --------------------------------------------------------
//  FIX (H-12 / boilerplate dedup): this function was copy-pasted in
//  6 routes (item-peer-comparison, item-trend-rank, item-anomali-outlets,
//  flip-ranking, flip-ranking/drilldown, price-effect) — 5 byte-identical
//  + 1 differing only in comments. All six now import THIS single
//  implementation — behavior identical, one place to maintain.
//
//  Resolves the kelompok + PIC dashboard filters into a single
//  combined outletCodes array:
//    - { codes: null, noMatch: false } when no filter is applied.
//    - { codes: string[], noMatch: false } when one or both filters resolve.
//    - { codes: null, noMatch: true } when a filter matches no outlets OR
//      the intersection of kelompok + PIC is empty.
//
//  Sentinel handling: both resolvers use ['__NO_MATCH__'] to signal that
//  the requested filter exists in the DB but maps to zero outlets. We treat
//  that as "noMatch: true" so the route returns an empty result early
//  instead of running a query that returns 0 rows.
// ============================================================
import { resolvePICOutletCodes } from '@/lib/pic-resolver';
import { resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';

export async function resolveOutletCodeFilters(
  kelompok: string | null,
  pic: string | null,
): Promise<{ codes: string[] | null; noMatch: boolean }> {
  const [kelompokCodes, picCodes] = await Promise.all([
    kelompok ? resolveKelompokOutletCodes(kelompok) : Promise.resolve<string[]>([]),
    resolvePICOutletCodes(pic),
  ]);

  // Normalize: empty array → null (no filter)
  const k = kelompokCodes && kelompokCodes.length > 0 ? kelompokCodes : null;
  const p = picCodes && picCodes.length > 0 ? picCodes : null;

  // Sentinel: __NO_MATCH__ means the filter exists but matches 0 outlets.
  if (k && k.length === 1 && k[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }
  if (p && p.length === 1 && p[0] === '__NO_MATCH__') {
    return { codes: null, noMatch: true };
  }

  // Both present → intersect (an outlet must match BOTH filters)
  if (k && p) {
    const pSet = new Set(p);
    const intersection = k.filter((c) => pSet.has(c));
    if (intersection.length === 0) {
      return { codes: null, noMatch: true };
    }
    return { codes: intersection, noMatch: false };
  }

  // Only one present — use it directly
  if (k) return { codes: k, noMatch: false };
  if (p) return { codes: p, noMatch: false };

  return { codes: null, noMatch: false };
}
