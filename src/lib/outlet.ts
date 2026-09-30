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

// FILTERDROP-1 dead-code audit: parsePeriodCode() REMOVED — zero callers
// repo-wide (parseOutletCode above is the used one).

