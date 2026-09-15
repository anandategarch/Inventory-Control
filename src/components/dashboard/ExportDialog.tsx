'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileDown, Loader2, CheckCheck, Square } from 'lucide-react';

interface SectionOption {
  key: string;
  label: string;
  description: string;
  default: boolean;
}

// H-5: '5. Analisis Korelasi BOM' removed per user request (same removal
// series as Loss-to-Sales / Kepatuhan).
// EXPAND-1: report grew 6 → 9 sections.
// EXPORT-PDF: output switched .docx → .pdf (full design + charts).
// EXPORT-TRIM (user request): report trimmed 13 → 6 sections — only
// Ringkasan (renamed from "Ringkasan Eksekutif"), Perubahan vs Periode
// Pembanding, Item Prioritas, Perubahan Item, Trend Item Multi-Periode,
// Trend Antar Periode remain. Section numbering is FIXED (stable across
// ?sections= selections — mirrors pdf-builder.ts). Keep the keys in sync
// with EXPORT_SECTION_KEYS (validation.ts).
// REFINE-1 (user request): + section 7 (Resto dengan Penjualan Kurang
// Lebih Sama — peer-to-peer dengan breakdown per item) + section 8 (Item
// yang Kemungkinan Plus Minus antar Periode — flip antar periode). Nominal
// penjualan tidak pernah dicetak di laporan (angka rahasia).
// REFINE-3 (user request): + section 6 (Item Anomali vs Riwayat Sendiri —
// kuantitas vs rata-rata riwayat sendiri, same-week antar bulan); trend
// renumbered 6→7 (+ komposisi per minggu & akumulasi mingguan), peer 7→8,
// flip 8→9.
const SECTIONS: SectionOption[] = [
  { key: 'exec', label: '1. Ringkasan', description: 'Kartu KPI + tabel metrik: Nominal Deviasi, QTY, rasio — dengan growth vs pembanding (nominal penjualan disembunyikan)', default: true },
  { key: 'growth', label: '2. Perubahan vs Periode Pembanding', description: 'Tabel nilai vs pembanding (selisih absolut / pp / growth %) + grafik batang growth per metrik', default: true },
  { key: 'topItems', label: '3. Item Prioritas (Top Items)', description: '6 ranking: Nominal + % Dev/BOM, Dev/BOM + Nominal, Waste, Susut, Trial, Loss/Surplus — dengan QTY prev, rata-rata per bulan, rata-rata area + vs rata-rata area', default: true },
  { key: 'variance', label: '4. Perubahan Item (vs Pembanding)', description: 'Memburuk + Membaik: selisih nominal terbesar vs periode pembanding + grafik batang', default: true },
  { key: 'itemTrend', label: '5. Trend Item Multi-Periode', description: 'Matriks 15 item teratas × periode (maks 7 bulan) dengan sel warna panas + trend terakhir', default: true },
  { key: 'anomali', label: '6. Item Anomali vs Riwayat Sendiri', description: 'Item dengan QTY deviasi paling jauh dari rata-rata riwayatnya sendiri (same-week antar bulan, penyimpangan ≥ 50% dari baseline)', default: true },
  { key: 'trend', label: '7. Trend Antar Periode', description: 'Nominal Deviasi, % Dev/BOM, Nominal Deviasi to Sales per periode + grafik batang & garis + komposisi per minggu (Waste/Susut/Trial/Loss-Surplus) + akumulasi mingguan (Week 1+2+…)', default: true },
  { key: 'peer', label: '8. Resto dengan Penjualan Kurang Lebih Sama', description: 'Resto lain dengan total penjualan kurang lebih sama: nominal deviasi yang dihasilkan + breakdown per item (kuantitas, % to BOM)', default: true },
  { key: 'flip', label: '9. Item yang Kemungkinan Plus Minus antar Periode', description: 'Item yang QTY deviasinya berbalik arah (plus menjadi minus / sebaliknya) antar periode sejenis', default: true },
];

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (sections: string[]) => void;
  isExporting: boolean;
}

export function ExportDialog({ open, onOpenChange, onExport, isExporting }: ExportDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(SECTIONS.filter(s => s.default).map(s => s.key))
  );

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(SECTIONS.map(s => s.key)));
  const deselectAll = () => setSelected(new Set());

  // FIX (BUG-3-b A5): handleExport in the parent (useDashboardActions) closes
  // the dialog PROGRAMMATICALLY via setExportDialogOpen(false) — that path
  // never ran the reset in handleOpenChange, so a reduced selection
  // ("2/6 section") silently persisted to the next open. Reset on every
  // open→false transition (user-initiated AND programmatic) so the next open
  // starts fresh. Uses the React-recommended "adjust state during render"
  // pattern (same as SettingsDialog BUG FIX #005) — no setState-in-effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setSelected(new Set(SECTIONS.filter(s => s.default).map(s => s.key)));
    }
  }

  const handleExport = () => {
    onExport([...selected]);
  };

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[600px] max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileDown className="h-4 w-4" />
            Export ke PDF (.pdf)
          </DialogTitle>
          <DialogDescription className="text-xs">
            Pilih section yang ingin di-export. Laporan PDF dengan desain penuh dan grafik. Filter resto mengikuti Filter Resto di tab Resto Analysis (atau filter resto global).
          </DialogDescription>
        </DialogHeader>

        {/* Select All / Deselect All */}
        <div className="flex items-center gap-2 pb-2 shrink-0">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={selectAll}>
            <CheckCheck className="h-3 w-3" /> Pilih Semua
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={deselectAll}>
            <Square className="h-3 w-3" /> Kosongkan
          </Button>
          <Badge variant="secondary" className="text-[11px] ml-auto">
            {selected.size}/{SECTIONS.length} section
          </Badge>
        </div>

        {/* Section list */}
        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {SECTIONS.map(section => (
            <label
              key={section.key}
              className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                selected.has(section.key)
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border hover:bg-muted/40'
              }`}
            >
              <Checkbox
                checked={selected.has(section.key)}
                onCheckedChange={() => toggle(section.key)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">{section.label}</p>
                <p className="text-[11px] text-muted-foreground leading-tight">{section.description}</p>
              </div>
            </label>
          ))}
        </div>

        <DialogFooter className="shrink-0 pt-2">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={isExporting}>
            Batal
          </Button>
          <Button size="sm" onClick={handleExport} disabled={isExporting || selected.size === 0} className="gap-1.5">
            {isExporting ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting...</>
            ) : (
              <><FileDown className="h-3.5 w-3.5" /> Export ({selected.size} section)</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
