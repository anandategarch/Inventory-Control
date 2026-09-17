'use client';

// AnomaliOutletExpansion — INTERNAL inline row-expansion panel used by
// ItemConsistencyAnalysis (the only consumer). NOT re-exported from the
// barrel — public API unchanged. Moved verbatim from
// AdvancedAnalysis.tsx (REFACTOR-1-c pure split — zero behavior change).

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { fmtIDR, fmtNum, numberColorNeg } from '@/lib/format';
import { clickableRowProps } from '@/lib/a11y';

// ============================================================
//  1.3a AnomaliOutletExpansion
//  Inline row-expansion component for ItemConsistencyAnalysis.
//  When the user clicks a row in "Analisis Pola Item", this component
//  renders BELOW the row (colSpan=8) showing outlets whose direction
//  is the MINORITY (anomali) direction. Each outlet row is clickable →
//  setFocusOutlet navigates to the Resto Analysis tab.
// ============================================================
interface AnomaliOutletRow {
  outletCode: string;
  outletName: string;
  area: string | null;
  pic: string | null;
  qtyDeviasi: number;
  nominalDeviasi: number;
  direction: string;
}

interface ItemAnomaliOutletsResponse {
  success: boolean;
  item: { itemName: string };
  direction: 'LOSS' | 'SURPLUS';
  outlets: AnomaliOutletRow[];
  durationMs?: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

interface AnomaliOutletExpansionProps {
  itemName: string;
  direction: 'LOSS' | 'SURPLUS';
  monthLabel: string | null;
  currentWeek: string | null;
  area: string | null;
  kelompok: string | null;
  outletCode: string | null;
  pic: string | null;
  setFocusOutlet: (code: string | null) => void;
}

export function AnomaliOutletExpansion({
  itemName,
  direction,
  monthLabel,
  currentWeek,
  area,
  kelompok,
  outletCode,
  pic,
  setFocusOutlet,
}: AnomaliOutletExpansionProps) {
  const { data, isLoading, error } = useQuery<ItemAnomaliOutletsResponse>({
    queryKey: [
      'item-anomali-outlets', itemName, direction,
      monthLabel, currentWeek, area, kelompok, outletCode, pic,
    ],
    queryFn: async () => {
      const p = new URLSearchParams({
        item: itemName,
        month: monthLabel ?? '',
        week: currentWeek ?? '',
        direction,
      });
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode) p.set('outlet', outletCode);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/item-anomali-outlets?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ItemAnomaliOutletsResponse>;
    },
    // Parent only renders this component when expanded — fire immediately.
    enabled: true,
    staleTime: 5 * 60 * 1000, // 5 min — matches API cache
  });

  const outlets = data?.outlets ?? [];

  return (
    <TableRow className="border-b hover:bg-transparent">
      <TableCell colSpan={8} className="p-0">
        <div className="bg-amber-50/40 dark:bg-amber-950/10 border-t border-amber-200/60 dark:border-amber-900/40 p-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
              {outlets.length} Outlet {direction} (Anomali — berbeda dari mayoritas)
            </span>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Memuat outlet...
            </div>
          ) : error ? (
            <div className="text-xs text-red-600 dark:text-red-400 py-2">Gagal memuat: {error.message}</div>
          ) : outlets.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">Tidak ada outlet anomali.</div>
          ) : (
            <div className="max-h-48 overflow-auto">
              <Table className="min-w-[600px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] h-7">Outlet</TableHead>
                    <TableHead className="text-[10px] h-7">Area</TableHead>
                    <TableHead className="text-[10px] h-7">PIC</TableHead>
                    <TableHead className="text-right text-[10px] h-7">QTY Dev</TableHead>
                    <TableHead className="text-right text-[10px] h-7">Nominal</TableHead>
                    <TableHead className="text-center text-[10px] h-7">Dir</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outlets.map((o, i) => (
                    <TableRow
                      key={`${o.outletCode}-${i}`}
                      className={`cursor-pointer hover:bg-muted/40 ${i % 2 === 1 ? 'bg-muted/20' : ''}`}
                      {...clickableRowProps(() => {
                        setFocusOutlet(o.outletCode);
                      })}
                    >
                        <TableCell className="py-1.5">
                          <div className="flex flex-col leading-tight">
                            <span className="text-[11px] font-medium tabular-nums">{o.outletCode}</span>
                            <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={o.outletName}>{o.outletName}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-[10px] text-muted-foreground py-1.5">{o.area || '—'}</TableCell>
                        <TableCell className="text-[10px] text-muted-foreground py-1.5">{o.pic || '—'}</TableCell>
                        {/* P23 B9: signed VALUE columns — numberColorNeg (minus-red only,
                            PDF negColor; dark: variants built in — were missing). */}
                        <TableCell className={`text-right text-[11px] py-1.5 tabular-nums font-medium ${numberColorNeg(o.qtyDeviasi)}`}>
                          {fmtNum(o.qtyDeviasi)}
                        </TableCell>
                        <TableCell className={`text-right text-[11px] py-1.5 tabular-nums ${numberColorNeg(o.nominalDeviasi)}`}>
                          {fmtIDR(o.nominalDeviasi)}
                        </TableCell>
                        <TableCell className="text-center py-1.5">
                          <Badge variant="outline" className={`text-[9px] h-4 px-1 font-medium ${o.direction === 'LOSS' ? 'text-red-700 bg-red-100 border-red-300 dark:bg-red-950/30 dark:text-red-400' : 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:bg-emerald-950/30 dark:text-emerald-400'}`}>
                            {o.direction}
                          </Badge>
                        </TableCell>
                      </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground mt-1">💡 Klik outlet untuk deep dive ke Resto Analysis.</p>
        </div>
      </TableCell>
    </TableRow>
  );
}
