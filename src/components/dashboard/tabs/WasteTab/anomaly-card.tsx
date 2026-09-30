'use client';

// ============================================================
//  WasteAnomalyCard — "Anomali Waste" (DEEP-WASTE-1)
//  --------------------------------------------------------
//  Finding list derived from the waste-series payload, sorted by
//  severity (KRITIS = zero-waste-big-loss; TINGGI = spike months;
//  SEDANG = residual-dominant + under-recording) — the in-app
//  version of the offline report's "Anomali Waste" sheet (10
//  kejadian) + the severity chips of the Ringkasan sheet.
//  Props-driven (parent owns the query).
// ============================================================

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import type { WasteMonthlyRow, WasteOutletRow } from './types';

interface WasteFinding {
  key: string;
  severity: 'KRITIS' | 'TINGGI' | 'SEDANG';
  outletCode: string;
  outletName: string;
  title: string;
  detail: string;
}

const SEVERITY_ORDER: Record<WasteFinding['severity'], number> = { KRITIS: 0, TINGGI: 1, SEDANG: 2 };

function severityBadgeClass(sev: WasteFinding['severity']): string {
  if (sev === 'KRITIS') return 'text-red-600 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30';
  if (sev === 'TINGGI') return 'text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30';
  return 'text-yellow-700 dark:text-yellow-400 border-yellow-300/70 dark:border-yellow-800/70 bg-yellow-50/60 dark:bg-yellow-950/30';
}

/** Derive the findings list from the outlets + monthly rows. Pure-ish (useMemo). */
function buildFindings(outlets: WasteOutletRow[], monthly: WasteMonthlyRow[]): WasteFinding[] {
  const findings: WasteFinding[] = [];
  const spikeMonthsByOutlet = new Map<string, string[]>();
  for (const r of monthly) {
    if (r.spike) {
      const list = spikeMonthsByOutlet.get(r.outletCode) ?? [];
      list.push(r.monthLabel);
      spikeMonthsByOutlet.set(r.outletCode, list);
    }
  }
  for (const o of outlets) {
    if (o.zeroWasteBigLoss) {
      findings.push({
        key: `${o.outletCode}-w0`,
        severity: 'KRITIS',
        outletCode: o.outletCode,
        outletName: o.outletName,
        title: 'Waste ≈ 0 dengan loss besar',
        detail: `Total waste hanya ${fmtIDR(o.waste)} selama ${o.months} bulan, tapi total loss ${fmtIDR(o.totalLoss)} — kerugian besar tanpa pencatatan waste (dicurigai tidak tercatat / salah posting).`,
      });
    }
    const spikeMonths = spikeMonthsByOutlet.get(o.outletCode) ?? [];
    if (spikeMonths.length > 0) {
      findings.push({
        key: `${o.outletCode}-spike`,
        severity: 'TINGGI',
        outletCode: o.outletCode,
        outletName: o.outletName,
        title: `Lonjakan waste > 2σ (${spikeMonths.length}×)`,
        detail: `Waste/sales meledak di atas mean + 2σ riwayat window sendiri pada: ${spikeMonths.join(', ')} — cek kejadian operasional (salah resep, spoilage massal, atau error input).`,
      });
    }
    if (o.residualDominant) {
      findings.push({
        key: `${o.outletCode}-rd`,
        severity: 'SEDANG',
        outletCode: o.outletCode,
        outletName: o.outletName,
        title: 'Residual dominan — waste tidak menjelaskan loss',
        detail: `Residual ${fmtPct(o.residualShare, false, 0)} dari loss sementara waste hanya ${fmtPct(o.wasteShareOfLoss, false, 1)} — selisih tak terjelaskan mendominasi, perlu investigasi dokumen.`,
      });
    }
    if (o.underRecording) {
      findings.push({
        key: `${o.outletCode}-ur`,
        severity: 'SEDANG',
        outletCode: o.outletCode,
        outletName: o.outletName,
        title: 'Waste/sales < 0,1% (kronis)',
        detail: `Rasio waste/sales hanya ${fmtPct(o.wasteToSales, false, 2)} selama ${o.months} bulan dengan sales ${fmtIDR(o.sales)} — indikasi under-recording waste kronis.`,
      });
    }
  }
  findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.outletCode.localeCompare(b.outletCode));
  return findings.slice(0, 20);
}

export const WasteAnomalyCard = memo(function WasteAnomalyCard({
  outlets,
  monthly,
}: {
  outlets: WasteOutletRow[];
  monthly: WasteMonthlyRow[];
}) {
  const findings = useMemo(() => buildFindings(outlets, monthly), [outlets, monthly]);

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
          Anomali Waste — Temuan Ber-Severity
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Maks. 20 temuan pada scope aktif, terurut severity: KRITIS (waste ≈ 0 + loss besar) → TINGGI (lonjakan &gt; 2σ) →
          SEDANG (residual dominan / under-recording). Aturan yang sama berjalan di level record pada engine anomali
          (WASTE_ZERO_BIG_LOSS / WASTE_SPIKE_2SIGMA / WASTE_RESIDUAL_DOMINANT / WASTE_SALES_UNDER_RECORD).
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {findings.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Tidak ada temuan anomali waste pada scope ini — semua outlet dalam batas normal.
          </div>
        ) : (
          <div className="max-h-96 overflow-auto waste-scroll divide-y">
            {findings.map((f) => (
              <div key={f.key} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40 dark:hover:bg-zinc-800/30">
                <Badge variant="outline" className={`text-[10px] font-semibold shrink-0 mt-0.5 ${severityBadgeClass(f.severity)}`}>
                  {f.severity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    <span className="font-semibold">{f.outletCode}</span>
                    <span className="text-muted-foreground font-normal"> · {f.outletName}</span>
                    <span className="text-muted-foreground"> — {f.title}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{f.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});
