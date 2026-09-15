// ============================================================
//  ItemPeerComparison — Types
//  --------------------------------------------------------
//  SPLIT-B (pure move from ItemPeerComparison.tsx — no behavior
//  change). Types are defined LOCALLY (do NOT import from the
//  backend API route, which is being built in parallel by
//  another agent).
//  TODO: share types with backend once API is stable.
// ============================================================

/** One row in the item peer comparison (target + each peer outlet). */
export interface ItemPeerRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  qtyBom: number;
  /** Signed — negative = LOSS, positive = SURPLUS. */
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  /** Signed nominal deviation (negative = LOSS). */
  nominalDeviasi: number;
  /** Absolute nominal deviation — for sorting + scatter Y axis. */
  absNominalDeviasi: number;
  /** Signed Dev/BOM ratio (negative = LOSS ratio). Null when BOM=0. */
  devBom: number | null;
  /** LOSS / SURPLUS / NEUTRAL. */
  direction: string;
  isTarget: boolean;
}

/** Per-peer average object — emitted by the API. */
export interface ItemPeerAverages {
  qtyBom: number;
  absQtyDeviasi: number;
  absNominalDeviasi: number;
  devBom: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  lossOutlets: number;
  surplusOutlets: number;
}

/** Response shape of `/api/item-peer-comparison`.
 *  FIX (BUG-2-09): added optional `cached` + `stale` fields that the backend
 *  adds conditionally (SWR pattern from withCacheAndDedup). */
export interface ItemPeerComparisonResponse {
  success: boolean;
  item: { itemName: string };
  period: { month: string; week: string };
  target: ItemPeerRow | null;
  peers: ItemPeerRow[];
  peerAverages: ItemPeerAverages;
  autoSelected: boolean;
  durationMs: number;
  /** Backend adds these when the response came from cache (SWR pattern). */
  cached?: boolean;
  stale?: boolean;
}

export interface ItemPeerComparisonProps {
  itemName: string;
  month: string;
  week: string;
  /** From FilterBar outletCode — if set, the API uses this outlet as
   *  the target. If omitted, the API auto-selects the worst outlet. */
  targetOutletCode?: string | null;
  area?: string | null;
  kelompok?: string | null;
  pic?: string | null;
  /** Called when the user clicks a peer outlet row. The parent
   *  typically wires this to `setFocusOutlet(code)` which switches
   *  to the Resto Analysis tab with the clicked outlet focused. */
  onOutletClick?: (_outletCode: string) => void;
}
