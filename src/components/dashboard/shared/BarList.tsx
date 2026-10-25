'use client';

// ============================================================
//  BarList — ranked horizontal bar list (Pattern 2 from tremor)
//  --------------------------------------------------------
//  Compact visual ranking: each item has an inline horizontal
//  bar proportional to its value, plus name + formatted value.
//
//  Features:
//    - sortOrder: 'descending' (default) | 'ascending' | 'none'
//    - onValueChange: clickable rows (for drill-down)
//    - valueFormatter: format function (e.g. formatByPreset)
//    - color: bar color (default: amber)
//    - showAnimation: smooth bar growth on mount
//    - highlightKeys: ITEM-HL-B — optional keys (item.key) whose rows get
//      the amber "resto terpilih" tint + left border (same visual language
//      as the target row in PeerTableRow). Backwards-compatible: omit it
//      and rendering is byte-identical to before (all rows keep a
//      transparent left border so the highlighted row introduces NO layout
//      shift — the border width is reserved on every row).
//
//  Usage:
//    <BarList
//      data={[
//        { name: 'CABAI MERAH', value: 1200000 },
//        { name: 'BAWANG', value: 700000 },
//      ]}
//      valueFormatter={(v) => formatByPreset(v, 'idr0m')}
//      onValueChange={(item) => setSelected(item.name)}
//    />
// ============================================================

import { memo, useMemo } from 'react';

export interface BarListItem {
  key?: string | number;
  name: string;
  value: number;
  // P23 C3: 'purple' removed — zero callers (grep) and purple is an
  // off-token family (see globals.css chart tokens); bars stay amber/
  // emerald/red/zinc only.
  color?: 'amber' | 'emerald' | 'red' | 'zinc';
  href?: string;
  metadata?: string;
}

export interface BarListProps {
  data: BarListItem[];
  valueFormatter?: (v: number) => string;
  color?: 'amber' | 'emerald' | 'red' | 'zinc';
  sortOrder?: 'descending' | 'ascending' | 'none';
  showAnimation?: boolean;
  onValueChange?: (item: BarListItem) => void;
  className?: string;
  /** ITEM-HL-B — rows whose `key` is in this list get the amber focused
   *  tint + left border (e.g. bars belonging to the selected outlet in
   *  TopItemsByNominal). Optional + additive — existing callers are
   *  unaffected. */
  highlightKeys?: Array<string | number>;
}

const colorMap = {
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  red: 'bg-red-500',
  zinc: 'bg-zinc-400',
};

export const BarList = memo(function BarList({
  data,
  valueFormatter = (v) => v.toLocaleString('id-ID'),
  color = 'amber',
  sortOrder = 'descending',
  showAnimation = true,
  onValueChange,
  className,
  highlightKeys,
}: BarListProps) {
  const sortedData = useMemo(() => {
    if (sortOrder === 'none') return data;
    return [...data].sort((a, b) =>
      sortOrder === 'ascending' ? a.value - b.value : b.value - a.value,
    );
  }, [data, sortOrder]);

  const maxValue = useMemo(
    () => Math.max(...sortedData.map((item) => Math.abs(item.value)), 0),
    [sortedData],
  );

  // ITEM-HL-B: Set lookup (O(1) per row) — dep is the caller's memoized
  // array, so the Set is only rebuilt when the selection actually changes.
  const highlightSet = useMemo(
    () => new Set(highlightKeys ?? []),
    [highlightKeys],
  );

  const isClickable = Boolean(onValueChange);

  return (
    <div className={`space-y-1.5 ${className ?? ''}`} aria-sort={sortOrder === 'none' ? undefined : sortOrder}>
      {sortedData.map((item, index) => {
        // FIX (BUG-SHARED-07): skip min 2% for zero-value items (was showing misleading 2% bar).
        const barWidth = maxValue > 0
          ? (item.value === 0 ? 0 : Math.max((Math.abs(item.value) / maxValue) * 100, 2))
          : 0;
        const itemColor = item.color ?? color;
        const Component = isClickable ? 'button' : 'div';
        // ITEM-HL-B: amber tint + amber left border for keys in highlightKeys.
        // Every row carries `border-l-2` (transparent when not highlighted)
        // so the highlight adds zero layout shift — rows never re-align.
        const highlighted = item.key != null && highlightSet.has(item.key);
        return (
          <Component
            key={item.key ?? index}
            onClick={isClickable ? () => onValueChange?.(item) : undefined}
            // FIX (BUG-SHARED-08): add type='button' to prevent accidental form submit.
            type={isClickable ? 'button' : undefined}
            title={highlighted ? 'Resto terpilih (dari tab Resto)' : undefined}
            className={`group flex items-center w-full rounded-md border-l-2 ${
              highlighted
                ? 'border-l-amber-500 bg-amber-50/80 dark:bg-amber-950/20'
                : 'border-l-transparent'
            } ${isClickable ? 'cursor-pointer hover:bg-muted/40 transition-colors' : ''}`}
          >
            {/* Name (left, fixed width) */}
            <div className="w-40 shrink-0 truncate text-xs font-medium pr-3 text-left" title={item.name}>
              {item.name}
            </div>
            {/* Bar (flex-1, fills remaining space) */}
            <div className="flex-1 min-w-0 relative h-7 rounded bg-muted/30 overflow-hidden">
              <div
                className={`h-full rounded ${colorMap[itemColor]} ${showAnimation ? 'transition-all duration-300' : ''}`}
                style={{ width: `${barWidth}%` }}
              />
              {/* Value overlay (on top of bar, right-aligned) */}
              <div className="absolute inset-0 flex items-center justify-end pr-2">
                <span className="text-xs font-medium tabular-nums text-foreground/80">
                  {valueFormatter(item.value)}
                </span>
              </div>
            </div>
            {/* Optional metadata (right, fixed width) */}
            {item.metadata && (
              <div className="w-20 shrink-0 text-right text-[10px] text-muted-foreground pl-2 truncate" title={item.metadata}>
                {item.metadata}
              </div>
            )}
          </Component>
        );
      })}
    </div>
  );
});
