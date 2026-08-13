'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtPct } from '@/lib/format';
import type { AnalysisData } from '@/hooks/useAnalysis';
import { FormulaInfo } from '@/components/dashboard/FormulaInfo';
import { QuickSettings } from '@/components/dashboard/QuickSettings';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ComposedChart, Line, Legend, Cell,
} from 'recharts';

export function GrowthComparison({ data }: { data: AnalysisData }) {
  const g = data.growthComparison;
  const chartData = [
    { name: 'Sales', growth: g.salesGrowth },
    { name: 'BOM', growth: g.bomGrowth },
    { name: 'QTY Deviasi', growth: g.qtyDeviasiGrowth },
    { name: 'Nominal Deviasi', growth: g.nominalDeviasiGrowth },
    { name: 'Price', growth: g.priceGrowth },
  ].filter((d) => d.growth != null);

  const mismatchSales = g.salesGrowth != null && g.nominalDeviasiGrowth != null &&
    g.nominalDeviasiGrowth > 2 * (g.salesGrowth > 0 ? g.salesGrowth : 0) && g.salesGrowth > 0;
  const mismatchBom = g.bomGrowth != null && g.qtyDeviasiGrowth != null &&
    g.qtyDeviasiGrowth > 2 * (g.bomGrowth > 0 ? g.bomGrowth : 0) && g.bomGrowth > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          Growth Comparison
          <FormulaInfo
            formula="Growth = (Current - Previous) / |Previous|"
            description="Persentase perubahan vs periode pembanding. Bar merah = mismatch (Deviasi/Sales atau Deviasi/BOM tumbuh > 2× lipat dari sales/BOM)."
            example="Sales: (5.98B - 3.88B) / 3.88B = +54%"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'SALES_DEVIATION_FACTOR', label: 'Faktor Sales vs Deviasi', dataType: 'number', min: 1, max: 10, step: 0.5 },
              { key: 'BOM_DEVIATION_FACTOR', label: 'Faktor BOM vs Deviasi', dataType: 'number', min: 1, max: 10, step: 0.5 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Current vs {data.period.comparisonWeek
            ? `${data.period.comparisonWeek}${data.period.comparisonMonth && data.period.comparisonMonth !== data.period.monthLabel ? ` ${data.period.comparisonMonth}` : ''}`
            : 'previous'} period
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No previous period data available. Upload multiple weeks to enable growth analysis.
          </p>
        ) : (
          <>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => fmtPct(v, true, 0)} fontSize={11} />
                  <YAxis type="category" dataKey="name" width={90} fontSize={11} />
                  <Tooltip formatter={(v: any) => fmtPct(v as number, true, 2)} />
                  <Bar dataKey="growth" radius={[0, 4, 4, 0]}>
                    {chartData.map((d, i) => {
                      const mismatch =
                        (d.name === 'Sales' && mismatchSales) ||
                        (d.name === 'BOM' && mismatchBom);
                      const devMismatch =
                        (d.name === 'Nominal Deviasi' && mismatchSales) ||
                        (d.name === 'QTY Deviasi' && mismatchBom);
                      return <Cell key={i} fill={mismatch || devMismatch ? '#dc2626' : d.growth! >= 0 ? '#10b981' : '#f59e0b'} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 space-y-1">
              {mismatchSales && (
                <Badge variant="destructive" className="text-xs mr-1">
                  Sales vs Deviasi MISMATCH
                </Badge>
              )}
              {mismatchBom && (
                <Badge variant="destructive" className="text-xs">
                  BOM vs Deviasi MISMATCH
                </Badge>
              )}
              {!mismatchSales && !mismatchBom && (
                <Badge variant="secondary" className="text-xs">Growth pattern consistent</Badge>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DeviationBreakdownChart({ data }: { data: AnalysisData }) {
  const b = data.deviationBreakdown;
  const total = b.total || 1;
  const chartData = [
    { name: 'Waste', value: b.waste, pct: (b.waste / total) * 100, color: '#f59e0b' },
    { name: 'Susut', value: b.susut, pct: (b.susut / total) * 100, color: '#8b5cf6' },
    { name: 'Trial', value: b.trial, pct: (b.trial / total) * 100, color: '#06b6d4' },
    { name: 'Residual', value: b.residual, pct: (b.residual / total) * 100, color: b.residual / total > 0.5 ? '#dc2626' : '#64748b' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          Deviation Breakdown
          <FormulaInfo
            formula="QTY Deviasi = |Waste| + |Susut| + |Trial| + |Residual|"
            description="Dekomposisi total deviation. Residual = |QTY Deviasi| - |Waste + Susut + Trial|. Residual tinggi (>50%) = sebagian besar deviation tidak terjelaskan oleh Waste/Susut/Trial."
            example="Deviasi 60K = Waste 8K + Susut 6K + Trial 4K + Residual 42K (70%)"
            side="bottom"
          />
          <QuickSettings
            settings={[
              { key: 'RESIDUAL_LOSS_WARN_PCT', label: 'Ambang Peringatan Residual', dataType: 'percent', min: 0, max: 1, step: 0.05 },
              { key: 'RESIDUAL_LOSS_HIGH_PCT', label: 'Ambang Kritis Residual', dataType: 'percent', min: 0, max: 1, step: 0.05 },
            ]}
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">QTY Deviasi composition</p>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" fontSize={11} />
              <YAxis tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)} fontSize={11} />
              <Tooltip
                formatter={(v: any, _n: any, p: any) => [`${v.toLocaleString()} (${p.payload.pct.toFixed(1)}%)`, p.payload.name]}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          {chartData.map((d) => (
            <div key={d.name} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
              <span className="text-muted-foreground">{d.name}:</span>
              <span className="font-medium">{d.value.toLocaleString()}</span>
              <span className="text-muted-foreground">({d.pct.toFixed(1)}%)</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function LossVsSurplusChart({ data }: { data: AnalysisData }) {
  const l = data.lossVsSurplus;
  const chartData = [
    { name: 'LOSS', qty: l.loss, nominal: l.lossNominal, color: '#dc2626' },
    { name: 'SURPLUS', qty: l.surplus, nominal: l.surplusNominal, color: '#10b981' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          Loss vs Surplus
          <FormulaInfo
            formula="LOSS: QTY Deviasi > 0 (actual > SOC)  |  SURPLUS: QTY Deviasi < 0 (actual < SOC)"
            description="Direction split berdasarkan tanda QTY Deviasi. Magnitude = |QTY Deviasi|. LOSS = pemakaian aktual melebihi SOC (Stock Opname Cost). SURPLUS = pemakaian aktual di bawah SOC."
            example="QTY Deviasi = +50 → LOSS 50  |  QTY Deviasi = -30 → SURPLUS 30"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Direction split (magnitude)</p>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" fontSize={11} />
              <YAxis tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)} fontSize={11} />
              <Tooltip formatter={(v: any) => v.toLocaleString()} />
              <Legend />
              <Bar dataKey="qty" name="QTY" radius={[4, 4, 0, 0]}>
                {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">LOSS nominal:</span>{' '}
            <span className="font-medium text-red-600">Rp {(l.lossNominal / 1_000_000).toFixed(2)}Jt</span>
          </div>
          <div>
            <span className="text-muted-foreground">SURPLUS nominal:</span>{' '}
            <span className="font-medium text-emerald-600">Rp {(l.surplusNominal / 1_000_000).toFixed(2)}Jt</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function TrendChart({ data }: { data: AnalysisData }) {
  const trend = data.trend;
  if (!trend || trend.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Trend</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No trend data</p></CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5">
          Weekly Trend
          <FormulaInfo
            formula="Dev/BOM % = |QTY Deviasi| / |QTY BOM| × 100%"
            description="Rasio deviation terhadap BOM per periode (semua outlet). Garis merah = Dev/BOM % (sumbu kiri). Garis kuning = Nominal Deviasi dalam Rupiah (sumbu kanan). Trend naik = deviation makin besar proporsinya terhadap BOM."
            example="Deviasi 60K / BOM 425K = 14.1%"
            side="bottom"
          />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Deviation/BOM % &amp; Nominal Deviasi over weeks</p>
      </CardHeader>
      <CardContent>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trend} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="weekLabel" fontSize={11} />
              <YAxis yAxisId="left" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={11} />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => {
              const abs = Math.abs(v);
              if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace('.', ',')}M`;
              if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}Jt`;
              if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}Rb`;
              return v.toFixed(0);
            }} fontSize={11} />
              <Tooltip
                formatter={(v: any, n: any) => n === 'Dev/BOM' ? `${(v * 100).toFixed(2)}%` : v.toLocaleString()}
              />
              <Legend />
              <Line yAxisId="left" type="monotone" dataKey="devBom" name="Dev/BOM" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="right" type="monotone" dataKey="nominal" name="Nominal Deviasi" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
