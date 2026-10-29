// ============================================================
//  export-sections — the section + SUB-section registry of the
//  PDF export report (SUBSECTION-1 — NEW)
//  --------------------------------------------------------
//  User request: "waktu export laporan pdf kan ada section yang
//  bisa aku centang namun tiap section ada anak nya lagi atau sub
//  section. nah sub section ini juga harusnya bisa aku centang
//  juga" — the ?sections= filter used to gate whole sections only;
//  the sub-blocks the PDF itself numbers (3.1-3.6, 4.1/4.2, 5.1-
//  5.3, 7.1-7.3, 9.1-9.3 + the chart blocks of 2/8) were not
//  individually selectable.
//
//  Token protocol (one list, flat — no second param):
//    • bare section key   ('topItems')          = the WHOLE section
//      (all sub-blocks) — the pre-SUBSECTION-1 form, so old URLs /
//      cache rows keep their exact semantics.
//    • sub token          ('topItems:nominal')  = ONLY that sub-block
//      (the section header still renders — numbering is FIXED, see
//      the BUG-HUNT continuity convention).
//    • sections param ABSENT (null)             = all sections.
//    • ?sections= (empty → [])                  = none (BUG-3-a C4).
//
//  Single source of truth — imported by BOTH sides (mirrors
//  report-version.ts's GODSPLIT-W2-A pattern; kills the old
//  four-site "keep in sync" ritual):
//    • Client: ExportDialog.tsx (the nested checkbox tree),
//      useDashboardActions.ts (section count in the toast).
//    • Server: lib/validation/export.ts (token refine),
//      data-fetcher/section-gates.ts (fetch gates),
//      pdf/section-context.ts (hasSection + hasSub render gates).
//
//  Import-safe from BOTH client components and server routes —
//  pure data + pure functions only.
//
//  Fetch granularity note: the SQL gates stay SECTION-level (a
//  'topItems:nominal' export still fetches the whole top-items
//  batch — isSectionOn('topItems') is true). Only RENDERING is
//  sub-gated. Sub-level fetch gating is a possible future PERF
//  step; correctness first (an unused cached q-* row is cheap, a
//  missing one is a crash).
// ============================================================

/** One selectable sub-block of a section (e.g. "3.1 Nominal Deviasi Terbesar"). */
export interface ExportSubSection {
  /** Sub key — appears in tokens as `${sectionKey}:${key}`. */
  key: string;
  /** Short label for the dialog row. */
  label: string;
}

/** One top-level report section. Sections without `subs` are leaves. */
export interface ExportSection {
  key: string;
  label: string;
  /**
   * Sub-blocks, in render order. Sections whose PDF body is ONE
   * block (exec's single table, itemTrend's single heat matrix,
   * flip's dynamic per-pair groups 10.x) have no sub-sections —
   * there is nothing smaller to gate.
   */
  subs?: readonly ExportSubSection[];
}

// Keep the numbering/labels aligned with pdf-builder.ts's FIXED
// section map (W10 order: waste inserted at 5; tail renumbered).
export const EXPORT_SECTIONS: readonly ExportSection[] = [
  { key: 'exec', label: '1. Ringkasan' },
  {
    key: 'growth',
    label: '2. Perubahan vs Periode Pembanding',
    subs: [
      {
        key: 'tabel',
        label: 'Tabel metrik vs pembanding (selisih & growth %)',
      },
      { key: 'grafik', label: 'Grafik batang Growth % per metrik' },
    ],
  },
  {
    key: 'topItems',
    label: '3. Item Prioritas (Top Items)',
    subs: [
      { key: 'nominal', label: '3.1 Nominal Deviasi Terbesar' },
      { key: 'devbom', label: '3.2 % Deviasi To BOM Terbesar' },
      { key: 'waste', label: '3.3 QTY Waste Terbesar' },
      { key: 'susut', label: '3.4 QTY Susut Terbesar' },
      { key: 'trial', label: '3.5 QTY Trial Terbesar' },
      { key: 'losssurplus', label: '3.6 QTY Loss/Surplus Terbesar' },
    ],
  },
  {
    key: 'variance',
    label: '4. Perubahan Item (vs Pembanding)',
    subs: [
      { key: 'memburuk', label: '4.1 Memburuk — tabel + grafik selisih' },
      { key: 'membaik', label: '4.2 Membaik — tabel' },
    ],
  },
  {
    key: 'waste',
    label: '5. Analisis Waste',
    subs: [
      {
        key: 'komposisi',
        label: '5.1 Komposisi Loss — Terjelaskan W/S/T vs Residual (TERUKUR)',
      },
      { key: 'skenario', label: '5.2 Skenario Atribusi Residual (HIPOTESIS)' },
      { key: 'topsnapshot', label: '5.3 Top Waste Items — snapshot periode' },
    ],
  },
  { key: 'itemTrend', label: '6. Trend Item Multi-Periode' },
  {
    key: 'anomali',
    label: '7. Item Anomali vs Riwayat Sendiri',
    subs: [
      { key: 'riwayat', label: '7.1 Kuantitas vs Rata-rata Riwayat Sendiri' },
      {
        key: 'gantiarah',
        label: '7.2 Item Berganti Arah (loss jadi surplus / sebaliknya)',
      },
      {
        key: 'pola',
        label: '7.3 Analisis Pola Item (Massal / Regional / Lokal)',
      },
    ],
  },
  {
    key: 'trend',
    label: '8. Trend Antar Periode',
    subs: [
      { key: 'tabel', label: 'Tabel metrik per periode' },
      { key: 'nominal', label: 'Grafik batang Nominal Deviasi per Periode' },
      { key: 'losssurplus', label: 'Grafik garis Loss vs Surplus per Periode' },
      { key: 'komposisi', label: 'Grafik Komposisi Deviasi per Minggu' },
      { key: 'akumulasi', label: 'Grafik Akumulasi Mingguan — Total Deviasi' },
    ],
  },
  {
    key: 'peer',
    label: '9. Resto dengan Penjualan Kurang Lebih Sama',
    subs: [
      { key: 'deviasi', label: '9.1 Nominal Deviasi per Resto' },
      {
        key: 'breakdown',
        label: '9.2 Breakdown per Item (kuantitas, % to BOM)',
      },
      {
        key: 'topitems',
        label: '9.3 Item di Resto lain (dilihat dari Top Item nya)',
      },
    ],
  },
  { key: 'flip', label: '10. Item yang Kemungkinan Plus Minus antar Periode' },
  {
    // LEAGUE-AREA (user: "Export 1 by one 1 resto dan area") — every resto
    // in the filter scope gets ONE row (a league table), instead of
    // section 9's target-centric ±10% sales band. Leaf: one table, no
    // static sub-blocks to gate.
    key: 'outletLeague',
    label: '11. Peringkat Resto',
  },
  {
    // LEAGUE-AREA — every area side by side (the FE AreaComparison card,
    // tab Area, carried into the PDF) + a per-area |nominal| bar chart.
    key: 'areaCompare',
    label: '12. Perbandingan Area',
    subs: [
      {
        key: 'tabel',
        label: 'Tabel semua area (jumlah resto, nominal deviasi, % Dev/BOM, % Loss to Sales)',
      },
      { key: 'grafik', label: 'Grafik batang Nominal Deviasi per Area' },
    ],
  },
];

/** All bare section keys, in order ('exec' … 'flip'). */
export const EXPORT_SECTION_KEYS: readonly string[] = EXPORT_SECTIONS.map(
  (s) => s.key,
);

/** section key → its sub keys (empty array for leaves). */
export const EXPORT_SECTION_SUBS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    EXPORT_SECTIONS.map((s) => [
      s.key,
      s.subs ? s.subs.map((sub) => sub.key) : [],
    ]),
  );

/** Full sub token for a (section, sub) pair — 'topItems:nominal'. */
export function exportSubToken(sectionKey: string, subKey: string): string {
  return `${sectionKey}:${subKey}`;
}

/** Every valid token: the 10 bare keys + every sub token. */
export const EXPORT_SECTION_TOKENS: readonly string[] = [
  ...EXPORT_SECTION_KEYS,
  ...EXPORT_SECTIONS.flatMap((s) =>
    (s.subs ?? []).map((sub) => exportSubToken(s.key, sub.key)),
  ),
];

/** True when `token` is a bare section key or a known sub token. */
export function isExportSectionToken(token: string): boolean {
  return (EXPORT_SECTION_TOKENS as readonly string[]).includes(token);
}

/**
 * Is the SECTION active? A section is on when the token list carries
 * its bare key (whole section — pre-SUBSECTION-1 semantics) OR any of
 * its `key:*` sub tokens. `sections === null` (param absent) = ALL.
 */
export function isSectionOn(
  sections: readonly string[] | null,
  sectionKey: string,
): boolean {
  if (sections === null) return true;
  if (sections.includes(sectionKey)) return true;
  const prefix = `${sectionKey}:`;
  return sections.some((t) => t.startsWith(prefix));
}

/**
 * Is the SUB-BLOCK active? On when the section's bare key is present
 * (whole-section selection turns every sub on) or the exact sub token
 * `sectionKey:subKey` is. `sections === null` (param absent) = ALL.
 */
export function isSubOn(
  sections: readonly string[] | null,
  sectionKey: string,
  subKey: string,
): boolean {
  if (sections === null) return true;
  if (sections.includes(sectionKey)) return true;
  return sections.includes(exportSubToken(sectionKey, subKey));
}

/**
 * Compact a raw token set into the canonical token list for the export
 * URL: a parent section with EVERY sub selected collapses to its bare
 * key (byte-compatible with the pre-SUBSECTION-1 full-selection URLs —
 * same cache row, better hit rate); a partial selection expands to the
 * selected sub tokens; leaves pass through as bare keys. Order follows
 * EXPORT_SECTIONS (deterministic; the cache key sorts anyway).
 */
export function compactSectionTokens(selected: Iterable<string>): string[] {
  const picked = selected instanceof Set ? selected : new Set(selected);
  const out: string[] = [];
  for (const s of EXPORT_SECTIONS) {
    const subs = s.subs ?? [];
    if (subs.length === 0) {
      if (picked.has(s.key)) out.push(s.key);
      continue;
    }
    // A bare parent key already IN the input means the full section is on
    // (idempotent round-trip for a token list parsed back from a URL).
    const on = picked.has(s.key)
      ? subs
      : subs.filter((sub) => picked.has(exportSubToken(s.key, sub.key)));
    if (on.length === subs.length) out.push(s.key);
    else if (on.length > 0)
      out.push(...on.map((sub) => exportSubToken(s.key, sub.key)));
  }
  return out;
}

/**
 * Count how many SECTIONS a token list activates (for the export
 * button + success toast — 'topItems:nominal,topItems:devbom' is
 * ONE section, not two). Bare leaf keys map to themselves.
 */
export function countActiveSections(tokens: readonly string[]): number {
  return new Set(tokens.map((t) => t.split(':', 2)[0])).size;
}
