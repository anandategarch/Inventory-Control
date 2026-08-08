'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fmtIDR, fmtNum, fmtPctAbs, directionColor, priorityColor } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { useDashboard } from '@/hooks/useDashboard';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function TopItemsByNominal({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.topItemsByNominal || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Top 10 by Nominal Deviasi</CardTitle>
        <p className="text-xs text-muted-foreground">Financial impact ranking (absolute)</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Nominal</TableHead>
                <TableHead className="text-center">Dir</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">No data</TableCell></TableRow>
              ) : items.map((it, i) => (
                <TableRow
                  key={`${it.itemName}-${it.outletCode}`}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName })}
                >
                  <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium text-xs">{it.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{it.outletCode}</TableCell>
                  <TableCell className="text-right font-semibold text-xs">{fmtIDR(it.absNominal)}</TableCell>
                  <TableCell className={`text-center text-xs font-semibold ${directionColor(it.direction)}`}>{it.direction?.[0]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export function TopItemsByDevBom({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.topItemsByDevBom || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Top 10 by Deviation/BOM</CardTitle>
        <p className="text-xs text-muted-foreground">Operational abnormality ranking</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Dev/BOM</TableHead>
                <TableHead className="text-right">Tol.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-xs py-6">No data</TableCell></TableRow>
              ) : items.map((it, i) => {
                const breach = it.tolerance != null && Math.abs(it.devBom) > Math.abs(it.tolerance);
                return (
                  <TableRow
                    key={`${it.itemName}-${it.outletCode}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setDrilldown({ outletCode: it.outletCode, itemName: it.itemName })}
                  >
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs">{it.itemName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{it.outletCode}</TableCell>
                    <TableCell className={`text-right font-semibold text-xs ${breach ? 'text-red-600' : ''}`}>{fmtPctAbs(it.devBom)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{it.tolerance != null ? fmtPctAbs(it.tolerance) : '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export function TopOutlets({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const setOutlet = useDashboard((s) => s.setOutlet);
  const items = data.topOutlets || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Top Outlets</CardTitle>
        <p className="text-xs text-muted-foreground">By absolute nominal deviation</p>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-72">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Area</TableHead>
                <TableHead className="text-right">Nominal</TableHead>
                <TableHead className="text-right">Dev/BOM</TableHead>
                <TableHead className="text-right">Area Avg</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs py-6">No data</TableCell></TableRow>
              ) : items.map((o, i) => {
                const aboveArea = o.areaAvg > 0 && o.devBom > o.areaAvg * 1.5;
                return (
                  <TableRow
                    key={o.outletCode}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => { setOutlet(o.outletCode); setDrilldown({ outletCode: o.outletCode, itemName: null }); }}
                  >
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium text-xs">{o.outletName}<div className="text-[10px] text-muted-foreground">{o.outletCode}</div></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{o.area}</TableCell>
                    <TableCell className="text-right font-semibold text-xs">{fmtIDR(o.absNominal)}</TableCell>
                    <TableCell className={`text-right text-xs font-semibold ${aboveArea ? 'text-red-600' : ''}`}>{fmtPctAbs(o.devBom)}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{fmtPctAbs(o.areaAvg)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export function InvestigationWorklist({ data }: { data: AnalysisData }) {
  const setDrilldown = useDashboard((s) => s.setDrilldown);
  const items = data.investigationWorklist || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Investigation Worklist</CardTitle>
            <p className="text-xs text-muted-foreground">{items.length} items flagged for investigation</p>
          </div>
          <Badge variant="outline" className="text-xs">
            P1: {items.filter((i) => i.priority === 'P1').length} · P2: {items.filter((i) => i.priority === 'P2').length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-96">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-12">Pri</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="min-w-[200px]">Issue</TableHead>
                <TableHead className="text-right">Nominal</TableHead>
                <TableHead className="text-right">Dev/BOM</TableHead>
                <TableHead className="min-w-[200px]">Recommended Action</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">No anomalies detected</TableCell></TableRow>
              ) : items.map((w, i) => (
                <TableRow
                  key={`${w.outletCode}-${w.itemName}-${i}`}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setDrilldown({ outletCode: w.outletCode, itemName: w.itemName })}
                >
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${priorityColor(w.priority)}`}>{w.priority}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="font-medium">{w.outletName}</div>
                    <div className="text-[10px] text-muted-foreground">{w.outletCode} · {w.area}</div>
                  </TableCell>
                  <TableCell className="text-xs font-medium">{w.itemName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{w.issue}</TableCell>
                  <TableCell className="text-right text-xs font-semibold">{fmtIDR(w.absNominalDeviasi)}</TableCell>
                  <TableCell className={`text-right text-xs ${directionColor(w.direction)}`}>{w.deviationToBom != null ? fmtPctAbs(w.deviationToBom) : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{w.recommendedAction}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      title="Open drill-down"
                      onClick={(e) => { e.stopPropagation(); setDrilldown({ outletCode: w.outletCode, itemName: w.itemName }); }}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
