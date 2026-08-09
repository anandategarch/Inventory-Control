// ============================================================
//  Outlet code parser — handles XXXX.NNNN and B.XXXX.NNNN formats
// ============================================================
import { CFG_RECON_SETTINGS } from '@/config/settings';

export interface ParsedOutletCode {
  fullCode: string;
  name: string;
  numericCode: string;
}

export function parseOutletCode(raw: string): ParsedOutletCode | null {
  const code = (raw ?? '').trim().toUpperCase();
  if (!code) return null;
  for (const pattern of CFG_RECON_SETTINGS.OUTLET_CODE_PATTERNS) {
    const m = code.match(pattern);
    if (m) {
      return {
        fullCode: code,
        numericCode: m[1],
        name: m[2],
      };
    }
  }
  // Fallback: split by dot, take last segment as name
  const parts = code.split('.');
  return {
    fullCode: code,
    numericCode: parts[0] || code,
    name: parts[parts.length - 1] || code,
  };
}

// Parse period code like "191.JULI 26" → { monthNum, yearShort, periodCode }
export function parsePeriodCode(bulan: string, bulan2?: string | null): {
  periodCode: string;
  monthLabel: string;
  monthName: string;
  yearShort: string | null;
} | null {
  // bulan: "191.JULI 26"  →  191=code, JULI 26 = July 2026
  // bulan2: "19.JULI"     →  19=code, JULI = July
  const m = (bulan || '').match(/^(\d+)\.([A-Z]+)\s*(\d*)$/i);
  if (m) {
    return {
      periodCode: m[1],
      monthLabel: `${m[2]} ${m[3] || ''}`.trim(),
      monthName: m[2].toUpperCase(),
      yearShort: m[3] || null,
    };
  }
  if (bulan2) {
    const m2 = bulan2.match(/^(\d+)\.([A-Z]+)$/i);
    if (m2) {
      return {
        periodCode: m2[1],
        monthLabel: m2[2],
        monthName: m2[2].toUpperCase(),
        yearShort: null,
      };
    }
  }
  return null;
}
