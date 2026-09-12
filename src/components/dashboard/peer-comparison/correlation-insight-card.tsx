'use client';

// ============================================================
//  Feature 9: Correlation Insight — auto-detected rules
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Lightbulb } from 'lucide-react';
import { fmtIDR, fmtDecimal } from '@/lib/format';
import type { PeerRow, PeerAverages } from './types';

interface Insight {
  type: 'warn' | 'good' | 'info';
  text: string;
}

export const CorrelationInsightCard = memo(function CorrelationInsightCard({
  target,
  peers,
  peerAvg,
}: {
  target: PeerRow;
  peers: PeerRow[];
  peerAvg: PeerAverages;
}) {
  const insights = useMemo<Insight[]>(() => {
    const out: Insight[] = [];
    const avgVal = (k: keyof PeerRow) => peerAvg[k as string] as number;
    const safeRatio = (a: number, b: number) => (b > 0 ? a / b : 0);

    // 1. Outlier detection: Dev/BOM > 1.5× peer avg
    const devBomRatio = safeRatio(target.devBom, avgVal('devBom'));
    if (devBomRatio > 1.5) {
      const pctAbove = fmtDecimal((devBomRatio - 1) * 100, 0);
      out.push({
        type: 'warn',
        text: `Dev/BOM ${fmtDecimal(target.devBom * 100, 1)}% adalah ${pctAbove}% di atas peer average — outlier.`,
      });
    }

    // 2. Best practice detection: lowest Dev/BOM among peers (excluding target)
    if (peers.length > 0) {
      const bestPeer = peers.reduce((best, p) => (p.devBom < best.devBom ? p : best), peers[0]);
      out.push({
        type: 'info',
        text: `${bestPeer.outletName} adalah best practice: Dev/BOM ${fmtDecimal(bestPeer.devBom * 100, 1)}% (terendah di peer group).`,
      });
    }

    // 3. Sales vs Deviation correlation: peers with high sales but low deviasi
    const highSalesLowDev = peers.filter(
      p => p.sales > avgVal('sales') && p.devBom < avgVal('devBom')
    );
    if (highSalesLowDev.length > 0) {
      out.push({
        type: 'good',
        text: `${highSalesLowDev.length} peer dengan sales tinggi tapi deviasi rendah — kemungkinan practice yang bisa direplikasi.`,
      });
    }

    // 4. Residual red flag: > 2× peer avg
    const residualRatio = safeRatio(target.residualQty, avgVal('residualQty'));
    if (residualRatio > 2) {
      out.push({
        type: 'warn',
        text: `Residual ${target.residualQty} adalah ${fmtDecimal(residualRatio, 1)}× peer average — potensi data entry error atau fraud.`,
      });
    }

    // 5. LOSS severity
    const lossRatio = safeRatio(target.totalLoss, avgVal('totalLoss'));
    if (lossRatio > 1.5) {
      out.push({
        type: 'warn',
        text: `Total LOSS ${fmtIDR(target.totalLoss)} adalah ${fmtDecimal((lossRatio - 1) * 100, 0)}% di atas peer average — investigasi penyebab utama.`,
      });
    }

    // 6. Sales underperformance
    const salesRatio = safeRatio(target.sales, avgVal('sales'));
    if (salesRatio < 0.9 && salesRatio > 0) {
      out.push({
        type: 'info',
        text: `Sales ${fmtIDR(target.sales)} adalah ${fmtDecimal((1 - salesRatio) * 100, 0)}% di bawah peer average — walaupun dalam ±10% band, target ada di sisi bawah.`,
      });
    }

    // 7. Best in class detection
    if (target.devBom === Math.min(...peers.map(p => p.devBom), target.devBom)) {
      out.push({
        type: 'good',
        text: `Target adalah best in class untuk Dev/BOM — pertahankan practice saat ini.`,
      });
    }

    return out;
  }, [target, peers, peerAvg]);

  if (insights.length === 0) {
    return null;
  }

  const colorByType = (t: string) =>
    t === 'warn'
      ? 'border-l-red-500 bg-red-50/60 dark:bg-red-950/20'
      : t === 'good'
        ? 'border-l-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20'
        : 'border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20';

  const iconByType = (t: string) =>
    t === 'warn'
      ? '⚠️'
      : t === 'good'
        ? '✅'
        : '💡';

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 shrink-0">
            <Lightbulb className="h-3.5 w-3.5" />
          </span>
          Correlation Insight
        </CardTitle>
        <p className="text-[11px] text-muted-foreground ml-9">
          Insight otomatis berdasarkan pola data peer group.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {insights.map((ins, i) => (
            <li key={i} className={`text-xs rounded-md border-l-4 px-3 py-2 ${colorByType(ins.type)}`}>
              <span className="mr-1">{iconByType(ins.type)}</span>
              <span className="text-foreground">{ins.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
});
