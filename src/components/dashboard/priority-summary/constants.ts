// ============================================================
//  PrioritySummaryCard — shared constants
//  (split from PrioritySummaryCard.tsx — Phase 3)
// ============================================================

import {
  TrendingUp, BarChart3, ShieldAlert, Search, Activity, Scale, Layers,
  TrendingDown, AlertOctagon, AlertTriangle, Trophy, PieChart as PieIcon,
} from 'lucide-react';

// ------------------------------------------------------------
//  Signal grouping — 5 categories of related signals
// ------------------------------------------------------------

export const SIGNAL_GROUPS: Array<{
  name: string;
  emoji: string;
  icon: React.ComponentType<{ className?: string }>;
  signals: string[];
}> = [
  {
    name: 'Tren & Pertumbuhan',
    emoji: '📈',
    icon: TrendingUp,
    signals: ['Deviasi Growth', 'Trend Memburuk', 'Direction Flip'],
  },
  {
    name: 'Magnitude & Rasio',
    emoji: '📊',
    icon: BarChart3,
    signals: ['Dev/BOM vs Peer', 'Residual Ratio', 'Loss/Sales', 'Item Concentration'],
  },
  {
    name: 'Toleransi & Compliance',
    emoji: '⚠️',
    icon: ShieldAlert,
    signals: ['Tol Breach High', 'Tolerance Breach', 'No Tolerance'],
  },
  {
    name: 'Anomali & Fraud',
    emoji: '🔍',
    icon: Search,
    signals: ['Deviasi >50% BOM', 'Over-Explained', 'High Loss Nominal'],
  },
  {
    name: 'Benchmark',
    emoji: '📋',
    icon: Trophy,
    // FIX (BUG2-RESTO-3): removed 'Benchmark High' — was dead signal (S13 removed from API,
    // was duplicate of 'Deviasi >50% BOM'). Only 'Residual Nominal' remains in this group.
    signals: ['Residual Nominal'],
  },
];

// ------------------------------------------------------------
//  Signal icons — per signal name (lucide)
// ------------------------------------------------------------

export const SIGNAL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'Dev/BOM vs Peer': Scale,
  'Deviasi Growth': TrendingUp,
  'Deviasi >50% BOM': Activity,
  'Residual Ratio': Layers,
  'Loss/Sales': BarChart3,
  'Direction Flip': AlertOctagon,
  'Trend Memburuk': TrendingDown,
  'Item Concentration': PieIcon,
  'Tol Breach High': ShieldAlert,
  'Over-Explained': AlertTriangle,
  'High Loss Nominal': AlertOctagon,
  'No Tolerance': AlertTriangle,
  // FIX (BUG2-RESTO-3): removed 'Benchmark High' icon — dead signal
  'Residual Nominal': Layers,
  'Tolerance Breach': ShieldAlert,
};

// ------------------------------------------------------------
//  Chart palette — NO blue/indigo, only red/amber/emerald/zinc
// ------------------------------------------------------------

export const CHART = {
  red: '#ef4444',
  redDark: '#dc2626',
  amber: '#f59e0b',
  amberDark: '#d97706',
  emerald: '#10b981',
  emeraldDark: '#059669',
  zinc: '#71717a',
  zincLight: '#a1a1aa',
  zincVeryLight: '#d4d4d8',
};

// FIX: chart text color — use LIGHT color (white) so it's visible on ALL backgrounds
// (dark mode card bg, tooltip bg, etc). Previous #a1a1aa was too dark on dark backgrounds.
export const CHART_TEXT = '#52525b'; // white — always visible
export const CHART_TEXT_MUTED = '#71717a'; // light grey for secondary text

// Reusable tooltip style — LIGHT background with DARK text (high contrast, readable)
export const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(255, 255, 255, 0.97)',
  border: '1px solid #e4e4e7',
  borderRadius: '6px',
  fontSize: '11px',
  color: '#18181b',
  padding: '6px 8px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
};

// ============================================================
//  Signal explanations — short Indonesian blurbs shown under
//  each expanded chart, explaining what the signal means.
// ============================================================

export const SIGNAL_EXPLANATIONS: Record<string, string> = {
  'Dev/BOM vs Peer': 'Rasio deviasi outlet vs rata-rata peer. >1× berarti deviasi lebih tinggi dari peer — investigasi penyebab (BOM master, proses, atau pencatatan).',
  'Deviasi Growth': 'Tren pertumbuhan deviasi 4 minggu terakhir + proyeksi W5. Jika terus naik, perlu intervensi sebelum memburuk.',
  'Deviasi >50% BOM': 'Item dengan deviasi >50% BOM — indikasi perilaku tidak wajar. Probabilitas ada kesalahan pencatatan/fraud tinggi.',
  'Residual Ratio': 'Deviasi yang TIDAK bisa dijelaskan oleh Waste+Susut+Trial. Semakin tinggi rasio, semakin banyak "deviasi misteri" yang perlu investigasi.',
  'Loss/Sales': 'Rasio loss terhadap sales. Loss tinggi relatif terhadap sales = potensi masalah operasional (spillage, theft, atau proses)',
  'Direction Flip': 'Arah deviasi berubah dari periode sebelumnya (LOSS↔SURPLUS). Sering indikasi koreksi pencatatan atau perubahan proses yang signifikan.',
  'Trend Memburuk': 'Deviasi memburuk secara konsisten minggu ke minggu. Investigasi sebelum menjadi masalah besar.',
  'Item Concentration': 'Top 5 item menyumbang persentase besar dari total deviasi. Fokus investigasi pada item-item tersebut.',
  'Tol Breach High': 'Item dengan deviasi >2× toleransi (breach tinggi). Tindakan disipliner/audit diperlukan.',
  'Over-Explained': 'Item dimana penjelasan (Waste+Susut+Trial) > 100% deviasi. Indikasi kesalahan input data atau pencatatan ganda.',
  'High Loss Nominal': 'Item dengan nominal loss >Rp 10jt. Prioritas investigasi berdasarkan dampak finansial.',
  'No Tolerance': 'Item-item tanpa setup toleransi di master data. Tidak bisa di-evaluasi breach — setup toleransi segera.',
  // FIX (BUG2-RESTO-3): removed 'Benchmark High' explanation — dead signal
  'Residual Nominal': 'Nominal deviasi yang tidak terjelaskan. Semakin tinggi, semakin besar "uang hilang" yang perlu dijelaskan.',
  'Tolerance Breach': 'Item dengan deviasi >toleransi (breach reguler). Review penyebab dan corrective action.',
};
