'use client';

// ============================================================
//  MenuAnalysis — Phase 3: Group by menu prefix + outlier detection
//  Groups items by first 2 words of itemName (menu name)
//  Detects items where Dev growth >> BOM growth (outlier within menu)
//  (split from RestoAnalysis.tsx — Phase 3)
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Utensils } from 'lucide-react';
import { clickableRowProps } from '@/lib/a11y';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { fmtNum, fmtPct, directionColor } from './helpers';
import { fmtDecimal } from '@/lib/format';
import type { OutletItemsResponse } from './types';
import type { OutletItem } from '@/components/dashboard/PrioritySummaryCard';

export const MenuAnalysis = memo(function MenuAnalysis({ outletCode, monthLabel, currentWeek, onSelectItem, allItemsData }: {
  outletCode: string; monthLabel: string; currentWeek: string;
  onSelectItem: (item: { outletCode: string; itemName: string }) => void;
  allItemsData: OutletItemsResponse | undefined;
}) {
  // Bug 6.10 fix: use parent's data instead of duplicate query
  const outletData = allItemsData;

  const menuGroups = useMemo<Array<{
    menuName: string; itemCount: number; avgDevBom: number;
    stdDev: number; threshold: number; outlierCount: number;
    items: Array<OutletItem & { isOutlier?: boolean; outlierMultiple?: number | null }>;
  }>>(() => {
    if (!outletData?.allItems && !outletData?.rankings?.financial) return [];
    // Bug fix: use allItems (complete list) instead of rankings (only top 20)
    const allItemsArray: OutletItem[] = outletData.allItems || [];
    if (allItemsArray.length === 0) return [];
    const allItems = new Map<string, OutletItem>();
    for (const item of allItemsArray) {
      allItems.set(item.itemName, item);
    }

    // FIX M-G (AUDIT-2/3): was grouping by first word only — "AYAM CINCANG" +
    // "AYAM GORENG" merged into group "AYAM", making outlier detection meaningless.
    // Now group by first 2 words (catches "MINYAK MIE" vs "MINYAK GORENG").
    const groups = new Map<string, OutletItem[]>();
    for (const item of allItems.values()) {
      const words = (item.itemName || 'LAINNYA').split(/\s+/);
      const menuName = words.slice(0, 2).join(' ').toUpperCase();
      if (!groups.has(menuName)) groups.set(menuName, []);
      groups.get(menuName)!.push(item);
    }

    // For each group, compute avg Dev/BOM and flag outliers
    const result: Array<{
      menuName: string; itemCount: number; avgDevBom: number;
      stdDev: number; threshold: number; outlierCount: number;
      items: Array<OutletItem & { isOutlier?: boolean; outlierMultiple?: number | null }>;
    }> = [];
    for (const [menuName, items] of groups) {
      if (items.length < 2) continue; // Skip single-item groups

      const devBomValues = items
        .map(i => Math.abs(i.devBom ?? 0))
        .filter(v => v > 0);
      if (devBomValues.length === 0) continue;

      const avgDevBom = devBomValues.reduce((a, b) => a + b, 0) / devBomValues.length;
      const stdDev = devBomValues.length > 1
        ? Math.sqrt(devBomValues.reduce((a, b) => a + (b - avgDevBom) ** 2, 0) / (devBomValues.length - 1))
        : 0;
      const threshold = avgDevBom + 2 * stdDev; // outlier = > avg + 2σ

      const itemsWithFlag = items.map(item => ({
        ...item,
        isOutlier: Math.abs(item.devBom ?? 0) > threshold && Math.abs(item.devBom ?? 0) > avgDevBom * 1.5,
        outlierMultiple: avgDevBom > 0 ? Math.abs(item.devBom ?? 0) / avgDevBom : null,
      }));

      const outlierCount = itemsWithFlag.filter(i => i.isOutlier).length;

      result.push({
        menuName,
        itemCount: items.length,
        avgDevBom,
        stdDev,
        threshold,
        outlierCount,
        items: itemsWithFlag.sort((a, b) => Math.abs(b.devBom ?? 0) - Math.abs(a.devBom ?? 0)),
      });
    }

    return result.sort((a, b) => b.outlierCount - a.outlierCount || b.avgDevBom - a.avgDevBom);
  }, [outletData]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 shrink-0">
            <Utensils className="h-3.5 w-3.5" />
          </span>
          Menu Analysis — Outlier Detection
          <InfoTooltip content="Outlier = Dev/BOM > (avg + 2σ) DAN > 1.5× avg menu. Group by 2 kata pertama nama bahan." />
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          {/* FIX (BUG-HUNT B14/B2-05): leftover EN "deviation" — VH-7 unified the
              tab copy to Indonesian but missed this sentence. */}
          Group by menu (2 kata pertama nama bahan) — deteksi bahan yang deviasinya tidak proporsional vs bahan lain di menu yang sama
        </p>
      </CardHeader>
      <CardContent>
        {menuGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Utensils className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Tidak ada data menu.</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {menuGroups.map(group => (
              <div key={group.menuName} className="rounded-lg border overflow-hidden">
                <div className="flex items-center justify-between mb-2 px-3 py-2 border-b bg-muted/30 dark:bg-zinc-900/30">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{group.menuName}</span>
                    <Badge variant="outline" className="text-xs font-medium tabular-nums">{group.itemCount} bahan</Badge>
                    {group.outlierCount > 0 && (
                      <Badge variant="outline" className="text-xs text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 font-medium tabular-nums">
                        {group.outlierCount} outlier
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Avg Dev/BOM: <span className="font-medium">{fmtPct(group.avgDevBom)}</span> · Threshold: <span className="font-medium">{fmtPct(group.threshold)}</span>
                  </span>
                </div>
                <div className="space-y-0.5 p-2">
                  {group.items.map((item) => (
                    <div
                      key={item.itemName}
                      className={`flex items-center justify-between text-xs py-1.5 px-2 rounded cursor-pointer hover:bg-muted/40 transition-colors ${item.isOutlier ? 'bg-red-50/60 dark:bg-red-950/20' : ''}`}
                      {...clickableRowProps(() => onSelectItem({ outletCode, itemName: item.itemName }))}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {item.isOutlier && <span className="text-red-600 dark:text-red-400 font-bold text-xs">⚠</span>}
                        <span className="truncate max-w-[160px]" title={item.itemName}>{item.itemName}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="font-mono text-muted-foreground tabular-nums">BOM: {fmtNum(item.qtyBom)}</span>
                        <span className={`font-mono font-semibold tabular-nums ${item.isOutlier ? 'text-red-600 dark:text-red-400' : ''}`}>
                          Dev/BOM: {fmtPct(item.devBom)}
                        </span>
                        {item.outlierMultiple != null && item.outlierMultiple > 1 && (
                          <span className={`text-xs tabular-nums ${item.isOutlier ? 'text-red-600 dark:text-red-400 font-bold' : 'text-muted-foreground'}`}>
                            {fmtDecimal(item.outlierMultiple, 1)}× avg
                          </span>
                        )}
                        <span className={`text-xs ${directionColor(item.direction)}`}>{item.direction === 'LOSS' ? 'L' : 'S'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          ⚠ Outlier = Dev/BOM &gt; (avg + 2σ) DAN &gt; 1.5× avg menu · Klik bahan untuk lihat Investigation Card
        </p>
      </CardContent>
    </Card>
  );
});
