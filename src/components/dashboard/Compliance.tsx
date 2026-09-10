'use client';

// ============================================================
//  Compliance — "Kontrol & Kepatuhan" tab content
//  --------------------------------------------------------
//  Fetches /api/compliance for the selected period (ONE request —
//  the backend merges all six lenses into a single period scan)
//  and renders:
//    0. Summary strip        — headline control KPIs
//    1. Kepatuhan Toleransi  — per-item breach ranking
//    2. Prioritas Penetapan Toleransi — items without tolerance
//    3. Deviasi Tak Terjelaskan (Residual) — per-outlet
//    4. Efisiensi vs Penjualan — |deviasi| / sales ranking
//    5. Kategori BAHAN vs PACKAGING
//    6. Indikasi Transfer Antar Outlet — same item, same area,
//       same week: LOSS outlets vs SURPLUS outlets
//    7. Ketidakcocokan Antar-Area — same item, same week,
//       DIFFERENT areas: LOSS in one area vs SURPLUS in another
//       (cross-area mismatch pairs, derived from the same response)
//    8. Kronis vs Sekali-Timu per Outlet — month-grain second
//       query (/api/chronic-outlets, keyed on month ONLY — does
//       not refetch when the user switches weeks): does this
//       outlet deviate EVERY week (chronic) or only in one
//       dominant week (spike)?
//    9. Kualitas Input: Angka Bulat — share of |qtyDeviasi|
//       ending in 0/5 per outlet vs the period baseline
//       (estimation instead of counting indicator)
//
//  PERF-FE (PAKET A pattern): staleTime 5 min + gcTime 10 min —
//  data only changes on ingest / manual refresh (handleRefresh
//  invalidates ['compliance'] AND ['chronic-outlets']), NOT
//  every 30s global default.
//  keepPreviousData for smooth period switches.
// ============================================================
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ShieldCheck, Gauge, Receipt, ArrowLeftRight, Tags, TriangleAlert, Boxes, Route, CalendarClock, Hash,
} from 'lucide-react';
import { useDashboard } from '@/hooks/useDashboard';
import { useShallow } from 'zustand/shallow';
import { fmtIDR, fmtNum, fmtPctAbs } from '@/lib/format';
import { InfoTooltip } from '@/components/dashboard/InfoTooltip';
import { SectionHeader } from '@/components/dashboard/shared';
import type { ComplianceResult } from '@/lib/queries/compliance';
import type { ChronicOutletsResult } from '@/lib/queries/chronic-outlets';

type ComplianceResponse = ComplianceResult & {
  success: boolean;
  durationMs?: number;
};

type ChronicResponse = ChronicOutletsResult & {
  success: boolean;
  durationMs?: number;
};

// ------------------------------------------------------------
//  Small local presentational helpers
// ------------------------------------------------------------
function StatCard({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'bad' | 'warn' | 'good';
}) {
  const toneClass = tone === 'bad' ? 'text-rose-600 dark:text-rose-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-foreground';
  return (
    <Card className="p-3 sm:p-4">
      <CardContent className="p-0 space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">{label}</p>
        <p className={`text-lg sm:text-xl font-bold tabular-nums leading-none ${toneClass}`}>{value}</p>
        {sub ? <p className="text-[11px] text-muted-foreground leading-tight">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function SectionEmpty({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground px-1 py-3">{text}</p>;
}

function LevelBadge({ level }: { level: 'HIGH' | 'WARN' | 'OK' }) {
  if (level === 'HIGH') return <Badge variant="destructive">Tinggi</Badge>;
  if (level === 'WARN') return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400 border-amber-200 dark:border-amber-800">Waspada</Badge>;
  return <Badge variant="secondary">OK</Badge>;
}

const tableWrap = 'overflow-x-auto -mx-1 px-1';
const th = 'h-8 text-[11px] font-semibold text-muted-foreground whitespace-nowrap';
const td = 'text-xs whitespace-nowrap py-2';

// ------------------------------------------------------------
//  Main component
// ------------------------------------------------------------
export function Compliance() {
  const { monthLabel, currentWeek, area, kelompok, outletCode, pic } = useDashboard(useShallow((s) => ({
    monthLabel: s.monthLabel,
    currentWeek: s.currentWeek,
    area: s.area,
    kelompok: s.kelompok,
    outletCode: s.outletCode,
    pic: s.pic,
  })));

  const { data, isLoading, error } = useQuery({
    queryKey: ['compliance', monthLabel, currentWeek, area, kelompok, outletCode, pic],
    queryFn: async () => {
      // enabled gate guarantees both are set — guard keeps TS happy without
      // non-null assertions (throws defensively if ever violated).
      const month = monthLabel ?? '';
      const week = currentWeek ?? '';
      if (!month || !week) throw new Error('Bulan dan minggu belum dipilih');
      const p = new URLSearchParams();
      p.set('month', month);
      p.set('week', week);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode && outletCode !== 'all') p.set('outlet', outletCode);
      if (pic && pic !== 'all') p.set('pic', pic);
      const res = await fetch(`/api/compliance?${p.toString()}`);
      if (!res.ok) throw new Error('Gagal memuat data kepatuhan');
      return res.json() as Promise<ComplianceResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  const { data: chronicData, isLoading: chronicLoading } = useQuery({
    queryKey: ['chronic-outlets', monthLabel, area, kelompok, outletCode, pic],
    queryFn: async () => {
      const month = monthLabel ?? '';
      if (!month) throw new Error('Bulan belum dipilih');
      const p = new URLSearchParams();
      p.set('month', month);
      if (area && area !== 'all') p.set('area', area);
      if (kelompok && kelompok !== 'all') p.set('kelompok', kelompok);
      if (outletCode && outletCode !== 'all') p.set('outlet', outletCode);
      if (pic && pic !== 'all') p.set('pic', pic);
      const res = await fetch(`/api/chronic-outlets?${p.toString()}`);
      if (!res.ok) throw new Error('Gagal memuat data kronis outlet');
      return res.json() as Promise<ChronicResponse>;
    },
    enabled: Boolean(monthLabel),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Memoize shaped views (tables re-sort nothing — pure slices of the payload)
  const summary = useMemo(() => data?.summary, [data]);
  const toleranceItems = useMemo(() => data?.toleranceItems ?? [], [data]);
  const tolerancePriority = useMemo(() => data?.tolerancePriority ?? [], [data]);
  const residualOutlets = useMemo(() => data?.residualOutlets ?? [], [data]);
  const salesOutlets = useMemo(() => data?.salesOutlets ?? [], [data]);
  const categories = useMemo(() => data?.categories ?? [], [data]);
  const transferSignals = useMemo(() => data?.transferSignals ?? [], [data]);
  const crossAreaPairs = useMemo(() => data?.crossAreaPairs ?? [], [data]);
  const chronicOutlets = useMemo(() => chronicData?.outlets ?? [], [chronicData]);
  const roundOutlets = useMemo(() => data?.roundOutlets ?? [], [data]);
  const roundBaseline = useMemo(() => data?.roundBaseline, [data]);

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-600 dark:text-rose-400">
          Gagal memuat data kepatuhan: {error instanceof Error ? error.message : 'kesalahan tidak diketahui'}
        </CardContent>
      </Card>
    );
  }

  if (isLoading && !data) {
    // Skeleton — reserved blocks (no layout shift)
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Memuat data kepatuhan">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-muted/60 animate-pulse" />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 rounded-xl bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data || !summary) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Pilih bulan dan minggu untuk melihat analisa kepatuhan.
        </CardContent>
      </Card>
    );
  }

  const noData = summary.nRecords === 0;

  return (
    <div className="space-y-4">
      {/* ====== 0. SUMMARY STRIP ====== */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard label="Baris Data" value={fmtNum(summary.nRecords)} sub={`${fmtNum(summary.nOutlets)} outlet · ${fmtNum(summary.nItems)} item`} />
        <StatCard
          label="Kepatuhan Toleransi"
          value={summary.nEval > 0 ? fmtPctAbs(100 - summary.breachRatePct) : '—'}
          sub={summary.nEval > 0 ? `${fmtNum(summary.nBreach)} pelanggaran dari ${fmtNum(summary.nEval)} terukur` : 'tidak ada data toleransi'}
          tone={summary.breachRatePct > 25 ? 'bad' : summary.breachRatePct > 10 ? 'warn' : 'good'}
        />
        <StatCard
          label="Tanpa Toleransi"
          value={fmtPctAbs(summary.noTolerancePct)}
          sub={`${fmtNum(summary.nNotSetHigh)} di atas ambang standar`}
          tone={summary.noTolerancePct > 50 ? 'warn' : undefined}
        />
        <StatCard
          label="Deviasi Tak Terjelaskan"
          value={fmtPctAbs(summary.residualSharePct)}
          sub={`${fmtIDR(summary.residualNominalAbs)} residual`}
          tone={summary.residualSharePct > 50 ? 'bad' : summary.residualSharePct > 30 ? 'warn' : undefined}
        />
        <StatCard
          label="Sinyal Transfer"
          value={fmtNum(summary.transferSignalCount + summary.crossAreaSignalCount)}
          sub={`${fmtIDR(summary.transferMatchNominalTotal + summary.crossAreaMatchNominalTotal)} nilai cocok · ${fmtNum(summary.crossAreaSignalCount)} antar-area`}
          tone={(summary.transferSignalCount + summary.crossAreaSignalCount) > 0 ? 'warn' : undefined}
        />
        <StatCard label="Total |Deviasi|" value={fmtIDR(summary.absNominalDev)} sub="nominal absolut periode" />
      </div>

      {noData ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Tidak ada data pada kombinasi filter/periode ini.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ====== 1. KEPATUHAN TOLERANSI (per item) ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<ShieldCheck className="h-4 w-4" />}
                title="Kepatuhan Toleransi per Item"
                badge={toleranceItems.length > 0 ? `Top ${toleranceItems.length}` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Item dengan nilai |Deviasi/BOM| melampaui toleransi — semantik identik dengan rule engine (f_tol_breach / 2×).
                <InfoTooltip content="Pelanggaran = |Deviasi/BOM| &gt; toleransi item. '2×' = melampaui dua kali toleransi. Nominal di balik pelanggaran = total |nominalDeviasi| baris yang melanggar." />
              </p>
              {toleranceItems.length === 0 ? (
                <SectionEmpty text="Tidak ada pelanggaran toleransi pada periode ini." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Item</TableHead>
                        <TableHead className={`${th} text-right`}>Baris</TableHead>
                        <TableHead className={`${th} text-right`}>Terukur</TableHead>
                        <TableHead className={`${th} text-right`}>Pelanggaran</TableHead>
                        <TableHead className={`${th} text-right`}>2× Toleransi</TableHead>
                        <TableHead className={`${th} text-right`}>Rate</TableHead>
                        <TableHead className={`${th} text-right`}>Nominal Pelanggaran</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {toleranceItems.map((r) => (
                        <TableRow key={r.itemId}>
                          <TableCell className={`${td} font-medium max-w-[220px] truncate`}>
                            {r.itemName}
                            {r.satuan ? <span className="text-muted-foreground font-normal"> · {r.satuan}</span> : null}
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.n)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.nEval)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${r.nBreach > 0 ? 'text-rose-600 dark:text-rose-400 font-semibold' : ''}`}>{fmtNum(r.nBreach)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${r.nBreachHigh > 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{fmtNum(r.nBreachHigh)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>
                            {r.breachRatePct === null ? '—' : (
                              <span className={
                                r.breachRatePct >= 50 ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                  : r.breachRatePct >= 25 ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-muted-foreground'
                              }>{fmtPctAbs(r.breachRatePct)}</span>
                            )}
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${r.nominalBreach > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}`}>{fmtIDR(r.nominalBreach)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 2. PRIORITAS PENETAPAN TOLERANSI ====== */}
          {tolerancePriority.length > 0 && (
            <Card>
              <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
                <SectionHeader
                  icon={<TriangleAlert className="h-4 w-4" />}
                  title="Prioritas Penetapan Toleransi"
                  badge={`${tolerancePriority.length} item`}
                />
                <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                  Item <b>belum punya toleransi</b> tapi deviasinya besar — tetapkan toleransinya dulu di sini.
                  <InfoTooltip content="Baris tanpa toleransi ('BELUM ADA TOLERANSI'). Di atas ambang = |Deviasi/BOM| melebihi ambang standar (STD_DEVIASI_BOM_PCT, dapat diubah di pengaturan). Daftar ini adalah kandidat penetapan toleransi prioritas." />
                </p>
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Item</TableHead>
                        <TableHead className={`${th} text-right`}>Baris Tanpa Toleransi</TableHead>
                        <TableHead className={`${th} text-right`}>Di Atas Ambang</TableHead>
                        <TableHead className={`${th} text-right`}>Rata-rata |Dev/BOM|</TableHead>
                        <TableHead className={`${th} text-right`}>Maksimum</TableHead>
                        <TableHead className={`${th} text-right`}>Nominal</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tolerancePriority.map((r) => (
                        <TableRow key={r.itemId}>
                          <TableCell className={`${td} font-medium max-w-[220px] truncate`}>
                            {r.itemName}
                            {r.satuan ? <span className="text-muted-foreground font-normal"> · {r.satuan}</span> : null}
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.nNoTol)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${r.nNotSetHigh > 0 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}`}>{fmtNum(r.nNotSetHigh)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtPctAbs(r.avgPctNoTol * 100)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtPctAbs(r.maxPctNoTol * 100)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtIDR(r.nominalNoTol)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ====== 3. DEVIASI TAK TERJELASKAN (RESIDUAL) ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<Gauge className="h-4 w-4" />}
                title="Deviasi Tak Terjelaskan per Outlet"
                badge={residualOutlets.length > 0 ? `Top ${residualOutlets.length}` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Residual = deviasi yang <b>tidak</b> dicover waste + susut + trial — indikator penyelidikan terkuat.
                <InfoTooltip content="Residual dihitung dari residualQty = qtyDeviasi − (waste + susut + trial), sama dengan mesin rule (f_resid_warn / f_resid_high). Semakin tinggi porsi tak terjelaskan, semakin kuat indikasi pencurian / salah input — bukan proses normal." />
              </p>
              {residualOutlets.length === 0 ? (
                <SectionEmpty text="Semua deviasi terjelaskan oleh waste/susut/trial pada periode ini." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Outlet</TableHead>
                        <TableHead className={th}>Area</TableHead>
                        <TableHead className={`${th} text-right`}>|Deviasi| Qty</TableHead>
                        <TableHead className={`${th} text-right`}>Residual Qty</TableHead>
                        <TableHead className={`${th} text-right`}>Residual Nominal</TableHead>
                        <TableHead className={`${th} text-right`}>Porsi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {residualOutlets.map((r) => (
                        <TableRow key={r.outletId}>
                          <TableCell className={`${td} font-medium max-w-[200px] truncate`}>
                            {r.outletCode}
                            <span className="text-muted-foreground font-normal"> · {r.outletName}</span>
                          </TableCell>
                          <TableCell className={`${td} text-muted-foreground max-w-[160px] truncate`}>{r.area}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.absQtyDev)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.residualAbs)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${r.level !== 'OK' ? 'text-rose-600 dark:text-rose-400' : ''}`}>{fmtIDR(r.residualNominalAbs)}</TableCell>
                          <TableCell className={`${td} text-right`}>
                            <span className="inline-flex items-center gap-1.5 tabular-nums">
                              {r.unexplainedPct === null ? '—' : fmtPctAbs(r.unexplainedPct)}
                              <LevelBadge level={r.level} />
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 4. EFISIENSI vs PENJUALAN ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<Receipt className="h-4 w-4" />}
                title="Efisiensi vs Penjualan"
                badge={salesOutlets.length > 0 ? `Top ${salesOutlets.length}` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                |Deviasi nominal| dibagi penjualan outlet — pembanding apple-to-appel antar outlet beda ukuran.
                <InfoTooltip content="Outlet tanpa data PENJUALAN otomatis dikecualikan. Persentase tinggi pada outlet kecil sering lebih actionable daripada nominal besar di outlet raksasa." />
              </p>
              {salesOutlets.length === 0 ? (
                <SectionEmpty text="Tidak ada data penjualan pada periode/filter ini." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Outlet</TableHead>
                        <TableHead className={th}>Area</TableHead>
                        <TableHead className={`${th} text-right`}>Penjualan</TableHead>
                        <TableHead className={`${th} text-right`}>|Deviasi| Nominal</TableHead>
                        <TableHead className={`${th} text-right`}>Deviasi / Penjualan</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {salesOutlets.map((r) => (
                        <TableRow key={r.outletId}>
                          <TableCell className={`${td} font-medium max-w-[200px] truncate`}>
                            {r.outletCode}
                            <span className="text-muted-foreground font-normal"> · {r.outletName}</span>
                          </TableCell>
                          <TableCell className={`${td} text-muted-foreground max-w-[160px] truncate`}>{r.area}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtIDR(r.nominalSales)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtIDR(r.absNominalDev)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${
                            r.devPerSalesPct >= 5 ? 'text-rose-600 dark:text-rose-400 font-semibold'
                              : r.devPerSalesPct >= 2 ? 'text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground'
                          }`}>{fmtPctAbs(r.devPerSalesPct, 2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 5. KATEGORI BAHAN vs PACKAGING ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<Tags className="h-4 w-4" />}
                title="Kategori: BAHAN vs PACKAGING"
                badge={categories.length > 0 ? `${categories.length} kategori` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Loss packaging sering luput — padahal langsung jadi biaya tanpa kaitan produksi.
                <InfoTooltip content="Kategori dari master Item (kolom category). Waste/Susut/Trial = rincian nominal penyebab deviasi per kategori." />
              </p>
              {categories.length === 0 ? (
                <SectionEmpty text="Tidak ada data kategori." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Kategori</TableHead>
                        <TableHead className={`${th} text-right`}>Baris</TableHead>
                        <TableHead className={`${th} text-right`}>|Deviasi| Nominal</TableHead>
                        <TableHead className={`${th} text-right`}>Porsi</TableHead>
                        <TableHead className={`${th} text-right`}>Waste</TableHead>
                        <TableHead className={`${th} text-right`}>Susut</TableHead>
                        <TableHead className={`${th} text-right`}>Trial</TableHead>
                        <TableHead className={`${th} text-right`}>Tak Terjelaskan</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {categories.map((r) => (
                        <TableRow key={r.category}>
                          <TableCell className={`${td} font-medium`}>
                            <span className="inline-flex items-center gap-1.5"><Boxes className="h-3 w-3 text-muted-foreground" />{r.category}</span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.n)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums font-medium`}>{fmtIDR(r.absNominalDev)}</TableCell>
                          <TableCell className={`${td} text-right`}>
                            <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
                              <span className="hidden sm:inline-block h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                                <span className="block h-full bg-amber-500" style={{ width: `${Math.min(100, r.sharePct)}%` }} />
                              </span>
                              {fmtPctAbs(r.sharePct)}
                            </span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-muted-foreground`}>{fmtIDR(r.nominalWaste)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-muted-foreground`}>{fmtIDR(r.nominalSusut)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-muted-foreground`}>{fmtIDR(r.nominalTrial)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${r.residualNominalAbs > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}`}>{fmtIDR(r.residualNominalAbs)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 6. INDIKASI TRANSFER ANTAR OUTLET ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<ArrowLeftRight className="h-4 w-4" />}
                title="Indikasi Transfer Antar Outlet"
                badge={transferSignals.length > 0 ? `Top ${transferSignals.length}` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Item yang sama, minggu yang sama, area yang sama: ada outlet <b>loss</b> dan outlet <b>surplus</b> sekaligus.
                <InfoTooltip content="Pola loss di satu outlet + surplus di outlet lain pada item & minggu yang sama biasanya menandakan stok berpindah tanpa dokumen, atau kesalahan pencatatan di kedua sisi. 'Nilai cocok' = min(total loss, total surplus) — perkiraan maksimum nilai yang 'berpindah'." />
              </p>
              {transferSignals.length === 0 ? (
                <SectionEmpty text="Tidak ada pola loss↔surplus serentak pada item yang sama." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Item</TableHead>
                        <TableHead className={th}>Area</TableHead>
                        <TableHead className={`${th} text-right`}>Outlets LOSS</TableHead>
                        <TableHead className={`${th} text-right`}>Total Qty LOSS</TableHead>
                        <TableHead className={`${th} text-right`}>Outlets SURPLUS</TableHead>
                        <TableHead className={`${th} text-right`}>Total Qty SURPLUS</TableHead>
                        <TableHead className={`${th} text-right`}>Nilai Cocok</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transferSignals.map((r) => (
                        <TableRow key={`${r.itemId}-${r.area}`}>
                          <TableCell className={`${td} font-medium max-w-[200px] truncate`}>{r.itemName}</TableCell>
                          <TableCell className={`${td} text-muted-foreground max-w-[150px] truncate`}>{r.area}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-rose-600 dark:text-rose-400`}>
                            {fmtNum(r.loss.nOutlets)}
                            {r.loss.topOutletCode ? <span className="block text-[10px] text-muted-foreground font-normal">terbesar: {r.loss.topOutletCode}</span> : null}
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-rose-600 dark:text-rose-400`}>{fmtNum(r.loss.qtyTotal)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-emerald-600 dark:text-emerald-400`}>
                            {fmtNum(r.surplus.nOutlets)}
                            {r.surplus.topOutletCode ? <span className="block text-[10px] text-muted-foreground font-normal">terbesar: {r.surplus.topOutletCode}</span> : null}
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-emerald-600 dark:text-emerald-400`}>{fmtNum(r.surplus.qtyTotal)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums font-semibold`}>
                            {fmtNum(r.matchQty)} qty
                            <span className="block text-[10px] text-muted-foreground font-normal">{fmtIDR(r.matchNominal)}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 7. KETIDAKCOCOKAN ANTAR-AREA ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<Route className="h-4 w-4" />}
                title="Ketidakcocokan Antar-Area"
                badge={crossAreaPairs.length > 0 ? `Top ${crossAreaPairs.length}` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Item yang sama, minggu yang sama, <b>area berbeda</b>: loss terkonsentrasi di satu area, surplus muncul di area lain.
                <InfoTooltip content="Pola loss di area A + surplus di area B pada item &amp; minggu yang sama biasanya menandakan stok berpindah ANTAR AREA tanpa dokumen transfer (mutasi gudang/area), atau pencatatan ganda di kedua area. 'Nilai cocok' = min(total loss area A, total surplus area B). Catatan: pasangan antar-area adalah kandidat penyelidikan, BUKAN partisi — satu sisi bisa muncul di beberapa pasangan. Sinyal ini hanya muncul saat filter area tidak aktif." />
              </p>
              {crossAreaPairs.length === 0 ? (
                <SectionEmpty text="Tidak ada pasangan loss↔surplus antar-area pada item yang sama (sinyal antar-area hanya muncul saat filter area tidak aktif)." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Item</TableHead>
                        <TableHead className={th}>Area LOSS</TableHead>
                        <TableHead className={`${th} text-right`}>Qty LOSS</TableHead>
                        <TableHead className={th}>Area SURPLUS</TableHead>
                        <TableHead className={`${th} text-right`}>Qty SURPLUS</TableHead>
                        <TableHead className={`${th} text-right`}>Nilai Cocok</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {crossAreaPairs.map((r) => (
                        <TableRow key={`${r.itemId}-${r.lossArea}-${r.surplusArea}`}>
                          <TableCell className={`${td} font-medium max-w-[200px] truncate`}>{r.itemName}</TableCell>
                          <TableCell className={`${td} max-w-[140px] truncate`}>
                            <span className="text-rose-600 dark:text-rose-400 font-medium">{r.lossArea}</span>
                            <span className="block text-[10px] text-muted-foreground font-normal">
                              {fmtNum(r.loss.nOutlets)} outlet{r.loss.topOutletCode ? ` · terbesar: ${r.loss.topOutletCode}` : ''}
                            </span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-rose-600 dark:text-rose-400`}>{fmtNum(r.loss.qtyTotal)}</TableCell>
                          <TableCell className={`${td} max-w-[140px] truncate`}>
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{r.surplusArea}</span>
                            <span className="block text-[10px] text-muted-foreground font-normal">
                              {fmtNum(r.surplus.nOutlets)} outlet{r.surplus.topOutletCode ? ` · terbesar: ${r.surplus.topOutletCode}` : ''}
                            </span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-emerald-600 dark:text-emerald-400`}>{fmtNum(r.surplus.qtyTotal)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums font-semibold`}>
                            {fmtNum(r.matchQty)} qty
                            <span className="block text-[10px] text-muted-foreground font-normal">{fmtIDR(r.matchNominal)}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 8. KRONIS vs SEKALI-TIMU (per outlet, bulan) ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<CalendarClock className="h-4 w-4" />}
                title="Kronis vs Sekali-Timu per Outlet"
                badge={chronicData ? `${fmtNum(chronicData.chronicCount)} kronis · ${fmtNum(chronicData.spikeCount)} spike` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Sepanjang bulan {monthLabel} (tidak tergantung minggu terpilih): outlet <b>kronis</b> menyimpang hampir tiap minggu — outlet <b>spike</b> buruk hanya di satu minggu dominan.
                <InfoTooltip content="KRONIS = deviasi di &ge;3 minggu DAN &ge;75% minggu yang ada datanya → masalah sistemik (proses/PIC/kebocoran), layak audit mendalam. SPIKE = minggu terburuk menampung &ge;60% |deviasi| bulanan (min. 2 minggu data) → peristiwa sekali-timu, cek kejadian minggu itu. 'Minggu residual' = minggu dengan deviasi tak terjelaskan &gt; 0. Analisa ini level BULAN — mengganti minggu tidak mengubahnya." />
              </p>
              {!chronicData && chronicLoading ? (
                <div className="h-32 rounded-xl bg-muted/40 animate-pulse" />
              ) : chronicOutlets.length === 0 ? (
                <SectionEmpty text="Tidak ada outlet berdeviasi pada bulan ini (dengan filter aktif)." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Outlet</TableHead>
                        <TableHead className={th}>Area</TableHead>
                        <TableHead className={`${th} text-right`}>Minggu Deviasi</TableHead>
                        <TableHead className={th}>Arah</TableHead>
                        <TableHead className={`${th} text-right`}>Total |Dev| Bulan</TableHead>
                        <TableHead className={`${th} text-right`}>Rata / Minggu Dev</TableHead>
                        <TableHead className={th}>Minggu Terburuk</TableHead>
                        <TableHead className={th}>Klasifikasi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {chronicOutlets.map((r) => (
                        <TableRow key={r.outletId}>
                          <TableCell className={`${td} font-medium max-w-[200px] truncate`}>
                            {r.outletCode}
                            <span className="text-muted-foreground font-normal"> · {r.outletName}</span>
                          </TableCell>
                          <TableCell className={`${td} text-muted-foreground max-w-[140px] truncate`}>{r.area}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>
                            {fmtNum(r.nDevWeeks)}/{fmtNum(r.nWeeks)}
                            {r.nResidWeeks > 0 ? (
                              <span className="block text-[10px] text-muted-foreground font-normal">residual: {fmtNum(r.nResidWeeks)} mgg</span>
                            ) : null}
                          </TableCell>
                          <TableCell className={`${td}`}>
                            <span className={
                              r.dominant === 'LOSS' ? 'text-rose-600 dark:text-rose-400'
                                : r.dominant === 'SURPLUS' ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-muted-foreground'
                            }>{r.dominant === 'LOSS' ? 'Loss' : r.dominant === 'SURPLUS' ? 'Surplus' : 'Campuran'}</span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums font-medium`}>{fmtIDR(r.totalAbsNom)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-muted-foreground`}>{fmtIDR(r.avgPerDevWeek)}</TableCell>
                          <TableCell className={`${td}`}>
                            {r.maxWeekLabel ? (
                              <>
                                <span className="tabular-nums">{r.maxWeekLabel}</span>
                                <span className="block text-[10px] text-muted-foreground font-normal">{fmtIDR(r.maxWeekAbs)} · {fmtPctAbs(r.maxWeekSharePct)} dari bulan</span>
                              </>
                            ) : '—'}
                          </TableCell>
                          <TableCell className={`${td}`}>
                            {r.classification === 'CHRONIC' ? <Badge variant="destructive">Kronis</Badge>
                              : r.classification === 'SPIKE' ? (
                                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400 border-amber-200 dark:border-amber-800">Spike</Badge>
                              ) : <Badge variant="secondary">Variabel</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ====== 9. KUALITAS INPUT: ANGKA BULAT ====== */}
          <Card>
            <CardContent className="p-3 sm:p-4 pt-3 sm:pt-4 space-y-2">
              <SectionHeader
                icon={<Hash className="h-4 w-4" />}
                title="Kualitas Input: Angka Bulat per Outlet"
                badge={roundBaseline && roundBaseline.nDev > 0 ? `baseline ${fmtPctAbs(roundBaseline.share5Pct)}` : undefined}
              />
              <p className="text-[11px] text-muted-foreground -mt-1 px-1 flex items-center gap-1">
                Share |qtyDeviasi| berakhiran <b>0/5</b> per outlet — outlet yang <b>menaksir</b> (bukan menghitung fisik) cenderung jauh di atas baseline.
                <InfoTooltip content="Angka bulat = ROUND(|qtyDeviasi| × 10) habis dibagi 5 (berakhir .0/.5 atau digit akhir 5/0); tingkat ketat 'berakhir 0' = habis dibagi 10. Stok yang benar-benar dihitung jarang sering berakhir 0/5. Δ = share outlet − baseline seluruh periode (berbagi satuan kemasan bisa membuat angka bulat wajar — selalu bandingkan dengan baseline). Outlet dengan &lt; 3 baris deviasi dikecualikan." />
              </p>
              {roundOutlets.length === 0 ? (
                <SectionEmpty text="Tidak cukup baris deviasi (min 3 per outlet) untuk analisa angka bulat." />
              ) : (
                <div className={tableWrap}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={th}>Outlet</TableHead>
                        <TableHead className={th}>Area</TableHead>
                        <TableHead className={`${th} text-right`}>Baris Deviasi</TableHead>
                        <TableHead className={`${th} text-right`}>Bulat 0/5</TableHead>
                        <TableHead className={`${th} text-right`}>Bulat 0</TableHead>
                        <TableHead className={`${th} text-right`}>Δ vs Baseline</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {roundOutlets.map((r) => (
                        <TableRow key={r.outletId}>
                          <TableCell className={`${td} font-medium max-w-[200px] truncate`}>
                            {r.outletCode}
                            <span className="text-muted-foreground font-normal"> · {r.outletName}</span>
                          </TableCell>
                          <TableCell className={`${td} text-muted-foreground max-w-[140px] truncate`}>{r.area}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>{fmtNum(r.nDev)}</TableCell>
                          <TableCell className={`${td} text-right tabular-nums`}>
                            {fmtPctAbs(r.share5Pct)}
                            <span className="block text-[10px] text-muted-foreground font-normal">{fmtNum(r.nRound5)} baris</span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums text-muted-foreground`}>
                            {fmtPctAbs(r.share10Pct)}
                            <span className="block text-[10px] text-muted-foreground font-normal">{fmtNum(r.nRound10)} baris</span>
                          </TableCell>
                          <TableCell className={`${td} text-right tabular-nums ${
                            r.delta5Pct >= 15 ? 'text-rose-600 dark:text-rose-400 font-semibold'
                              : r.delta5Pct >= 8 ? 'text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground'
                          }`}>
                            {r.delta5Pct >= 0 ? '+' : ''}{fmtPctAbs(r.delta5Pct)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
