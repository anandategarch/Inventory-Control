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
 * Readability on dark background (bg-primary):
 * - Formula box: bg-white/10 (translucent overlay) for separation
 * - Structured labels: colored badges (UNTUK APA=emerald, CARA BACA=sky, CONTOH=amber, ACTION=rose)
 * - Description text: text-primary-foreground/90 (slightly dimmed white)
 * - leading-relaxed for comfortable line height
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
        <TooltipContent side={side} className="max-w-md p-0">
          <div className="space-y-2 p-3">
            <p className="text-xs font-semibold">Rumus Perhitungan</p>
            <p className="text-[11px] font-mono bg-white/10 px-2 py-1.5 rounded border border-white/10">{formula}</p>
            {description && (
              <div className="text-[11px] leading-relaxed space-y-1">
                {description.split('\n').map((line, i) => {
                  if (line.trim() === '') return <div key={i} className="h-1" />;
                  // Color-code structured labels for readability on dark bg
                  const isUntukApa = line.startsWith('UNTUK APA:');
                  const isCaraBaca = line.startsWith('CARA BACA:');
                  const isContoh = line.startsWith('CONTOH:');
                  const isAction = line.startsWith('ACTION:');
                  const labelColor = isUntukApa ? 'text-emerald-300'
                    : isCaraBaca ? 'text-sky-300'
                    : isContoh ? 'text-amber-300'
                    : isAction ? 'text-rose-300'
                    : '';
                  if (labelColor) {
                    return (
                      <p key={i}>
                        <span className={`font-semibold ${labelColor}`}>{line}</span>
                      </p>
                    );
                  }
                  return <p key={i} className="text-primary-foreground/85">{line}</p>;
                })}
              </div>
            )}
            {example && (
              <p className="text-[11px] text-amber-300 italic">Contoh: {example}</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
