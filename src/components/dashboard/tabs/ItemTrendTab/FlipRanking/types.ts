// ============================================================
//  FlipRanking — Types
//  --------------------------------------------------------
//  SPLIT-B (pure move from FlipRanking.tsx — no behavior change).
//  Local types matching /api/flip-ranking response (kept local to
//  avoid importing from the API route file — backend types are
//  not exported).
// ============================================================

import type { FlipPair } from '../flip-badges';

export interface FlipRankItem {
  itemName: string;
  totalPairs: number;
  flipCount: number;
  sempurnaCount: number;
  dominanCount: number;
  parsialCount: number;
  konsistenCount: number;
  avgDisparity: number;
  riskScore: number;
  riskLevel: 'low' | 'moderate' | 'high';
  topFlips: FlipPair[];
}

export interface FlipRankingResponse {
  success: boolean;
  items: FlipRankItem[];
  totalItemsScanned: number;
  durationMs?: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

export type FlipSortKey = 'riskScore' | 'sempurnaCount' | 'flipCount' | 'avgDisparity' | 'itemName';
export type FlipSortDir = 'asc' | 'desc';

/** Summary stats rendered under the FlipRanking card title. */
export interface FlipRankingSummary {
  highCount: number;
  moderateCount: number;
  totalFlips: number;
  totalSempurna: number;
}
