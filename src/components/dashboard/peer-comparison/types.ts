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

/** Response shape of `/api/peer-comparison/top-items` (PEERTOP-2 —
 *  "Top Items Across Peers" card + Peer Table expand rows).
 *  CLIENT-SAFE duplicate of the backend result types
 *  (src/lib/queries/outlets/peer-top-items.ts) — do NOT import from
 *  @/lib/queries/** here (that module pulls Prisma; this file is
 *  imported by client components), same policy as
 *  ItemComparisonResponse above. */
export interface PeerTopItemsResponse {
  success: boolean;
  error?: string;
  topN?: number;
  /** Cross-peer UNION rows (server pre-sorted: peerTopCount desc →
   *  target absNominal desc → peerMaxAbsNominal desc → name asc). */
  items: Array<{
    itemId: number;
    itemName: string;
    satuan: string | null;
    /** Non-target peers carrying this item in THEIR top-N. */
    peerTopCount: number;
    /** Those peers' outlet codes (map → names via perPeer below). */
    peerTopCodes: string[];
    /** Rata-rata |kuantiti deviasi| across those peers — PEERTOP-R1:
     *  "Rata-Rata Absolute" kini berbasis |qty deviasi| (user request),
     *  bukan |nominal|. */
    peerAvgAbsQty: number;
    peerAvgDevBom: number;
    /** Worst (largest absNominal) among those peers. */
    peerMaxAbsNominal: number;
    /** Target's own row. PEERTOP-R1:
     *  - qtyDeviasi = kuantiti deviasi NILAI ASLI (signed — minus =
     *    kekurangan → merah; null = tidak ada catatan qty);
     *  - itemRank/itemOutletCount = "Ranking Resto di antara Resto yang
     *    Selevel per Item" (#peringkat/total resto selevel yang mencatat
     *    deviasi item ini, urut |nominal deviasi| terbesar);
     *  - rank = peringkat di top list resto sendiri (styling);
     *  null = item has NO deviation records at the target ("blind spot"). */
    target: {
      rank: number;
      absNominal: number;
      devBom: number;
      qtyDeviasi: number | null;
      itemRank: number;
      itemOutletCount: number;
    } | null;
  }>;
  /** Per-outlet top-N (target included). NOTE: ordered by outletCode —
   *  peers with ZERO deviation records have NO entry here (callers show
   *  "tidak ada item deviasi" for those codes). */
  perPeer: Array<{
    outletCode: string;
    outletName: string;
    isTarget: boolean;
    items: Array<{ itemName: string; absNominal: number; devBom: number; direction: string }>;
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
