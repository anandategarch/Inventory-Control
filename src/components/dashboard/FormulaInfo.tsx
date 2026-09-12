'use client';

import { memo } from 'react';
import { Info } from 'lucide-react';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

interface FormulaInfoProps {
  formula: string;
  description?: string;
  example?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * THE single info tooltip for card/chart headers.
 *
 * UX-TOOLTIP-1 (user request 2025-12): cards used to show TWO info
 * icons (InfoTooltip + FormulaInfo side by side). They are now ONE
 * icon, and the tooltip leads with the "ini buat apa" explanation
 * in plain Indonesian — the formula survives only as a small
 * monospace footnote for readers who want it.
 *
 * Content convention (description, newline-separated):
 *   UNTUK APA: ...  — what this card is for (always first)
 *   CARA BACA: ...  — how to read the numbers (optional)
 *   CONTOH: ...     — a numeric example (optional)
 *   ACTION: ...     — what to do next (optional)
 * Lines not starting with a known label render as plain paragraphs.
 *
 * Readability on the dark tooltip bg (bg-primary):
 * - label prefixes render bold (foreground), body at /85 opacity
 * - formula footnote: font-mono, /75 opacity, separated by a hairline
 * - example footnote: italic, /75 opacity
 */
export const FormulaInfo = memo(function FormulaInfo({ formula, description, example, side = 'top' }: FormulaInfoProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Informasi — ini buat apa"
            tabIndex={0}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-[320px] p-3">
          <div className="space-y-1.5 text-xs leading-relaxed">
            {description && description.split('\n').map((line, i) => {
              if (line.trim() === '') return <div key={i} className="h-1" />;
              const m = line.match(/^(UNTUK APA|CARA BACA|CONTOH|ACTION|DRILL-DOWN):\s*(.*)$/);
              if (m) {
                return (
                  <p key={i}>
                    <span className="font-semibold text-primary-foreground">{m[1]}:</span>{' '}
                    <span className="text-primary-foreground/85">{m[2]}</span>
                  </p>
                );
              }
              return <p key={i} className="text-primary-foreground/85">{line}</p>;
            })}
            {formula && (
              <p className="pt-1.5 mt-0.5 border-t border-white/15 font-mono text-[11px] leading-snug text-primary-foreground/75 break-words">
                Rumus: {formula}
              </p>
            )}
            {example && (
              <p className="text-[11px] italic text-primary-foreground/75">Contoh: {example}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
