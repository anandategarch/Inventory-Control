// ============================================================
//  peer — fetchPeerComparison (section 8's serial dependent wave)
//  --------------------------------------------------------
//  SPLIT-A (pure code motion): relocated VERBATIM from
//  fetchReportData's body (data-fetcher.ts:673-771) — the one
//  intentionally-serial wave in the pipeline. Off/failure now
//  early-returns null instead of leaving a `let` at null —
//  identical outcomes, identical query order, identical logger
//  call on failure.
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
//  Dependent fetch (AFTER the Promise.all): the auto-target needs its
//  own scan, and the peer queries take the resolved target code —
//  this is the one intentionally-serial wave in the pipeline (≤4 extra
//  RTTs, only when the section is selected).
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
      const scopeFilter = buildSqlFilters({
        area: area === 'all' ? null : area,
        kelompok,
        outletCode: null,
        itemName: null,
        picOutletCodes,
      });
      const topOutletRows = await withStatementTimeout((tx) => tx.$queryRaw<Array<{ outletCode: string }>>`
          SELECT o.code as "outletCode"
          FROM "InventoryRecord" ir
          JOIN "Outlet" o ON ir."outletId" = o.id
          WHERE ir."monthLabel" = ${month} AND ir."weekLabel" = ${week}
            ${scopeFilter}
          GROUP BY o.code
          ORDER BY ABS(SUM(ir."nominalDeviasi")) DESC
          LIMIT 1
        `);
      if (topOutletRows.length > 0) {
        targetCode = topOutletRows[0].outletCode;
        autoTarget = true;
      }
    }
    if (targetCode) {
      const kelompokParam = kelompok && kelompok !== 'all' ? kelompok : null;
      const peerRes = await cachedSharedQuery(
        'q-peer-cmp',
        { month, week, filters: filterOpts, extra: { target: targetCode, limit: 10 } },
        () => queryPeerComparison(targetCode as string, month, week, 'week', 10, kelompokParam),
      );
      const targetRow = peerRes.peers.find((p) => p.isTarget);
      // Only attach when the target actually has data in this period —
      // otherwise the peer set degenerates (see the target_fallback CTE in
      // peer-comparison.ts) and the section would mislead.
      if (targetRow) {
        // Per-item breakdown (target's top items vs the same items
        // averaged across the peer outlets). Averages cover non-target,
        // non-missing peers only.
        const itemsRes = await cachedSharedQuery(
          'q-peer-cmp-items',
          // REFINE-2: sv — row shape gained `satuan` (7.2's "Satuan"
          // column); see the q-variance note in ./record-guard.ts.
          { month, week, filters: filterOpts, extra: { target: targetCode, top: 8, sv: 2 } },
          () => queryPeerComparisonItems(targetCode as string, month, week, 'week', 8, kelompokParam),
        );
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
        // PEERTOP-2-b — third dependent call, same cachedSharedQuery
        // pattern as the two above. limit 10 MUST match the
        // queryPeerComparison call (limit 10) so the peer band is
        // EXACTLY the restos rendered in 8.1; topN 5 mirrors the FE
        // card. Stays inside the same try → a failure leaves
        // peerComparison null (the whole fetch is already non-fatal —
        // nothing new to catch).
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
        const topRes = await cachedSharedQuery(
          'q-peer-topitems',
          { month, week, filters: filterOpts, extra: { target: targetCode, topN: 5, limit: 10, sv: 4 } },
          () => queryPeerTopItems(targetCode as string, month, week, 'week', 5, 10, kelompokParam),
        );
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
