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

const SECTIONS: SectionOption[] = [
  { key: 'exec', label: '1. Executive Summary', description: '14 KPI: Sales, Deviasi, BOM, Waste, Susut, Trial, Loss/Surplus, Dev/BOM, Residual', default: true },
  { key: 'health', label: '2. Health Status', description: 'Normal/Warning/Abnormal counts + rule violations', default: true },
  { key: 'growth', label: '3. Analisis Pertumbuhan', description: '8 growth metrics + multi-period comparison + price effect', default: true },
  { key: 'topItems', label: '4. Top Items', description: '6 rankings: Nominal, Dev/BOM, Waste, Susut, Trial, Loss/Surplus', default: true },
  { key: 'breakdown', label: '5. Deviation Breakdown', description: 'Waste/Susut/Trial/Residual composition with %', default: true },
  { key: 'lossSurplus', label: '6. Loss vs Surplus', description: 'Count + nominal per direction', default: true },
  { key: 'area', label: '7. Perbandingan Area', description: 'Per-area: outlets, sales, nominal, Dev/BOM, Loss/Sales', default: true },
  { key: 'ranking', label: '8. Outlet Health Ranking', description: 'Top 30 outlet dengan skor + metrics', default: true },
  { key: 'cost', label: '9. Cost Impact', description: 'Waste/Susut/Trial/Residual cost + % of sales', default: true },
  { key: 'pareto', label: '10. Pareto (ABC)', description: 'Class A count + top 20 items dengan cumulative %', default: true },
  { key: 'variance', label: '11. Variance Analysis', description: 'Items memburuk + membaik (delta vs previous)', default: true },
  { key: 'worklist', label: '12. Investigation Worklist', description: 'P1/P2/P3 dengan issue, nominal, rules, recommended actions', default: true },
  { key: 'consistency', label: '13. Item Consistency', description: 'SYSTEMIC/WIDESPREAD/ISOLATED dengan outlet counts', default: true },
  { key: 'trend', label: '14. Trend Multi-Periode', description: 'Same-weekLabel across months', default: true },
  { key: 'narrative', label: '15. Narasi Analisis', description: 'LLM-generated narrative analysis', default: true },
  { key: 'recommendations', label: '16. Rekomendasi', description: 'Structured recommendations with priority + actions', default: true },
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
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isExporting}>
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
