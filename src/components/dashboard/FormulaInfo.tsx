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
 */
export function FormulaInfo({ formula, description, example, side = 'top' }: FormulaInfoProps) {
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
        <TooltipContent side={side} className="max-w-sm">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold">Rumus Perhitungan</p>
            <p className="text-[11px] font-mono bg-muted/50 px-1.5 py-1 rounded">{formula}</p>
            {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
            {example && (
              <p className="text-[11px] text-muted-foreground italic">Contoh: {example}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
