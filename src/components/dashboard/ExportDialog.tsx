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
// series as Loss-to-Sales / Kepatuhan). Variance + Trend renumbered 6/7 → 5/6.
const SECTIONS: SectionOption[] = [
  { key: 'exec', label: '1. Rangkuman', description: 'KPI: Deviasi, BOM, Waste, Susut, Trial, Residual, Dev/BOM', default: true },
  { key: 'growth', label: '2. Perubahan (Growth)', description: 'Growth metrics: Sales, BOM, Deviasi, Nominal', default: true },
  { key: 'topItems', label: '3. Item Prioritas (Top Items)', description: '6 rankings: Nominal, Dev/BOM, Waste, Susut, Trial, Loss/Surplus', default: true },
  { key: 'breakdown', label: '4. Rincian Komposisi Selisih', description: 'Waste/Susut/Trial/Loss-Surplus composition with %', default: true },
  { key: 'variance', label: '5. Perubahan Item (Selisih Terbesar)', description: 'Top 10 item dengan selisih nominal terbesar vs periode sebelumnya', default: true },
  { key: 'trend', label: '6. Trend Antar Periode', description: 'Nominal Deviasi, % Dev/BOM, % Nominal to Sales per periode', default: true },
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

  const handleExport = () => {
    onExport([...selected]);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Reset to default selection on close so the next open starts fresh
      setSelected(new Set(SECTIONS.filter(s => s.default).map(s => s.key)));
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileDown className="h-4 w-4" />
            Export ke Word (.docx)
          </DialogTitle>
          <DialogDescription className="text-xs">
            Pilih section yang ingin di-export. File Word akan berisi data sesuai filter yang aktif.
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
