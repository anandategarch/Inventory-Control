// ============================================================
//  export-sections.test.ts — SUBSECTION-1 registry + helpers
//  --------------------------------------------------------
//  Covers the shared token protocol the PDF export filter now uses:
//    • bare section key   ('topItems')    = whole section
//    • sub token          ('topItems:nominal') = only that sub-block
//    • null (param absent) = all sections
//  Consumed by: ExportDialog (nested checkboxes), validation/export.ts
//  (token refine), section-gates.ts (fetch gates), section-context.ts
//  (hasSection/hasSub render gates).
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  EXPORT_SECTIONS,
  EXPORT_SECTION_KEYS,
  EXPORT_SECTION_TOKENS,
  EXPORT_SECTION_SUBS,
  exportSubToken,
  isExportSectionToken,
  isSectionOn,
  isSubOn,
  compactSectionTokens,
  countActiveSections,
} from '@/lib/export-sections';

describe('EXPORT_SECTIONS registry', () => {
  it('carries the 12 sections in the FIXED pdf-builder order', () => {
    expect(EXPORT_SECTION_KEYS).toEqual([
      'exec',
      'growth',
      'topItems',
      'variance',
      'waste',
      'itemTrend',
      'anomali',
      'trend',
      'peer',
      'flip',
      'outletLeague',
      'areaCompare',
    ]);
  });

  it('gives every parent at least one sub; the four leaves have none', () => {
    // Leaves: exec (single KPI table), itemTrend (single heat matrix),
    // flip (dynamic per-pair groups 10.x — nothing static to gate),
    // outletLeague (LEAGUE-AREA — one league table, nothing to gate).
    expect(EXPORT_SECTION_SUBS['exec']).toEqual([]);
    expect(EXPORT_SECTION_SUBS['itemTrend']).toEqual([]);
    expect(EXPORT_SECTION_SUBS['flip']).toEqual([]);
    expect(EXPORT_SECTION_SUBS['outletLeague']).toEqual([]);
    for (const key of [
      'growth',
      'topItems',
      'variance',
      'waste',
      'anomali',
      'trend',
      'peer',
      'areaCompare',
    ]) {
      expect(EXPORT_SECTION_SUBS[key].length).toBeGreaterThan(0);
    }
  });

  it('areaCompare has the tabel + grafik blocks (LEAGUE-AREA)', () => {
    expect(EXPORT_SECTION_SUBS['areaCompare']).toEqual(['tabel', 'grafik']);
  });

  it('topItems has the 6 numbered rankings 3.1-3.6', () => {
    expect(EXPORT_SECTION_SUBS['topItems']).toEqual([
      'nominal',
      'devbom',
      'waste',
      'susut',
      'trial',
      'losssurplus',
    ]);
  });

  it('trend has the table + 4 chart blocks', () => {
    expect(EXPORT_SECTION_SUBS['trend']).toEqual([
      'tabel',
      'nominal',
      'losssurplus',
      'komposisi',
      'akumulasi',
    ]);
  });

  it('every sub token is unique and colon-shaped', () => {
    const tokens = EXPORT_SECTIONS.flatMap((s) =>
      (s.subs ?? []).map((sub) => exportSubToken(s.key, sub.key)),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const t of tokens) expect(t).toMatch(/^[a-zA-Z]+:[a-zA-Z]+$/);
  });
});

describe('isExportSectionToken (validation basis)', () => {
  it('accepts the 10 bare keys and every sub token', () => {
    for (const t of EXPORT_SECTION_TOKENS)
      expect(isExportSectionToken(t)).toBe(true);
  });

  it('rejects the pre-EXPORT-TRIM keys the LEAGUE-AREA sections deliberately did NOT revive', () => {
    // 'area'/'outlets' were removed by EXPORT-TRIM; their successors use
    // fresh keys (outletLeague/areaCompare) with different semantics.
    expect(isExportSectionToken('area')).toBe(false);
    expect(isExportSectionToken('outlets')).toBe(false);
    expect(isExportSectionToken('outletLeague')).toBe(true);
    expect(isExportSectionToken('areaCompare')).toBe(true);
  });

  it('rejects unknown keys, unknown subs, and malformed tokens', () => {
    expect(isExportSectionToken('topitems')).toBe(false); // typo guard (BUG-3-a C6)
    expect(isExportSectionToken('topItems:nominall')).toBe(false);
    expect(isExportSectionToken('exec:table')).toBe(false); // leaf has no subs
    expect(isExportSectionToken('itemTrend:matrix')).toBe(false);
    expect(isExportSectionToken('topItems:')).toBe(false);
    expect(isExportSectionToken(':nominal')).toBe(false);
    expect(isExportSectionToken('summary')).toBe(false); // EXPORT-TRIM removed key
    expect(isExportSectionToken('pareto')).toBe(false);
  });
});

describe('isSectionOn / isSubOn', () => {
  it('null sections list (param absent) = everything on', () => {
    expect(isSectionOn(null, 'exec')).toBe(true);
    expect(isSectionOn(null, 'topItems')).toBe(true);
    expect(isSubOn(null, 'topItems', 'nominal')).toBe(true);
    expect(isSubOn(null, 'trend', 'akumulasi')).toBe(true);
  });

  it('bare key turns the section AND every sub on (pre-SUBSECTION-1 form)', () => {
    const tokens = ['topItems'];
    expect(isSectionOn(tokens, 'topItems')).toBe(true);
    for (const sub of EXPORT_SECTION_SUBS['topItems']) {
      expect(isSubOn(tokens, 'topItems', sub)).toBe(true);
    }
    expect(isSectionOn(tokens, 'exec')).toBe(false);
  });

  it('a sub token turns the section on + only that sub', () => {
    const tokens = ['topItems:nominal'];
    expect(isSectionOn(tokens, 'topItems')).toBe(true);
    expect(isSubOn(tokens, 'topItems', 'nominal')).toBe(true);
    expect(isSubOn(tokens, 'topItems', 'devbom')).toBe(false);
    expect(isSubOn(tokens, 'topItems', 'waste')).toBe(false);
  });

  it('empty list (BUG-3-a C4 ?sections=) = nothing on', () => {
    expect(isSectionOn([], 'exec')).toBe(false);
    expect(isSubOn([], 'topItems', 'nominal')).toBe(false);
  });

  it('prefix collision guard: itemTrend tokens never satisfy trend', () => {
    // 'itemTrend' starts with... no — 'itemTrend:x'.startsWith('trend:') is
    // false, but a naive includes()-based impl could confuse the two keys.
    expect(isSectionOn(['itemTrend'], 'trend')).toBe(false);
    expect(isSectionOn(['itemTrend'], 'itemTrend')).toBe(true);
    expect(isSectionOn(['trend:nominal'], 'itemTrend')).toBe(false);
    expect(isSectionOn(['trend:nominal'], 'trend')).toBe(true);
  });
});

describe('compactSectionTokens', () => {
  it('collapses a fully-selected parent to its bare key (cache-row compat)', () => {
    const subs = EXPORT_SECTION_SUBS['topItems'].map((sub) =>
      exportSubToken('topItems', sub),
    );
    expect(compactSectionTokens(subs)).toEqual(['topItems']);
  });

  it('expands a partial parent to the selected sub tokens only', () => {
    const out = compactSectionTokens(['topItems:nominal', 'topItems:devbom']);
    expect(out).toEqual(['topItems:nominal', 'topItems:devbom']);
  });

  it('passes leaf bare keys through and drops unselected sections', () => {
    const out = compactSectionTokens(['exec', 'flip', 'waste:komposisi']);
    expect(out).toEqual(['exec', 'waste:komposisi', 'flip']);
  });

  it('a bare parent key in the input survives as the bare key (idempotent)', () => {
    // The dialog never produces this form, but a caller passing tokens it
    // parsed back from a URL must not lose the full-section selection.
    expect(compactSectionTokens(['topItems'])).toEqual(['topItems']);
  });

  it('empty selection → empty list (BUG-3-a C4 ?sections= none)', () => {
    expect(compactSectionTokens([])).toEqual([]);
  });

  it('full selection → exactly the 10 bare keys (pre-SUBSECTION-1 URL shape)', () => {
    const all = new Set<string>([
      ...EXPORT_SECTION_KEYS,
      ...EXPORT_SECTIONS.flatMap((s) =>
        (s.subs ?? []).map((sub) => exportSubToken(s.key, sub.key)),
      ),
    ]);
    expect(compactSectionTokens(all)).toEqual([...EXPORT_SECTION_KEYS]);
  });
});

describe('countActiveSections', () => {
  it('counts sections, not tokens', () => {
    expect(countActiveSections(['topItems:nominal', 'topItems:devbom'])).toBe(
      1,
    );
    expect(
      countActiveSections(['exec', 'waste:komposisi', 'waste:skenario']),
    ).toBe(2);
    expect(countActiveSections([])).toBe(0);
  });

  it('handles bare keys and sub tokens mixed', () => {
    expect(
      countActiveSections([
        'exec',
        'growth',
        'topItems:nominal',
        'trend:akumulasi',
      ]),
    ).toBe(4);
  });
});
