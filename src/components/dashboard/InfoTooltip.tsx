'use client';

import { memo } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

interface InfoTooltipProps {
  content: string;
  className?: string;
}

export const InfoTooltip = memo(function InfoTooltip({ content, className = '' }: InfoTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center justify-center text-muted-foreground/60 hover:text-muted-foreground transition-colors ${className}`}
          aria-label="Informasi"
          tabIndex={0}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[320px] text-xs leading-relaxed">
        {content}
      </TooltipContent>
    </Tooltip>
  );
});
