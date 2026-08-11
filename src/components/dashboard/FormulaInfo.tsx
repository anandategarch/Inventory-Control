'use client';

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
 * Info icon with tooltip showing calculation formula.
 * Use in chart card headers to explain how the metric is computed.
 *
 * Readability improvements:
 * - Uses bg-popover (light bg in light mode, dark bg in dark mode) for high contrast
 * - max-w-md (28rem) for longer structured descriptions
 * - Structured layout: header + formula box + description + example
 * - Description supports \n line breaks for UNTUK APA/CARA BACA/CONTOH/ACTION format
 */
export function FormulaInfo({ formula, description, side = 'top' }: FormulaInfoProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Lihat rumus perhitungan"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-md p-0">
          <div className="space-y-2 p-3">
            <p className="text-xs font-semibold text-foreground">Rumus Perhitungan</p>
            <p className="text-[11px] font-mono bg-muted text-foreground px-2 py-1.5 rounded border border-border/50">{formula}</p>
            {description && (
              <div className="text-[11px] text-muted-foreground leading-relaxed space-y-1">
                {description.split('\n').map((line, i) => (
                  <p key={i} className={line.trim() === '' ? 'h-1' : ''}>
                    {line.includes('UNTUK APA:') || line.includes('CARA BACA:') || line.includes('CONTOH:') || line.includes('ACTION:') ? (
                      <span className="text-foreground font-medium">{line}</span>
                    ) : (
                      line
                    )}
                  </p>
                ))}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
