'use client';

// ============================================================
//  WasteQuadrantCard — W3 "Kuadran Sistemik vs Insiden"
//  --------------------------------------------------------
//  Item-level prevalence × persistence quadrant: is an item's waste
//  a GLOBAL recipe/process problem (many outlets × many months —
//  SISTEMIK) or a LOCAL one-off (INSIDEN)?
//    X = prevalence  (outlet waste>0 / outlet ber-BOM, %)
//    Y = persistence (bulan aktif / bulan window, %)
//    bubble size     = share of the network's total waste
//    color           = quadrant class
//  Guide lines at the thresholds + corner labels name the four
//  quadrants; below the chart a compact table lists the items with
//  the exact counts (prevalence "X/Y outlet", persistence "M/W
//  bulan") so a 1/1 outlet reading is never mistaken for 343/343.
//  Self-fetching (/api/waste-top-items) with the SAME queryKey as
//  the Pareto card — one network request feeds both cards (react-
//  query dedup), same filter params + 5-min staleTime conventions.
//
//  Epistemics: INDIKASI — the quadrant is a PATTERN classification
//  (prevalence × persistence), not a root cause. SISTEMIK items are
//  CANDIDATES for recipe/process-level fixes (action framing), to
//  be validated against resep/SOP prep before any program.
//
//  Local response types: the tab-level ./types.ts is frozen for this
//  task — the card defines its own additive mirror (pareto-card's
//  local-type pattern; the server fields it does not know about are
//  simply absent from the older mirror and optional here).
// ============================================================

import { memo, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Grid2x2 } from 'lucide-react';
import { fmtIDR, fmtPct } from '@/lib/format';
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid,
  ResponsiveContainer, ReferenceLine, Customized, Cell,
} from 'recharts';

// ------------------------------------------------------------
// Local response mirror (additive-only reading of the route payload)
// ------------------------------------------------------------

type QuadrantClass = 'SISTEMIK' | 'MUSIMAN' | 'LOKAL-KRONIS' | 'INSIDEN';

interface ItemQuadrant {
  quadrantClass: QuadrantClass;
  /** outletsActive(waste>0) / outletsWithBom — null = no BOM basis. */
  prevalence: number | null;
  outletsWithBom: number;
  /** monthsActive / windowMonths. */
  persistence: number;
  /** Σ(share²) per outlet — null when < 10 active outlets. */
  hhi: number | null;
}

interface QuadrantSummary {
  persistenceThresholdMonths: number;
  paretoK: number | null;
  classCounts: Record<QuadrantClass, number>;
  windowMonths: number;
}

interface QuadrantItem {
  itemId: number;
  itemName: string;
  totalWaste: number;
  outletsActive: number;
  monthsActive: number;
  share: number;
  // Optional: a cached pre-W3 response (5-min TTL) can predate the field.
  quadrant?: ItemQuadrant | null;
}

interface WasteQuadrantResponse {
  success: boolean;
  items?: QuadrantItem[];
  windowMonths?: number;
  quadrant?: QuadrantSummary | null;
  error?: string;
}

// ------------------------------------------------------------
// Thresholds + palette (local mirrors of the server constants —
// the query module cannot be imported into a client bundle; the
// server summary re-sends the adaptive persistence threshold)
// ------------------------------------------------------------

/** Mirror of WASTE_QUADRANT_PREVALENCE_MIN (0.5 → guide line at 50%). */
const PREVALENCE_MIN = 0.5;

/** Bubble radius: 4 + 10·√(share/maxShare) — area-feel scaling. */
const BUBBLE_R_MIN = 4;
const BUBBLE_R_SPAN = 10;

const CLASS_COLOR: Record<QuadrantClass, string> = {
  SISTEMIK: '#dc2626',      // red-600 — action framing (recipe/process candidate)
  MUSIMAN: '#f59e0b',       // amber-500 — the waste color
  'LOKAL-KRONIS': '#8b5cf6', // violet-500 — chronic but local
  INSIDEN: '#a1a1aa',       // zinc-400 — one-off, deprioritize
};

const CLASS_BADGE_CLASS: Record<QuadrantClass, string> = {
  SISTEMIK: 'text-red-700 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/60 dark:bg-red-950/30',
  MUSIMAN: 'text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30',
  'LOKAL-KRONIS': 'text-violet-700 dark:text-violet-400 border-violet-300/70 dark:border-violet-800/70 bg-violet-50/60 dark:bg-violet-950/30',
  INSIDEN: 'text-zinc-600 dark:text-zinc-400 border-zinc-300/70 dark:border-zinc-700/70 bg-zinc-50/60 dark:bg-zinc-900/30',
};

const CLASS_LEGEND: ReadonlyArray<{ cls: QuadrantClass; label: string }> = [
  { cls: 'SISTEMIK', label: 'SISTEMIK · resep/proses lintas outlet' },
  { cls: 'MUSIMAN', label: 'MUSIMAN · luas tapi tidak kronis' },
  { cls: 'LOKAL-KRONIS', label: 'LOKAL-KRONIS · segelintir outlet, kronis' },
  { cls: 'INSIDEN', label: 'INSIDEN · insiden sekali' },
];

interface ScatterPoint {
  x: number; // prevalence % (0..100)
  y: number; // persistence % (0..100)
  r: number; // bubble radius (px)
  fill: string;
  itemName: string;
  itemId: number;
  prevalenceRaw: number | null;
  outletsActive: number;
  outletsWithBom: number;
  monthsActive: number;
  windowMonths: number;
  hhi: number | null;
  share: number;
  totalWaste: number;
  quadrantClass: QuadrantClass;
}

/** Corner labels via recharts Customized: exact quadrant-corner text
 *  anchored to the plot-area rectangle the chart passes as `offset`.
 *  Geometry: X = prevalence (left→right), Y = persistence (bottom→top):
 *  top-left = LOKAL-KRONIS · top-right = SISTEMIK ·
 *  bottom-left = INSIDEN · bottom-right = MUSIMAN. */
function QuadrantCornerLabels(props: { offset?: { x: number; y: number; width: number; height: number } }) {
  const off = props.offset;
  if (!off) return null;
  const fill = 'var(--muted-foreground)';
  const fontSize = 9;
  const pad = 4;
  return (
    <g aria-hidden="true">
      <text x={off.x + pad} y={off.y + fontSize + pad / 2} fontSize={fontSize} fill={fill} opacity={0.85}>
        LOKAL-KRONIS
      </text>
      <text
        x={off.x + off.width - pad}
        y={off.y + fontSize + pad / 2}
        fontSize={fontSize}
        fill={fill}
        opacity={0.85}
        textAnchor="end"
      >
        SISTEMIK
      </text>
      <text x={off.x + pad} y={off.y + off.height - pad} fontSize={fontSize} fill={fill} opacity={0.85}>
        INSIDEN
      </text>
      <text
        x={off.x + off.width - pad}
        y={off.y + off.height - pad}
        fontSize={fontSize}
        fill={fill}
        opacity={0.85}
        textAnchor="end"
      >
        MUSIMAN
      </text>
    </g>
  );
}

export const WasteQuadrantCard = memo(function WasteQuadrantCard({
  monthLabel,
  currentWeek,
  area,
  kelompok,
  pic,
}: {
  monthLabel: string;
  currentWeek: string;
  area: string | null;
  kelompok: string | null;
  pic: string | null;
}) {
  // Same key + params as the Pareto card: react-query dedups the pair into
  // ONE /api/waste-top-items request; the filters re-fetch on change.
  const { data, isLoading, error } = useQuery<WasteQuadrantResponse>({
    queryKey: ['waste-top-items', monthLabel, currentWeek, area, kelompok, pic],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('month', monthLabel);
      p.set('week', currentWeek);
      if (area) p.set('area', area);
      if (kelompok) p.set('kelompok', kelompok);
      if (pic) p.set('pic', pic);
      const res = await fetch(`/api/waste-top-items?${p.toString()}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server error (HTTP ${res.status}). ${text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<WasteQuadrantResponse>;
    },
    enabled: Boolean(monthLabel && currentWeek),
    // PERF-FE (PAKET A) convention: only changes on ingest / manual refresh.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Stable array identity for the useMemos below (data?.items || [] would
  // mint a new [] each render and trip exhaustive-deps).
  const items = useMemo(() => data?.items ?? [], [data]);
  const windowMonths = data?.windowMonths ?? 0;
  const summary = data?.quadrant ?? null;
  // Adaptive persistence threshold (FIX 2 pattern): trust the server's
  // summary first; fall back to deriving it from the ACTUAL windowMonths
  // (never the 12-month cap's 6). Null → no Y guide line (no window).
  const thresholdMonths =
    summary?.persistenceThresholdMonths ?? (windowMonths > 0 ? Math.ceil(windowMonths / 2) : null);
  const yThresholdPct =
    thresholdMonths != null && windowMonths > 0 ? (thresholdMonths / windowMonths) * 100 : null;

  const { points, classCounts } = useMemo(() => {
    let max = 0;
    for (const it of items) if (it.share > max) max = it.share;
    const counts: Record<QuadrantClass, number> = { SISTEMIK: 0, MUSIMAN: 0, 'LOKAL-KRONIS': 0, INSIDEN: 0 };
    const pts: ScatterPoint[] = [];
    for (const it of items) {
      const q = it.quadrant;
      if (!q) continue;
      if (q.quadrantClass in counts) counts[q.quadrantClass] += 1;
      // Prevalence null (no BOM basis) has no X position — the item stays in
      // the table with an honest "—", it is not forced to 0%.
      if (q.prevalence == null || windowMonths <= 0) continue;
      pts.push({
        x: q.prevalence * 100,
        y: q.persistence * 100,
        r: BUBBLE_R_MIN + BUBBLE_R_SPAN * Math.sqrt(max > 0 ? it.share / max : 0),
        fill: CLASS_COLOR[q.quadrantClass],
        itemName: it.itemName,
        itemId: it.itemId,
        prevalenceRaw: q.prevalence,
        outletsActive: it.outletsActive,
        outletsWithBom: q.outletsWithBom,
        monthsActive: it.monthsActive,
        windowMonths,
        hhi: q.hhi,
        share: it.share,
        totalWaste: it.totalWaste,
        quadrantClass: q.quadrantClass,
      });
    }
    return { points: pts, classCounts: counts };
  }, [items, windowMonths]);

  // role="img" + descriptive label (house a11y gap — only 1/14 charts had
  // it): the quadrant geometry + every plotted item's exact numbers, so
  // color/position is never the only signal.
  const ariaLabel = useMemo(() => {
    const guide =
      thresholdMonths != null && windowMonths > 0
        ? `Ambang kuadran: prevalence ≥ 50% outlet ber-BOM dan persistensi ≥ ${thresholdMonths} dari ${windowMonths} bulan.`
        : 'Ambang kuadran: prevalence ≥ 50% outlet ber-BOM.';
    const listed = points
      .map(
        (p) =>
          `${p.itemName}: prevalence ${p.outletsActive}/${p.outletsWithBom} outlet, persistensi ${p.monthsActive}/${p.windowMonths} bulan, share ${fmtPct(p.share, false, 1)}, kelas ${p.quadrantClass}`,
      )
      .join('; ');
    return `Diagram kuadran prevalence × persistensi item waste. ${guide}${listed ? ` Titik: ${listed}.` : ' Tidak ada titik terplot.'}`;
  }, [points, thresholdMonths, windowMonths]);

  const paretoK = summary?.paretoK ?? null;
  const sistK = classCounts.SISTEMIK;

  return (
    <Card className="overflow-hidden shadow-md shadow-black/5 dark:shadow-black/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2.5 flex-wrap">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-zinc-100 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300 shrink-0">
            <Grid2x2 className="h-3.5 w-3.5" />
          </span>
          Kuadran Sistemik vs Insiden
          {/* Epistemic label (house convention — InsightsPanel style):
              pattern classification, NOT root cause. */}
          <Badge
            variant="outline"
            className="text-[10px] font-normal h-5 text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-800/70 bg-amber-50/60 dark:bg-amber-950/30"
            title="Klasifikasi pola prevalence × persistence dari data window — INDIKASI, bukan root cause. Validasi resep/SOP sebelum aksi."
          >
            INDIKASI
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground ml-9">
          Waste bahan ini masalah resep/proses GLOBAL (banyak outlet × banyak bulan) atau insiden lokal? Sumbu X = prevalence
          (outlet waste&gt;0 / outlet ber-BOM), sumbu Y = persistensi (bulan aktif / bulan window), ukuran bubble = share waste network.
          <span className="font-medium text-foreground/70"> SISTEMIK</span> = kandidat masalah resep/proses lintas outlet —
          benahi di akar (resep/SOP prep), bukan kejaran per outlet.
        </p>
        {(paretoK != null || sistK > 0) && (
          <div className="flex items-center gap-2 pt-2 flex-wrap ml-9">
            {paretoK != null && (
              <Badge variant="secondary" className="text-xs tabular-nums font-medium" title="Jumlah item Pareto untuk mencapai 80% total waste scope (kumulatif share).">
                Pareto k = {paretoK} item → 80%
              </Badge>
            )}
            {sistK > 0 && (
              <Badge variant="outline" className="text-[10px] font-normal h-5 text-red-700 dark:text-red-400 border-red-300/70 dark:border-red-800/70 bg-red-50/50 dark:bg-red-950/30" title="Item di kuadran SISTEMIK (prevalence ≥ 50% outlet ber-BOM DAN persistensi ≥ separuh window).">
                {sistK} item sistemik
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Memuat kuadran waste…</div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600 dark:text-red-400">{error.message}</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Tidak ada item waste pada scope ini.</div>
        ) : (
          <>
            {/* Responsive height: compact on mobile, roomier from sm up
                (same sizing family as sibling Recharts cards). */}
            <div className="h-56 sm:h-72 px-2 sm:px-4 pt-2" role="img" aria-label={ariaLabel}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 14, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" className="opacity-60" />
                  <XAxis
                    type="number"
                    dataKey="x"
                    name="Prevalence"
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tickFormatter={(v: number) => `${v}%`}
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    name="Persistensi"
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tickFormatter={(v: number) => `${v}%`}
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    stroke="var(--border)"
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  {/* Quadrant guide lines: X at the prevalence threshold
                      (50% of BOM outlets), Y at the ADAPTIVE persistence
                      threshold (server-sent months ÷ window months — FIX 2:
                      follows the real window, not the 12-month cap). */}
                  <ReferenceLine
                    x={PREVALENCE_MIN * 100}
                    stroke="var(--muted-foreground)"
                    strokeDasharray="4 4"
                    strokeOpacity={0.55}
                  />
                  {yThresholdPct != null && (
                    <ReferenceLine
                      y={yThresholdPct}
                      stroke="var(--muted-foreground)"
                      strokeDasharray="4 4"
                      strokeOpacity={0.55}
                    />
                  )}
                  <Customized component={QuadrantCornerLabels} />
                  <RTooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const d = payload[0].payload as ScatterPoint;
                      return (
                        <div className="rounded-lg border bg-popover p-2.5 text-[11px] shadow-lg max-w-[260px]">
                          <div className="font-semibold border-b pb-1 mb-1">{d.itemName}</div>
                          <div className="text-muted-foreground tabular-nums">
                            Kuadran: <span style={{ color: d.fill }} className="font-medium">{d.quadrantClass}</span>
                          </div>
                          <div className="text-muted-foreground tabular-nums">
                            Prevalence: {d.outletsActive}/{d.outletsWithBom} outlet ({fmtPct(d.prevalenceRaw ?? 0, false, 0)})
                          </div>
                          <div className="text-muted-foreground tabular-nums">
                            Persistensi: {d.monthsActive}/{d.windowMonths} bulan ({fmtPct(d.y / 100, false, 0)})
                          </div>
                          <div className="text-muted-foreground tabular-nums">Share waste: {fmtPct(d.share, false, 1)} · {fmtIDR(d.totalWaste)}</div>
                          <div className="text-muted-foreground tabular-nums">
                            HHI: {d.hhi != null ? d.hhi.toFixed(3).replace('.', ',') : '—'}
                          </div>
                        </div>
                      );
                    }}
                  />
                  {/* PERF (AUDIT-FE): animations off — tab re-mounts replay
                      the entrance animation otherwise. */}
                  <Scatter data={points} isAnimationActive={false}>
                    {points.map((p) => (
                      <Cell key={p.itemId} fill={p.fill} stroke="var(--background)" strokeWidth={1} r={p.r} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            {/* Legend with live counts (mirror of the summary's classCounts). */}
            <div className="flex items-center justify-center gap-x-4 gap-y-1 flex-wrap text-[10px] text-muted-foreground mt-1 px-4">
              {CLASS_LEGEND.map(({ cls, label }) => (
                <span key={cls} className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CLASS_COLOR[cls] }} />
                  {label}
                  {classCounts[cls] > 0 && <span className="tabular-nums">({classCounts[cls]})</span>}
                </span>
              ))}
            </div>

            {/* Compact table: exact counts behind the plotted position.
                Long-list convention = profile-table's CURRENT pattern:
                max-h-96 + overflow-auto (the old "waste-scroll" custom
                scrollbar class was dead CSS, removed in BUGHUNT-R2 —
                deliberately NOT reintroduced). */}
            <div className="max-h-96 overflow-auto mt-3">
              <Table className="min-w-[760px]">
                <TableHeader className="sticky top-0 bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm z-10">
                  <TableRow className="border-b hover:bg-transparent">
                    <TableHead className="text-xs font-semibold uppercase tracking-wider h-8">Item</TableHead>
                    <TableHead className="text-center text-xs font-semibold uppercase tracking-wider h-8">Kuadran</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Outlet dengan waste > 0 dibanding outlet ber-BOM (denominator basis pemakaian, bukan kehadiran record).">Prevalence</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Bulan aktif (waste > 0) dibanding bulan window same-week.">Persistensi</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8" title="Σ(share²) per outlet atas waste item — hanya dihitung ≥ 10 outlet aktif.">HHI</TableHead>
                    <TableHead className="text-right text-xs font-semibold uppercase tracking-wider h-8">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => {
                    const q = it.quadrant ?? null;
                    return (
                      <TableRow key={it.itemId} className="h-9">
                        <TableCell className="text-xs font-medium max-w-[260px]">
                          <span className="block truncate" title={it.itemName}>{it.itemName}</span>
                        </TableCell>
                        <TableCell className="text-center">
                          {q ? (
                            <Badge variant="outline" className={`text-[9px] font-normal h-4 px-1.5 ${CLASS_BADGE_CLASS[q.quadrantClass]}`}>
                              {q.quadrantClass}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground" title={q?.prevalence == null ? 'Tanpa basis BOM di scope (waste tanpa pemakaian tercatat).' : `${fmtPct(q.prevalence, false, 1)} dari outlet ber-BOM`}>
                          {q && q.prevalence != null
                            ? `${it.outletsActive}/${q.outletsWithBom} outlet`
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                          {windowMonths > 0 ? `${it.monthsActive}/${windowMonths} bulan` : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground" title={q?.hhi == null ? 'Di bawah 10 outlet aktif (guard) atau tanpa distribusi.' : 'Konsentrasi waste lintas outlet (1 = terpusat di 1 outlet; 1/n = tersebar rata).'}>
                          {q?.hhi != null ? q.hhi.toFixed(3).replace('.', ',') : '—'}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{fmtPct(it.share, false, 1)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="px-4 py-2.5 text-[10px] text-muted-foreground border-t">
              Window {windowMonths > 0 ? `${windowMonths} bulan` : '—'} same-week (maks. 12). Ambang kuadran: prevalence ≥ 50% outlet
              ber-BOM{thresholdMonths != null && windowMonths > 0 ? ` dan persistensi ≥ ${thresholdMonths}/${windowMonths} bulan (ceil(window/2), adaptif)` : ''}.
              HHI = Σ(share²) per outlet — hanya untuk item dengan ≥ 10 outlet aktif; “—” = guard/belum tersedia. Prevalence “—” = item tanpa
              basis BOM di scope. INDIKASI: klasifikasi pola prevalence × persistensi — bukan root cause; SISTEMIK = kandidat masalah
              resep/proses lintas outlet, validasi sebelum aksi.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
});
