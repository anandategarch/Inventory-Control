// ============================================================
//  Shared chart constants — semantic color palette using CSS variables.
//  Fix #7: Replaces hard-coded hex colors across dashboard components.
//  Supports dark mode via CSS variable overrides in globals.css.
// ============================================================

// Access CSS variables — falls back to hex if not set (for SSR/tests)
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

// Semantic chart colors — used by all chart components
export const CHART_COLORS = {
  loss: () => cssVar('--chart-loss', '#dc2626'),
  surplus: () => cssVar('--chart-surplus', '#10b981'),
  waste: () => cssVar('--chart-waste', '#f59e0b'),
  susut: () => cssVar('--chart-susut', '#7c3aed'),
  trial: () => cssVar('--chart-trial', '#65a30d'),
  residual: () => cssVar('--chart-residual', '#71717a'),
  neutral: () => cssVar('--chart-neutral', '#64748b'),
  warning: () => cssVar('--chart-warning', '#eab308'),
};

// Static versions for Recharts (which needs actual hex values, not functions)
// These are evaluated at render time and will pick up dark mode if class is set
export const COLORS = {
  loss: '#dc2626',
  surplus: '#10b981',
  waste: '#f59e0b',
  susut: '#7c3aed',
  trial: '#65a30d',
  residual: '#71717a',
  neutral: '#64748b',
  warning: '#eab308',
  // Dark mode variants (brighter)
  lossDark: '#f87171',
  surplusDark: '#34d399',
  wasteDark: '#fbbf24',
  susutDark: '#a78bfa',
  trialDark: '#84cc16',
  residualDark: '#a1a1aa',
  neutralDark: '#94a3b8',
  warningDark: '#facc15',
};

// Shared tooltip style for all Recharts components
export const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(255, 255, 255, 0.97)',
  border: '1px solid hsl(var(--border))',
  borderRadius: '8px',
  fontSize: '11px',
  color: 'hsl(var(--foreground))',
  padding: '8px 10px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
};

// Dark mode tooltip style
export const TOOLTIP_STYLE_DARK: React.CSSProperties = {
  backgroundColor: 'rgba(24, 24, 27, 0.97)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: '8px',
  fontSize: '11px',
  color: '#fafafa',
  padding: '8px 10px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
};

// Helper: get tooltip style based on current theme
export function getTooltipStyle(): React.CSSProperties {
  if (typeof document === 'undefined') return TOOLTIP_STYLE;
  return document.documentElement.classList.contains('dark')
    ? TOOLTIP_STYLE_DARK
    : TOOLTIP_STYLE;
}
