'use client';

// ============================================================
//  Callout — highlighted info box (Pattern 4)
//  --------------------------------------------------------
//  Inspired by tremor-npm <Callout> component.
//  Renders a colored, border-left-accented info box with:
//    - Title (optional) + icon (optional)
//    - Children content area (small text)
//    - 4 color variants: amber (default), emerald, red, zinc
//
//  Usage:
//    <Callout title="Tips: Z-Score butuh minimal 4 periode" icon={Info} color="amber">
//      <p>Baseline menggunakan weekLabel yang sama...</p>
//    </Callout>
//
//  PC-focused design (dark mode supported via `dark:` classes).
//  No indigo or blue colors per project rule.
// ============================================================

import { memo } from 'react';

export type CalloutColor = 'amber' | 'emerald' | 'red' | 'zinc';

export interface CalloutProps {
  /** Title shown at top (with optional icon). Skip to render a content-only callout. */
  title?: string;
  /** Icon component (e.g. Info, AlertTriangle from lucide-react). */
  icon?: React.ElementType;
  /** Color theme. @default 'amber' */
  color?: CalloutColor;
  /** Body content (rendered in a small-text container). */
  children?: React.ReactNode;
  /** Extra className appended to the container (merge after color classes). */
  className?: string;
}

const CALLOUT_COLORS: Record<CalloutColor, string> = {
  amber: 'border-amber-500 bg-amber-50/60 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400',
  emerald: 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400',
  red: 'border-red-500 bg-red-50/60 dark:bg-red-950/20 text-red-700 dark:text-red-400',
  zinc: 'border-zinc-500 bg-zinc-50/60 dark:bg-zinc-900/20 text-zinc-700 dark:text-zinc-400',
};

export const Callout = memo(function Callout({
  title,
  icon: Icon,
  color = 'amber',
  children,
  className,
}: CalloutProps) {
  return (
    <div className={`border-l-4 rounded-md p-3 ${CALLOUT_COLORS[color]} ${className ?? ''}`}>
      {(title || Icon) && (
        <div className="flex items-start gap-2 mb-1">
          {Icon && <Icon className="h-4 w-4 shrink-0 mt-0.5" />}
          {title && <h4 className="font-semibold text-sm">{title}</h4>}
        </div>
      )}
      {children && <div className="text-xs leading-relaxed">{children}</div>}
    </div>
  );
});
