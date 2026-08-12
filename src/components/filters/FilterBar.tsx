'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, RotateCcw, Database, AlertTriangle, Upload, Loader2, CheckCircle2, XCircle, Settings, Folder, FileSpreadsheet, Users } from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useStatus } from '@/hooks/useAnalysis';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchableComboBox } from '@/components/filters/SearchableComboBox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useQueryClient } from '@tanstack/react-query';
import { SettingsDialog } from '@/components/filters/SettingsDialog';
import { DataManagementDialog } from '@/components/filters/DataManagementDialog';
import { PicManagementDialog } from '@/components/filters/PicManagementDialog';
import { FileUploadDialog } from '@/components/filters/FileUploadDialog';

export function FilterBar() {
  const { monthLabel, currentWeek, comparisonWeek, comparisonMonth, area, outletCode, pic, setMonth, setWeek, setCompareWeek, setArea, setOutlet, setPic, reset } = useDashboard();
  const { data: status, isLoading } = useStatus();
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  // File upload dialog state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const queryClient = useQueryClient();

  // Settings dialog state
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Data management & PIC management dialog state
  const [dataMgmtOpen, setDataMgmtOpen] = useState(false);
  const [picMgmtOpen, setPicMgmtOpen] = useState(false);

  const months = status?.months || [];
  const weeks = (monthLabel && status?.weeksByMonth) ? Object.entries(status.weeksByMonth).find(([k]) => {
    const m = status.months.find((mm) => mm.label === monthLabel);
    return m && k === m.key;
  })?.[1] || [] : [];
  const pics = status?.pics || [];
  // Filter outlets by area AND pic
  const outlets = (status?.outlets || []).filter((o) => {
    if (area && o.area !== area) return false;
    if (pic && o.pic !== pic) return false;
    return true;
  });
  const areas = status?.areas || [];

  type Period = { label: string; monthLabel: string; weekLabel: string; sortKey: string };
  const allComparePeriods: Period[] = [];
  if (status?.weeksByMonth && status?.months) {
    for (const m of status.months) {
      const ws = status.weeksByMonth[m.key] || [];
      for (const w of ws) {
        if (m.label === monthLabel && w === currentWeek) continue;
        allComparePeriods.push({
          label: `${w} — ${m.label}`,
          monthLabel: m.label,
          weekLabel: w,
          sortKey: `${m.key}|${w}`,
        });
      }
    }
    allComparePeriods.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  const compareValue = comparisonWeek
    ? `${comparisonWeek}|||${comparisonMonth || monthLabel}`
    : 'auto';
  const hasActiveFilter = Boolean(area || outletCode || pic);

  async function handleIngest() {
    setIngesting(true);
    setIngestMsg(null);
    try {
      const res = await fetch('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      // FIX: Check content-type before parsing — server crash returns HTML
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server returned non-JSON response (HTTP ${res.status}). The server may have crashed or timed out. Try importing fewer files at once.`);
      }
      const d = await res.json();
      if (d.success) {
        const ingested = d.results.filter((r: any) => r.status === 'INGESTED');
        const skipped = d.results.filter((r: any) => r.status === 'SKIPPED');
        const errors = d.results.filter((r: any) => r.status === 'ERROR');
        setIngestMsg(`Ingested: ${ingested.length}, Skipped: ${skipped.length}, Errors: ${errors.length}`);
        queryClient.invalidateQueries({ queryKey: ['status'] });
        queryClient.invalidateQueries({ queryKey: ['analysis'] });
      } else {
        setIngestMsg(`Failed: ${d.message || d.error}`);
      }
    } catch (e: any) {
      setIngestMsg(`Error: ${e?.message || String(e)}`);
    } finally {
      setIngesting(false);
      setTimeout(() => setIngestMsg(null), 8000);
    }
  }

  return (
    <>
      <Card className="mb-4">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-xs text-muted-foreground">Bulan</label>
              <Select value={monthLabel || ''} onValueChange={setMonth} disabled={isLoading}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Pilih bulan" /></SelectTrigger>
                <SelectContent>
                  {months.map((m) => <SelectItem key={m.key} value={m.label} className="text-xs">{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[100px]">
              <label className="text-xs text-muted-foreground">Minggu</label>
              <Select value={currentWeek || ''} onValueChange={setWeek} disabled={!monthLabel}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Minggu" /></SelectTrigger>
                <SelectContent>
                  {weeks.map((w) => <SelectItem key={w} value={w} className="text-xs">{w}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Periode Pembanding</label>
              <Select
                value={compareValue}
                onValueChange={(v) => {
                  if (v === 'auto') {
                    setCompareWeek(null, null);
                  } else {
                    const [wk, ml] = v.split('|||');
                    setCompareWeek(wk, ml);
                  }
                }}
                disabled={!currentWeek}
              >
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" className="text-xs">Otomatis (periode sebelumnya)</SelectItem>
                  {allComparePeriods.map((p) => (
                    <SelectItem
                      key={`${p.weekLabel}|${p.monthLabel}`}
                      value={`${p.weekLabel}|||${p.monthLabel}`}
                      className="text-xs"
                    >
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-xs text-muted-foreground">PIC</label>
              <SearchableComboBox
                options={pics.map((p) => ({ value: p, label: p }))}
                value={pic}
                onValueChange={setPic}
                placeholder="Semua PIC"
                searchPlaceholder="Cari PIC..."
                emptyText="PIC tidak ditemukan."
                allOptionLabel={`Semua PIC (${pics.length})`}
                buttonClassName="w-full"
              />
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Area</label>
              <SearchableComboBox
                options={areas.map((a) => ({ value: a, label: a }))}
                value={area}
                onValueChange={setArea}
                placeholder="Semua Area"
                searchPlaceholder="Cari area..."
                emptyText="Area tidak ditemukan."
                allOptionLabel={`Semua Area (${areas.length})`}
                buttonClassName="w-full"
              />
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Outlet</label>
              <SearchableComboBox
                options={outlets.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}`, description: o.area }))}
                value={outletCode}
                onValueChange={setOutlet}
                placeholder="Semua Outlet"
                searchPlaceholder="Cari outlet (kode/nama)..."
                emptyText="Outlet tidak ditemukan."
                allOptionLabel={`Semua Outlet (${outlets.length})`}
                buttonClassName="w-full"
              />
            </div>

            <div className="flex-1" />

            <Button variant="outline" size="sm" className="h-9" onClick={reset} disabled={!hasActiveFilter}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-3.5 w-3.5 mr-1" />
              Pengaturan
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setDataMgmtOpen(true)}
            >
              <Database className="h-3.5 w-3.5 mr-1" />
              Kelola Data
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setPicMgmtOpen(true)}
            >
              <Users className="h-3.5 w-3.5 mr-1" />
              Kelola PIC
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-9"
              onClick={() => setUploadDialogOpen(true)}
            >
              <Upload className="h-3.5 w-3.5 mr-1" />
              Import File
            </Button>
            <Button variant="default" size="sm" className="h-9" onClick={handleIngest} disabled={ingesting}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${ingesting ? 'animate-spin' : ''}`} />
              {ingesting ? 'Memproses...' : 'Refresh Data'}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {status?.stats && (
              <Badge variant="outline" className="text-[11px]">
                <Database className="h-3 w-3 mr-1" />
                {status.stats.totalFiles} file · {status.stats.totalOutlets} outlet · {status.stats.totalItems} item · {status.stats.totalRecords.toLocaleString()} record
              </Badge>
            )}
            {ingestMsg && (
              <Badge variant="secondary" className="text-[11px]">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {ingestMsg}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* File Upload Dialog */}
      <FileUploadDialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen} />


      {/* Settings Dialog */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Data Management Dialog */}
      <DataManagementDialog open={dataMgmtOpen} onOpenChange={setDataMgmtOpen} />

      {/* PIC Management Dialog */}
      <PicManagementDialog open={picMgmtOpen} onOpenChange={setPicMgmtOpen} />
    </>
  );
}
