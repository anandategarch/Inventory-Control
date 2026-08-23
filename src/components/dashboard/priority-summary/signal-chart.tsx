'use client';

// ============================================================
//  PrioritySummaryCard — chart components
//  - ChartEmptyState: empty state for charts with no data
//  - SignalChart: renders the appropriate chart for each signal
//    (only rendered when accordion item is expanded)
//  (split from PrioritySummaryCard.tsx — Phase 3)
// ============================================================

import { fmtIDR } from '@/lib/format';
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  LabelList, Legend,
} from 'recharts';
import { CHART, TOOLTIP_STYLE } from './constants';
import type { Recommendation, OutletItem } from './types';
import {
  buildDevBomData, buildDeviasiGrowthData, buildTrendMemburukData, buildZScoreData,
  buildResidualRatioData, buildLossSalesData, buildDirectionFlipData,
  buildItemConcentrationData, buildTolBreachHighData, buildTolBreachData,
  buildOverExplainedData, buildHighLossData, buildBenchmarkData,
  buildResidualNominalData, buildNoToleranceRows,
} from './chart-data-builders';

// FIX DATA-2: empty state component for charts with no data
export function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-[170px] text-xs text-muted-foreground">
      <div className="text-center">
        <p className="text-emerald-600 dark:text-emerald-400 font-medium">✓ {message}</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Tidak ada anomali terdeteksi</p>
      </div>
    </div>
  );
}

// Shared label formatter for nominal values (Rp)
function fmtNominalLabel(v: number | string): string {
  const n = Number(v);
  if (isNaN(n)) return '';
  return Math.abs(n) >= 1000000
    ? `${(Math.abs(n) / 1000000).toFixed(1)}jt`
    : Math.abs(n) >= 1000
      ? `${(Math.abs(n) / 1000).toFixed(0)}rb`
      : n.toFixed(1);
}

// ============================================================
//  SignalChart — renders the appropriate chart for each signal
//  Per spec: only render when accordion item is expanded.
// ============================================================

export function SignalChart({ name, r, items }: { name: string; r: Recommendation; items: OutletItem[] }) {
  switch (name) {
    case 'Dev/BOM vs Peer': {
      const data = buildDevBomData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => [`${v}×`, 'Ratio']} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => fmtNominalLabel(v)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Deviasi Growth': {
      const data = buildDeviasiGrowthData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="week" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v == null ? '—' : `${(v * 100).toFixed(1)}%`} />
            <ReferenceLine y={0} stroke="#52525b" strokeOpacity={0.4} />
            <Line type="monotone" dataKey="actual" stroke={CHART.amber} strokeWidth={2} dot={{ r: 3, fill: CHART.amber }} connectNulls={false} name="Aktual" />
            <Line type="monotone" dataKey="projected" stroke={CHART.red} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: CHART.red }} connectNulls={false} name="Proyeksi" />
            <Legend wrapperStyle={{ fontSize: '9px', color: '#52525b' }} iconType="line" />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    case 'Trend Memburuk': {
      const data = buildTrendMemburukData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="week" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v == null ? '—' : `${(v * 100).toFixed(1)}%`} />
            <Line type="monotone" dataKey="actual" stroke={CHART.red} strokeWidth={2} dot={{ r: 3, fill: CHART.red }} connectNulls={false} name="Aktual" />
            <Line type="monotone" dataKey="projected" stroke={CHART.redDark} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: CHART.redDark }} connectNulls={false} name="Proyeksi" />
            <Legend wrapperStyle={{ fontSize: '9px', color: '#52525b' }} iconType="line" />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    case 'Deviasi >50% BOM': {
      const { abnormal, normal } = buildZScoreData(r, items);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <ScatterChart margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" />
            <XAxis type="number" dataKey="x" name="Item" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            {/* FIX Bug 2B: YAxis label changed from "Z-Score" to "Dev/BOM %" */}
            <YAxis type="number" dataKey="y" name="Dev/BOM %" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ strokeDasharray: '3 3' }}
              formatter={(v: number, name: string, _props: unknown) => {
                if (name === 'y') return `${v}%`;
                return v;
              }}
              labelFormatter={(_label: string, payload: Array<{ payload?: { name?: string } }>) => {
                if (payload && payload[0] && payload[0].payload && payload[0].payload.name) {
                  return payload[0].payload.name;
                }
                return '';
              }}
            />
            {/* FIX: threshold line at 50% (was 20%) */}
            <ReferenceLine y={50} stroke={CHART.red} strokeDasharray="4 3" label={{ value: '50%', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Scatter name="Normal (≤50%)" data={normal} fill={CHART.zincLight} />
            <Scatter name="Abnormal (>50%)" data={abnormal} fill={CHART.red} />
            <Legend wrapperStyle={{ fontSize: '9px' }} iconType="circle" formatter={(value: string) => <span style={{ color: '#52525b', fontSize: '9px' }}>{value}</span>} />
          </ScatterChart>
        </ResponsiveContainer>
      );
    }
    case 'Residual Ratio': {
      const data = buildResidualRatioData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <Bar dataKey="Explained" stackId="a" fill={CHART.emerald} radius={[0, 0, 0, 0]} />
            <Bar dataKey="Residual" stackId="a" fill={CHART.red} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Loss/Sales': {
      const data = buildLossSalesData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => fmtIDR(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => fmtIDR(v)} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => fmtNominalLabel(v)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Direction Flip': {
      const data = buildDirectionFlipData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" domain={[-1.5, 1.5]} ticks={[-1, 0, 1]} tickFormatter={(v: number) => v < 0 ? 'LOSS' : v > 0 ? 'SURP' : '—'} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => v < 0 ? 'LOSS' : 'SURPLUS'} />
            <ReferenceLine y={0} stroke="#52525b" strokeOpacity={0.5} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => fmtNominalLabel(v)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Item Concentration': {
      const data = buildItemConcentrationData(r, items);
      // FIX: use distinct, informative colors (not multiple shades of grey)
      const colors = [CHART.red, CHART.amber, CHART.emerald, CHART.amberDark, CHART.emeraldDark, CHART.zinc];
      return (
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="35%"
              cy="50%"
              innerRadius={50}
              outerRadius={85}
              paddingAngle={2}
              isAnimationActive={false}
              label={(entry: { name?: string; value?: number }) => {
                const name = entry.name || '';
                const val = entry.value ?? 0;
                const shortName = name.length > 12 ? name.slice(0, 10) + '…' : name;
                return `${shortName} ${val}%`;
              }}
              labelLine={{ stroke: '#52525b', strokeWidth: 0.5 }}
              style={{ fontSize: '9px', fill: '#52525b' }}
            >
              {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v: number, name: string) => [`${v}%`, name]}
            />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              wrapperStyle={{ fontSize: '10px', paddingLeft: '10px' }}
              iconType="circle"
              formatter={(value: string, entry: { color?: string }) => {
                const item = data.find(d => d.name === value);
                const pct = item ? `${item.value}%` : '';
                return <span style={{ color: '#52525b', fontSize: '10px' }}>{value} <b>{pct}</b></span>;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      );
    }
    case 'Tol Breach High': {
      const { data, threshold } = buildTolBreachHighData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item breach >2× toleransi" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={threshold} stroke={CHART.red} strokeDasharray="4 3" label={{ value: '2× Tol', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Bar dataKey="value" fill={CHART.red} radius={[3, 3, 0, 0]}>
              <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number) => `${v}%`} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Tolerance Breach': {
      const { data, threshold } = buildTolBreachData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item breach toleransi" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={threshold} stroke={CHART.amber} strokeDasharray="4 3" label={{ value: 'Tol', fontSize: 9, fill: CHART.amber, position: 'right' }} />
            <Bar dataKey="value" fill={CHART.amber} radius={[3, 3, 0, 0]}>
              <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number) => `${v}%`} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Over-Explained': {
      const data = buildOverExplainedData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item over-explained" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={100} stroke={CHART.red} strokeDasharray="4 3" label={{ value: '100%', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Bar dataKey="Deviasi" stackId="a" fill={CHART.zinc} radius={[0, 0, 0, 0]} />
            <Bar dataKey="Explanation" stackId="a" fill={CHART.amber} radius={[4, 4, 0, 0]}>
              <LabelList dataKey="Explanation" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => `${Math.round(Number(v))}%`} />
            </Bar>
            <Legend wrapperStyle={{ fontSize: '9px' }} iconType="circle" formatter={(value: string) => <span style={{ color: '#52525b', fontSize: '9px' }}>{value}</span>} />
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'High Loss Nominal': {
      const { data, threshold } = buildHighLossData(r, items);
      if (data.length === 0) return <ChartEmptyState message="Tidak ada item loss >Rp 10jt" />;
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#52525b' }} stroke="#52525b" interval={0} angle={-35} textAnchor="end" height={60} />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => fmtIDR(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => fmtIDR(v)} />
            <ReferenceLine y={threshold} stroke={CHART.red} strokeDasharray="4 3" label={{ value: 'Rp 10Jt', fontSize: 9, fill: CHART.red, position: 'right' }} />
            <Bar dataKey="value" fill={CHART.red} radius={[3, 3, 0, 0]}>
              <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => { const n = Number(v); if (isNaN(n)) return ""; return Math.abs(n) >= 1000000 ? `${(Math.abs(n)/1000000).toFixed(1)}jt` : `${n}`; }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Benchmark High': {
      const data = buildBenchmarkData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => `${v}%`} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => fmtNominalLabel(v)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'Residual Nominal': {
      const data = buildResidualNominalData(r);
      return (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.15} className="text-zinc-400" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" />
            <YAxis tick={{ fontSize: 10, fill: '#52525b' }} stroke="#52525b" tickFormatter={(v: number) => fmtIDR(v)} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(82,82,91,0.1)' }} formatter={(v: number) => fmtIDR(v)} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList dataKey="value" position="top" fill="#52525b" fontSize={9} formatter={(v: number | string) => fmtNominalLabel(v)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    case 'No Tolerance': {
      const rows = buildNoToleranceRows(r, items);
      if (rows.length === 0) {
        return (
          <div className="flex items-center justify-center h-[170px] text-xs text-muted-foreground">
            Semua item punya toleransi. ✓
          </div>
        );
      }
      return (
        <div className="h-[170px] overflow-auto rounded-md border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-background/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-sm sticky top-0 z-10">
              <tr>
                <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground">#</th>
                <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground">Item</th>
                <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground">% Deviasi</th>
                <th className="text-right px-3 py-1.5 font-semibold text-muted-foreground">Nominal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.idx} className="border-t border-border/40">
                  <td className="px-3 py-1.5 text-muted-foreground">{row.idx}</td>
                  <td className="px-3 py-1.5 truncate" title={row.name}>{row.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{row.pct}%</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtIDR(row.nominal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return (
        <div className="flex items-center justify-center h-[170px] text-xs text-muted-foreground">
          Chart belum tersedia untuk sinyal ini.
        </div>
      );
  }
}
