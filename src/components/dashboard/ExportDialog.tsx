'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  FileDown,
  Loader2,
  CheckCheck,
  Square,
  ChevronRight,
} from 'lucide-react';
import {
  EXPORT_SECTIONS,
  exportSubToken,
  compactSectionTokens,
  isSectionOn,
  type ExportSection,
} from '@/lib/export-sections';
// CUSTOM-COMPARE — section 13's comparator picker (resto + area picks).
import {
  ExportComparatorPicker,
  type ComparatorOutlet,
} from './ExportComparatorPicker';

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
// W10 (Atribusi + Skenario Sensitivitas Residual): + section 5 (Analisis
// Waste — atribusi loss W/S/T vs residual + skenario p HIPOTESIS +
// pergeseran decile + snapshot top waste item), inserted after the
// variance context; REFINE-3 precedent renumber: itemTrend 5→6, anomali
// 6→7, trend 7→8, peer 8→9, flip 9→10 (keys unchanged).
// SUBSECTION-1 (user request: "waktu export laporan pdf kan ada section
// yang bisa aku centang namun tiap section ada anak nya lagi atau sub
// section. nah sub section ini juga harusnya bisa aku centang juga"):
// the section rows now carry INDENTED sub-section checkboxes — every
// numbered sub-block the PDF itself prints (3.1-3.6, 4.1/4.2, 5.1-5.3,
// 7.1-7.3, 9.1-9.3 + the table/chart blocks of sections 2 & 8) is
// individually selectable. The key/token registry moved to
// src/lib/export-sections.ts (single source of truth shared with the
// server's validation + render gates — this file's local SECTIONS array
// is gone). Parent checkboxes are TRI-STATE (all/partial/none) and
// toggle all children; sections without sub-blocks (1, 6, 10) are plain
// rows exactly as before.

// Section descriptions (UI copy only — the keys/labels/sub tree live in
// export-sections.ts). Parent sections that enumerate their content via
// sub rows carry a one-line summary instead of the old full inventory.
const SECTION_DESCRIPTIONS: Record<string, string> = {
  exec: 'Kartu KPI + tabel metrik: Nominal Deviasi, QTY, rasio — dengan growth vs pembanding (nominal penjualan disembunyikan)',
  growth:
    'Perubahan tiap metrik vs periode pembanding (nominal penjualan disembunyikan)',
  topItems:
    'Enam ranking penyimpangan terbesar — QTY prev, rata-rata per bulan, rata-rata area + vs rata-rata area',
  variance:
    'Item dengan perubahan selisih nominal terbesar vs periode pembanding (memburuk / membaik)',
  waste:
    'Atribusi loss window same-week: terjelaskan W/S/T vs residual + skenario sensitivitas + snapshot top waste item',
  itemTrend:
    'Matriks 15 item teratas × periode (maks 7 bulan) dengan sel warna panas + trend terakhir',
  anomali:
    'Item dengan QTY deviasi paling jauh dari rata-rata riwayatnya sendiri (same-week antar bulan, penyimpangan ≥ 50% dari baseline)',
  trend:
    'Metrik per periode + grafik: nominal deviasi, loss vs surplus, komposisi per minggu, akumulasi mingguan',
  peer: 'Resto lain dengan total penjualan kurang lebih sama: nominal deviasi yang dihasilkan + breakdown per item (kuantitas, % to BOM)',
  flip: 'Item yang QTY deviasinya berbalik arah (plus menjadi minus / sebaliknya) antar periode sejenis',
  outletLeague:
    'Semua resto dalam scope filter SATU BARIS PER RESTO (satu per satu), peringkat dari nominal deviasi terbesar — resto terpilih di-highlight; nominal penjualan disembunyikan',
  areaCompare:
    'Semua area berdampingan satu per satu: jumlah resto, nominal deviasi, % Dev/BOM, % Loss to Sales + grafik per area',
  customCompare:
    'Resto fokus vs PEMBANDING PILIHAN SENDIRI: beberapa resto tertentu (mis. mlgpar vs bdgsek) dan/atau seluruh resto per area — tabel KPI, grafik, dan breakdown per item; pilih pembanding di panel di bawah',
};

/** Every selectable token: leaf bare keys + every parent's sub tokens. */
function allTokens(): Set<string> {
  const s = new Set<string>();
  for (const sec of EXPORT_SECTIONS) {
    if (!sec.subs) s.add(sec.key);
    else for (const sub of sec.subs) s.add(exportSubToken(sec.key, sub.key));
  }
  return s;
}

/** The DEFAULT selection (dialog open + reset on close): everything
 *  EXCEPT section 13 — CUSTOM-COMPARE needs a comparator set the legacy
 *  flow never picked, so shipping it pre-checked would disable the
 *  Export button on every dialog open (the "export everything in one
 *  click" flow must stay untouched). Section 13 is opt-in: check it,
 *  the comparator panel appears, pick resto/area, export. */
function defaultTokens(): Set<string> {
  const s = allTokens();
  for (const t of [...s]) {
    if (t === 'customCompare' || t.startsWith('customCompare:')) s.delete(t);
  }
  return s;
}

/** The comparator selection payload handed to the export action. */
export interface ComparatorSelection {
  outlets: string[];
  areas: string[];
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (sections: string[], compare?: ComparatorSelection) => void;
  isExporting: boolean;
  /** CUSTOM-COMPARE — every outlet for the comparator picker (/api/status
   *  cache; no extra fetch). */
  outlets: ComparatorOutlet[];
  /** CUSTOM-COMPARE — every area name. */
  areas: string[];
  /** CUSTOM-COMPARE — the Resto tab's Filter Resto (the export's focus). */
  focusOutlet: string | null;
  /** The focus outlet's display name (resolved from the status cache). */
  focusOutletName: string | null;
}

export function ExportDialog({
  open,
  onOpenChange,
  onExport,
  isExporting,
  outlets,
  areas,
  focusOutlet,
  focusOutletName,
}: ExportDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(() => defaultTokens());
  // CUSTOM-COMPARE — the comparator picks (reset together with the
  // section selection on every open→false transition, BUG-3-b A5).
  const [compareOutlets, setCompareOutlets] = useState<string[]>([]);
  const [compareAreas, setCompareAreas] = useState<string[]>([]);

  // SUBSECTION-1: leaf rows toggle their bare key; parent rows toggle ALL
  // of their sub tokens (tri-state — see parentChecked below).
  const toggleSection = (section: ExportSection) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!section.subs) {
        if (next.has(section.key)) next.delete(section.key);
        else next.add(section.key);
        return next;
      }
      const subTokens = section.subs.map((sub) =>
        exportSubToken(section.key, sub.key),
      );
      const allOn = subTokens.every((t) => next.has(t));
      if (allOn) subTokens.forEach((t) => next.delete(t));
      else subTokens.forEach((t) => next.add(t));
      return next;
    });
  };

  const toggleSub = (sectionKey: string, subKey: string) => {
    const token = exportSubToken(sectionKey, subKey);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  const selectAll = () => setSelected(defaultTokens());
  const deselectAll = () => setSelected(new Set());

  // Parent tri-state: true (every sub on) | 'indeterminate' (some) | false.
  const parentChecked = (section: ExportSection): boolean | 'indeterminate' => {
    if (!section.subs) return selected.has(section.key);
    const on = section.subs.filter((sub) =>
      selected.has(exportSubToken(section.key, sub.key)),
    ).length;
    if (on === section.subs.length) return true;
    if (on > 0) return 'indeterminate';
    return false;
  };

  // A section is ACTIVE when it (leaf) or ≥1 of its sub tokens is on.
  const activeSectionCount = EXPORT_SECTIONS.filter((sec) =>
    sec.subs
      ? sec.subs.some((sub) => selected.has(exportSubToken(sec.key, sub.key)))
      : selected.has(sec.key),
  ).length;

  // CUSTOM-COMPARE — is section 13 (or any of its sub tokens) selected?
  // Drives the comparator panel + the export-button validation.
  const customCompareActive = isSectionOn([...selected], 'customCompare');
  const compareCount = compareOutlets.length + compareAreas.length;
  const compareMissing = customCompareActive && compareCount === 0;

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
      // CUSTOM-COMPARE: the comparator picks reset together with the
      // section selection (same BUG-3-b A5 reset semantics).
      setSelected(defaultTokens());
      setCompareOutlets([]);
      setCompareAreas([]);
    }
  }

  const handleExport = () => {
    // compactSectionTokens: a parent with EVERY sub selected collapses to
    // its bare key (byte-compatible with the pre-SUBSECTION-1 full-section
    // URLs — shares the server cache row); a partial selection expands to
    // the selected sub tokens.
    const tokens = compactSectionTokens(selected);
    // CUSTOM-COMPARE — hand the comparator picks to the export action ONLY
    // when section 13 is actually in the token list (a stale pick with the
    // section unchecked must not fork the server cache key).
    if (customCompareActive && compareCount > 0) {
      onExport(tokens, { outlets: compareOutlets, areas: compareAreas });
    } else {
      onExport(tokens);
    }
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
            {/* FIX (BUGHUNT-R2 / pasca-FILTERDROP-1): dropped "(atau filter resto
                global)" — the global resto filter no longer exists; export scope
                comes only from the Resto tab's "Filter Resto" picker (focusOutlet). */}
            Pilih section yang ingin di-export — sub-section di bawah tiap
            section juga bisa dicentang sendiri. Laporan PDF dengan desain penuh
            dan grafik. Filter resto mengikuti Filter Resto di tab Resto
            Analysis. Section 13 membandingkan resto fokus dengan pembanding
            pilihan sendiri (resto / area tertentu).
          </DialogDescription>
        </DialogHeader>

        {/* Select All / Deselect All */}
        <div className="flex items-center gap-2 pb-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={selectAll}
          >
            <CheckCheck className="h-3 w-3" /> Pilih Semua
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={deselectAll}
          >
            <Square className="h-3 w-3" /> Kosongkan
          </Button>
          <Badge variant="secondary" className="text-[11px] ml-auto">
            {activeSectionCount}/{EXPORT_SECTIONS.length} section
          </Badge>
        </div>

        {/* Section list — SUBSECTION-1: parent rows + indented sub rows */}
        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {EXPORT_SECTIONS.map((section) => {
            const checked = parentChecked(section);
            const hasSubs = Boolean(section.subs);
            return (
              <div key={section.key} className="space-y-1">
                <label
                  className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                    checked === true
                      ? 'border-primary/40 bg-primary/5'
                      : checked === 'indeterminate'
                        ? 'border-primary/30 bg-primary/[0.03]'
                        : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleSection(section)}
                    className="mt-0.5"
                    aria-label={section.label}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium leading-snug">
                      {section.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-tight">
                      {SECTION_DESCRIPTIONS[section.key] ?? ''}
                    </p>
                  </div>
                  {hasSubs && (
                    <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground mt-0.5 shrink-0">
                      <ChevronRight className="h-3 w-3 rotate-90" />
                      {section.subs?.length} sub
                    </span>
                  )}
                </label>
                {section.subs?.map((sub) => {
                  const token = exportSubToken(section.key, sub.key);
                  const subOn = selected.has(token);
                  return (
                    <label
                      key={token}
                      className={`flex items-center gap-2 rounded-md border ml-6 mr-1 px-2.5 py-1.5 cursor-pointer transition-colors ${
                        subOn
                          ? 'border-primary/25 bg-primary/[0.04]'
                          : 'border-transparent hover:bg-muted/40'
                      }`}
                    >
                      <Checkbox
                        checked={subOn}
                        onCheckedChange={() => toggleSub(section.key, sub.key)}
                        className="h-3.5 w-3.5"
                        aria-label={sub.label}
                      />
                      <span
                        className={`text-[11px] leading-tight ${subOn ? 'text-foreground' : 'text-muted-foreground'}`}
                      >
                        {sub.label}
                      </span>
                    </label>
                  );
                })}
                {/* CUSTOM-COMPARE — the comparator picker rides directly
                    under section 13's rows: checking the section makes the
                    panel appear exactly where the user's eyes are (inside
                    the scrollable list, not above it). */}
                {section.key === 'customCompare' && customCompareActive && (
                  <div className="ml-6 mr-1">
                    <ExportComparatorPicker
                      outlets={outlets}
                      areas={areas}
                      focusOutlet={focusOutlet}
                      focusOutletName={focusOutletName}
                      selectedOutlets={compareOutlets}
                      selectedAreas={compareAreas}
                      onChange={(nextOutlets, nextAreas) => {
                        setCompareOutlets(nextOutlets);
                        setCompareAreas(nextAreas);
                      }}
                    />
                    {compareMissing && (
                      <p
                        className="text-[11px] text-destructive leading-tight px-1 pt-1"
                        role="alert"
                      >
                        Pilih minimal satu resto atau area pembanding untuk
                        section 13 — atau batalkan centangnya.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="shrink-0 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={isExporting}
          >
            Batal
          </Button>
          <Button
            size="sm"
            onClick={handleExport}
            disabled={isExporting || activeSectionCount === 0 || compareMissing}
            className="gap-1.5"
          >
            {isExporting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting...
              </>
            ) : (
              <>
                <FileDown className="h-3.5 w-3.5" /> Export (
                {activeSectionCount} section)
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
