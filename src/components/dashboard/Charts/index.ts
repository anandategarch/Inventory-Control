// ============================================================
//  Charts — Barrel Export
//  --------------------------------------------------------
//  Import dari sini untuk semua chart komponen dashboard.
//
//  Usage:
//    import { GrowthComparison, DeviationBreakdownChart, LossVsSurplusChart }
//    from '@/components/dashboard/Charts';
//
//  Path resolution: '@/components/dashboard/Charts' resolves to this
//  index.ts (folder import via moduleResolution: bundler).
//  Backward-compatible with the original Charts.tsx — all existing
//  imports keep working unchanged.
//
//  P3-HYG-5: TrendChart export REMOVED — the component was dropped from
//  DashboardTab (see DashboardTab.tsx comment) but the barrel still shipped
//  it, bloating the lazy Charts chunk with a component nobody rendered.
//  File TrendChart.tsx deleted. PeerComparison's TrendChartCard is a
//  different component (peer-comparison/trend-chart.tsx) — unaffected.
// ============================================================

export { GrowthComparison } from './GrowthComparison';
export { DeviationBreakdownChart } from './DeviationBreakdownChart';
export { LossVsSurplusChart } from './LossVsSurplusChart';
