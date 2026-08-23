'use client';

// ============================================================
//  Feature 5: Anomaly Flags — per-resto badges
//  Inline within the Peer Table's "Flags" column.
// ============================================================

import type { PeerRow, PeerAverages } from './types';

interface Flag {
  emoji: string;
  text: string;
  color: string;
}

export function AnomalyFlags({
  row,
  peerAvg,
}: {
  row: PeerRow;
  peerAvg: PeerAverages;
}) {
  const flags: Flag[] = [];
  const avgVal = (k: keyof PeerRow) => peerAvg[k as string] as number;

  const checkRatio = (targetVal: number, avg: number) => (avg > 0 ? targetVal / avg : 0);

  if (checkRatio(row.devBom, avgVal('devBom')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Dev/BOM tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.totalLoss, avgVal('totalLoss')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'LOSS tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.residualQty, avgVal('residualQty')) > 1.5) {
    flags.push({ emoji: '🔴', text: 'Residual tinggi', color: 'text-red-600 bg-red-50 dark:bg-red-950/30' });
  }
  if (checkRatio(row.sales, avgVal('sales')) < 0.8 && avgVal('sales') > 0) {
    flags.push({ emoji: '🟡', text: 'Sales rendah', color: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30' });
  }

  const allNormal =
    flags.length === 0 &&
    Math.abs(row.devBom - avgVal('devBom')) <= avgVal('devBom') * 0.2 &&
    Math.abs(row.totalLoss - avgVal('totalLoss')) <= avgVal('totalLoss') * 0.2 &&
    Math.abs(row.residualQty - avgVal('residualQty')) <= avgVal('residualQty') * 0.2 &&
    Math.abs(row.sales - avgVal('sales')) <= avgVal('sales') * 0.2;

  if (allNormal) {
    flags.push({ emoji: '🟢', text: 'Normal', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30' });
  }

  if (flags.length === 0) {
    return <span className="text-muted-foreground text-[10px]">—</span>;
  }

  return (
    <div className="flex flex-col items-center gap-0.5">
      {flags.map((f, i) => (
        <span key={i} className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium ${f.color}`} title={f.text}>
          <span>{f.emoji}</span>
          <span className="sr-only">{f.text}</span>
        </span>
      ))}
    </div>
  );
}
