// ============================================================
//  peer — fetchPeerComparison (section 8's peer wave)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:673-771).
//  PERF-AUDIT-1 (performance-checklist lens, addyosmani/agent-skills)
//  restructured the wave — see the PERF-AUDIT-1 notes below. Off/
//  failure still early-returns null; identical logger call on
//  failure.
//
//  PERF-AUDIT-1 — three findings from the performance-checklist
//  audit (measure-first lens; each verified against this codebase):
//    F2 (anti-pattern "sequential awaits when Promise.all would
//       work"): the three peer queries were awaited SERIALLY even
//       though only the targetRow GATE consumes q-peer-cmp's result
//       — q-peer-cmp-items / q-peer-topitems take the SAME resolved
//       targetCode and read NOTHING from each other. The wave is now
//       ONE Promise.all → cold wall time drops from sum(latency × 3)
//       to max(latency × 3) for the heaviest multi-CTE scans in the
//       export pipeline. Semantics preserved exactly: the targetRow
//       gate still gates the RETURN (degenerate target ⇒ null), the
//       non-fatal catch still swallows any rejection into null, and
//       every query input + cache key is byte-identical (no sv bump —
//       row shapes unchanged). Trade-off (accepted): when the target
//       has no records for the period (rare — the 404 guard already
//       ensures the scope has records), the two dependent queries now
//       run + cache even though their rows are never SERVED (the
//       return happens before the mapping). Bounded waste: those rows
//       sit under a key that can only be re-requested by the same
//       degenerate params, which always re-derive targetRow = missing
//       ⇒ null — they expire via the 30-min TTL unobserved.
//    F3 (cache what is expensive): the auto-target scan was the ONLY
//       heavy SQL in the export pipeline outside a q-* cache row — it
//       re-ran its GROUP BY on every route-cache-cold path (deploy-SHA
//       fork, sections change, TTL expiry) even while every other
//       query hit a warm q-* row. Now cached under 'q-peer-autotarget'
//       (listed in invalidateAnalysisCache — mutations kill it like
//       every other q-*). While wrapping it, the scan's inputs were
//       aligned to the NORMALIZED filterOpts (kelompok 'all' → null):
//       the old raw pass-through made a direct API call with
//       ?kelompok=all + no outlet filter scan `LEFT(SUBSTRING(code…),3)
//       = UPPER('all')` → 0 outlets → empty auto-target → the peer
//       section silently dropped, while every sibling query treated
//       'all' as no-filter. (FE-triggered exports are unaffected —
//       FilterBar's "Semua Kelompok" stores null, never 'all'.)
//    F1 (invalidation coverage — see invalidate.ts): 'q-peer-topitems'
//       was missing from the mutation invalidation list ⇒ the 8.3
//       rows could serve pre-mutation data up to 30 min after an
//       ingest. Fixed THERE; here the sv 4 → 5 bump flushes any row
//       that is stale RIGHT NOW (written pre-fix, pre-mutation).
// ============================================================
import {
  // REFINE-1: section 7 peer-to-peer (renamed "Resto dengan Penjualan
  // Kurang Lebih Sama") — outlet-level peers + per-item breakdown.
  queryPeerComparison,
  queryPeerComparisonItems,
  // PEERTOP-2-b: 8.3 — per-peer top items + cross-peer union.
  queryPeerTopItems,
} from '@/lib/queries';
import { cachedSharedQuery } from '@/lib/queries/query-cache';
import { withStatementTimeout, buildSqlFilters } from '@/lib/queries/shared';
import { logger } from '@/lib/logger';
import type { PeerItemRow, PeerTopItemRow, PeerComparisonData } from '../types';
import type { FetcherContext } from './context';

// ============================================================
//  REFINE-1 (section 'peer' — "Resto dengan Penjualan Kurang Lebih
//  Sama"): similar-sales peer comparison for ONE target outlet.
//  --------------------------------------------------------
//  Target resolution follows the Resto Analysis filter convention (the
//  frontend sends focusOutlet || outletCode as the `outlet` param): when
//  an outlet filter is active, THAT outlet is the target. When none is
//  active, the outlet with the largest ABS(nominalDeviasi) inside the
//  current filter scope is auto-picked so the section always has a
//  concrete target (labeled in the report — factual, not narrative).
//
//  Wave structure (PERF-AUDIT-1 F2/F3): the auto-target scan is the one
//  genuinely-serial step (the three peer queries take the RESOLVED
//  target code — a real input dependency), runs only without an outlet
//  filter, and is itself q-cached ('q-peer-autotarget'). The three peer
//  queries then fire as ONE parallel wave (≤2 sequential RTTs total,
//  only when the section is selected).
//  Non-fatal by design: a failure (or a target with no records) leaves
//  peerComparison = null → the builder renders a factual "data tidak
//  tersedia" note instead of killing the whole export.
//
//  SALES SECRECY (user request): sales nominals are NEVER put in the
//  payload for rendering — PeerComparisonRow carries them (query
//  output), but the builder only renders outlet/area/deviasi columns.
// ============================================================
export async function fetchPeerComparison(ctx: FetcherContext): Promise<PeerComparisonData | null> {
  const { month, filterOpts, picOutletCodes } = ctx;
  const { week, area, outletCode, kelompok } = ctx.params;
  const { needPeer } = ctx.gates;

  if (!needPeer) return null;
  try {
    const resolvedOutlet = outletCode && outletCode !== 'all' ? outletCode : null;
    let targetCode: string | null = resolvedOutlet;
    let autoTarget = false;
    if (!targetCode) {
      // PERF-AUDIT-1 F3: q-cached auto-target scan. The scan's ACTUAL
      // inputs are month/week/area/kelompok/picOutletCodes — outletCode
      // and itemName are deliberately nulled (the scan picks the target
      // from the WHOLE filter scope), so the cache key uses the same
      // nulled filter set: two exports differing only in item filter
      // share one scan row. filterOpts is already 'all'-normalized —
      // using it here also fixes the raw-kelompok pass-through noted in
      // the file header (a direct ?kelompok=all API call used to scan
      // for outlets whose code segment starts with 'ALL' → none → the
      // peer section silently dropped).
      const scanFilters = { ...filterOpts, outletCode: null, itemName: null };
      const topOutletRows = await cachedSharedQuery(
        'q-peer-autotarget',
        { month, week, filters: scanFilters },
        async () => {
          const scopeFilter = buildSqlFilters({
            area: area === 'all' ? null : area,
            kelompok: kelompok === 'all' ? null : kelompok,
            outletCode: null,
            itemName: null,
            picOutletCodes,
          });
          return withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string }>>`
            SELECT o.code as "outletCode"
            FROM "InventoryRecord" ir
            JOIN "Outlet" o ON ir."outletId" = o.id
            WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
              ${scopeFilter}
            GROUP BY o.code
            ORDER BY ABS(SUM(ir."nominalDeviasi")) DESC
            LIMIT 1
          `);
        },
      );
      if (topOutletRows.length > 0) {
        targetCode = topOutletRows[0].outletCode;
        autoTarget = true;
      }
    }
    if (targetCode) {
      const kelompokParam = kelompok && kelompok !== 'all' ? kelompok : null;
      // PERF-AUDIT-1 F2: ONE parallel wave — q-peer-cmp / q-peer-cmp-items
      // / q-peer-topitems have NO data dependency on each other (all take
      // the resolved targetCode; the old serial chain only used
      // q-peer-cmp's targetRow as a GATE, which is applied to the RETURN
      // below instead). Entry order kept (q-peer-cmp first) so a cold
      // cache warms rows in the same order as before.
      const [peerRes, itemsRes, topRes] = await Promise.all([
        cachedSharedQuery(
          'q-peer-cmp',
          { month, week, filters: filterOpts, extra: { target: targetCode, limit: 10 } },
          () => queryPeerComparison(targetCode as string, month, week, 'week', 10, kelompokParam),
        ),
        cachedSharedQuery(
          'q-peer-cmp-items',
          // REFINE-2: sv — row shape gained `satuan` (7.2's "Satuan"
          // column); see the q-variance note in ./record-guard.ts.
          { month, week, filters: filterOpts, extra: { target: targetCode, top: 8, sv: 2 } },
          () => queryPeerComparisonItems(targetCode as string, month, week, 'week', 8, kelompokParam),
        ),
        // PEERTOP-2-b — same cachedSharedQuery pattern as the two above.
        // limit 10 MUST match the queryPeerComparison call (limit 10) so
        // the peer band is EXACTLY the restos rendered in 8.1; topN 5
        // mirrors the FE card. Stays inside the same try → a failure
        // leaves peerComparison null (the whole fetch is already
        // non-fatal — nothing new to catch).
        // PEERTOP-R1: sv 1 → 2 — row shape changed (target gains
        // qtyDeviasi/itemRank/itemOutletCount, loses direction;
        // peerAvgAbsNominal → peerAvgAbsQty; +peerTopNames) so a stale
        // cached entry can never be served under the new contract.
        // PEERTOP-R2: sv 2 → 3 — row shape changed again (peerTopNames
        // → topDiNames: "Top di" kini TOP-3 nama resto by |nominal|,
        // target ikut bila masuk — user: "TOP DI ini isi top 3 aja
        // resto aja dan jika resto target termasuk masukan juga").
        // PEERTOP-R3 (user: "ada bug di rangking. misal resto target
        // 11/11 tapi juga muncul di top di"): topDiNames basis CHANGED
        // — kini RANK() yang sama dengan kolom Rangking (itemRank ≤ 3
        // di antara SEMUA outlet yang mencatat item; target muncul
        // persis ketika itemRank ≤ 3). sv 3 → 4 flushes stale pre-R3
        // rows under the unchanged key.
        // PERF-AUDIT-1 (F1): sv 4 → 5 — flushes rows written while the
        // 'q-peer-topitems' prefix was MISSING from
        // invalidateAnalysisCache() (pre-fix rows could be pre-mutation
        // stale: an ingest did not delete them). The prefix itself is
        // now listed — this bump only guarantees the very first
        // post-deploy read recomputes clean.
        cachedSharedQuery(
          'q-peer-topitems',
          { month, week, filters: filterOpts, extra: { target: targetCode, topN: 5, limit: 10, sv: 5 } },
          () => queryPeerTopItems(targetCode as string, month, week, 'week', 5, 10, kelompokParam),
        ),
      ]);
      const targetRow = peerRes.peers.find((p) => p.isTarget);
      // Only attach when the target actually has data in this period —
      // otherwise the peer set degenerates (see the target_fallback CTE in
      // peer-comparison.ts) and the section would mislead.
      // PERF-AUDIT-1 F2: the gate stays on the RETURN (not on the fetch
      // — see the trade-off note in the file header).
      if (targetRow) {
        // Per-item breakdown (target's top items vs the same items
        // averaged across the peer outlets). Averages cover non-target,
        // non-missing peers only.
        const items: PeerItemRow[] = itemsRes.items.map((g) => {
          const real = g.peers.filter((p) => !p.isTarget && !p.missing);
          const peerAvg = real.length > 0
            ? {
                qtyDeviasi: real.reduce((s, p) => s + p.qtyDeviasi, 0) / real.length,
                devBom: real.reduce((s, p) => s + p.devBom, 0) / real.length,
                nominal: real.reduce((s, p) => s + p.nominal, 0) / real.length,
              }
            : null;
          return { itemName: g.itemName, satuan: g.satuan ?? null, target: g.target, peerAvg, peerCount: real.length };
        });
        // 8.3 — cross-peer union, capped at 10 rows; rendered in the
        // server's sort order (rowBold not needed — the target is a
        // COLUMN here, not a row). Mapped WITHOUT sales values (SALES
        // SECRECY — the query rows carry none anyway).
        // PEERTOP-R2: topDiNames arrives PRE-COMPUTED by the query (the
        // TOP-3 resto names by |nominal| for the item — target included
        // when it ranks among them), so no code→name map is needed here
        // anymore; PEERTOP-R1's 8.4 removal already left perPeer unused
        // by the export pipeline.
        const topItems: PeerTopItemRow[] = topRes.items.slice(0, 10).map((u) => ({
          itemName: u.itemName,
          satuan: u.satuan ?? null,
          peerTopCount: u.peerTopCount,
          topDiNames: u.topDiNames,
          peerAvgAbsQty: u.peerAvgAbsQty,
          target: u.target,
        }));
        return {
          targetOutlet: { code: targetRow.outletCode, name: targetRow.outletName, area: targetRow.area },
          autoTarget,
          peers: peerRes.peers,
          items,
          // Empty array is fine — the PDF section code guards on length.
          topItems,
        };
      }
    }
    return null;
  } catch (e) {
    logger.error('[export-report] peer comparison failed:', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
