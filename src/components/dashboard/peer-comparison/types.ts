// ============================================================
//  Peer Comparison — shared types
// ============================================================

/** One row in the peer comparison table (target + each peer outlet). */
export interface PeerRow {
  outletCode: string;
  outletName: string;
  area: string;
  pic: string | null;
  sales: number;
  nominalDeviasi: number;
  devBom: number;
  qtyBom: number;
  qtyDeviasi: number;
  qtyWaste: number;
  qtySusut: number;
  qtyTrial: number;
  qtyLossSurplus: number;
  totalLoss: number;
  totalSurplus: number;
  residualQty: number;
  itemCount: number;
  topItem: string | null;
  topItemNominal: number;
  direction: string;
  isTarget: boolean;
}

/** Definition of one comparable metric column in the peer table. */
export interface MetricDef {
  key: keyof PeerRow;
  label: string;
  format: (v: number) => string;
  higherBetter: boolean;
}

/** Response shape of `/api/peer-comparison/items` (Feature 3). */
export interface ItemComparisonResponse {
  success: boolean;
  error?: string;
  items: Array<{
    itemId: number;
    itemName: string;
    target: { qtyDeviasi: number; devBom: number; nominal: number };
    peerAvg: { qtyDeviasi: number; devBom: number; nominal: number };
    peerBest: { qtyDeviasi: number; devBom: number; nominal: number };
    gap: { qtyDeviasi: number; devBom: number; nominal: number; nominalPctAboveBest: number };
    peerCount: number;
    peers: Array<{
      outletCode: string;
      outletName: string;
      isTarget: boolean;
      qtyDeviasi: number;
      devBom: number;
      nominal: number;
      missing: boolean;
    }>;
  }>;
}

/** Response shape of `/api/peer-comparison/trend` (Feature 6). */
export interface TrendResponse {
  success: boolean;
  error?: string;
  weeks: Array<{
    weekLabel: string;
    devBomTarget: number;
    devBomPeerAvg: number;
  }>;
}

/** Per-peer average object keyed by PeerRow field name. */
export type PeerAverages = Record<string, number>;
