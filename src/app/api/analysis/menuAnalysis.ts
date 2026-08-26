// ============================================================
//  ANALYSIS API — P2-1: Menu / BOM Relationship Analysis
//  Since we don't have explicit menu master data, we INFER menu
//  groups from item-name prefixes (e.g. "MIE", "AYAM", "UDANG",
//  "CABAI", "BAWANG"). For each group we compute:
//    - totalDeviation: sum of |nominalDeviasi| across items in the group
//    - items: per-item contribution (top 5)
//    - outliers: items whose deviation > 3× the group average
//  Returns the top 10 groups sorted by totalDeviation desc.
// ============================================================
import type { AggRow } from './types';

export interface MenuGroupItem {
  itemName: string;
  outletCode: string;
  absNominal: number;
  direction: string | null;
}

export interface MenuGroupOutlier {
  itemName: string;
  outletCode: string;
  absNominal: number;
  /** Multiple of group average (e.g. 3.5 = 3.5× the group avg) */
  multipleOfAvg: number;
}

export interface MenuGroup {
  /** Inferred prefix (uppercase, e.g. "MIE", "AYAM") */
  prefix: string;
  /** Number of distinct item-outlet rows in this group */
  itemCount: number;
  /** Total |nominalDeviasi| across the group */
  totalDeviation: number;
  /** Average |nominalDeviasi| per item-outlet row */
  avgDeviation: number;
  /** Top 5 contributing items (by |nominalDeviasi| desc) */
  items: MenuGroupItem[];
  /** Items whose |nominalDeviasi| > 3× group average */
  outliers: MenuGroupOutlier[];
}

// Common Indonesian F&B ingredient prefix keywords (uppercase, word-boundary).
// Items whose name starts with one of these (case-insensitive) get grouped.
const KNOWN_PREFIXES = [
  'MIE', 'AYAM', 'UDANG', 'CABAI', 'BAWANG', 'BERAS', 'GULA', 'MINYAK',
  'TELUR', 'DAGING', 'IKAN', 'SAPI', 'KENTANG', 'WORTEL', 'JAGUNG',
  'TOMAT', 'KEJU', 'SUSU', 'KOPI', 'TEH', 'JUS', 'SOSIS', 'NASI',
  'BOLA', 'PESTO', 'SAUS', 'MAYONAISE', 'TULANG', 'CUMI', 'BAKAR',
  'GORENG', 'CRISPY', 'FROZEN', 'KECAP', 'COKLAT', 'VANILLA', 'STRAWBERRY',
  'PISANG', 'APEL', 'MELON', 'LEMON', 'JERUK', 'NANAS', 'ALPUKAT',
];

/**
 * Determine which prefix (if any) an item name matches. Returns the first
 * matching known prefix (uppercase), or null when no known prefix matches.
 * FIX L2: Match only at START of string (not anywhere in the name).
 */
function matchPrefix(itemName: string): string | null {
  if (!itemName) return null;
  const upper = itemName.toUpperCase();
  for (const p of KNOWN_PREFIXES) {
    // Match at start of string followed by word boundary, space, or slash
    if (upper.startsWith(p) && (upper.length === p.length || /[\s/]/.test(upper[p.length]))) {
      return p;
    }
  }
  return null;
}

/**
 * Compute menu-group analysis from the in-memory AggRow[] stream.
 * Pure function — no SQL, no IO. Returns top 10 groups by totalDeviation.
 */
export function computeMenuAnalysis(rows: AggRow[]): MenuGroup[] {
  // Group by prefix
  const groups = new Map<string, MenuGroupItem[]>();
  for (const r of rows) {
    const prefix = matchPrefix(r.itemName);
    if (!prefix) continue;
    const absNominal = Math.abs(r.nominalDeviasi || 0);
    if (absNominal === 0) continue; // skip zero-deviation rows
    const list = groups.get(prefix) || [];
    list.push({
      itemName: r.itemName,
      outletCode: r.outletCode,
      absNominal,
      direction: r.direction,
    });
    groups.set(prefix, list);
  }

  const result: MenuGroup[] = [];
  for (const [prefix, items] of groups) {
    const totalDeviation = items.reduce((s, i) => s + i.absNominal, 0);
    const avgDeviation = items.length > 0 ? totalDeviation / items.length : 0;
    // Top 5 contributing items
    const topItems = [...items]
      .sort((a, b) => b.absNominal - a.absNominal)
      .slice(0, 5);
    // Outliers: |deviation| > 3× group average
    const outliers: MenuGroupOutlier[] = avgDeviation > 0
      ? items
          .filter((i) => i.absNominal > 3 * avgDeviation)
          .map((i) => ({
            itemName: i.itemName,
            outletCode: i.outletCode,
            absNominal: i.absNominal,
            multipleOfAvg: avgDeviation > 0 ? i.absNominal / avgDeviation : 0,
          }))
          .sort((a, b) => b.multipleOfAvg - a.multipleOfAvg)
          .slice(0, 5)
      : [];

    result.push({
      prefix,
      itemCount: items.length,
      totalDeviation,
      avgDeviation,
      items: topItems,
      outliers,
    });
  }

  // Sort by totalDeviation DESC, take top 10
  return result.sort((a, b) => b.totalDeviation - a.totalDeviation).slice(0, 10);
}
