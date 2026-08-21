'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================
//  Loading Components — reusable loading indicators
// ============================================================

// Small inline spinner (for buttons, badges, inline text)
export function LoadingSpinner({ className, size = 'h-4 w-4' }: { className?: string; size?: string }) {
  return <Loader2 className={cn(size, 'animate-spin', className)} />;
}

// Card loading overlay — shows skeleton placeholders inside a card
export function CardLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

// Table loading — skeleton rows for tables
export function TableLoading({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-2">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-6 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

// Full card with header + loading body
export function CardWithLoading({
  title,
  icon,
  isLoading,
  children,
  loadingRows = 3,
}: {
  title?: string;
  icon?: React.ReactNode;
  isLoading: boolean;
  children: React.ReactNode;
  loadingRows?: number;
}) {
  return (
    <Card>
      {title && (
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            {icon}
            {title}
            {isLoading && <LoadingSpinner size="h-3 w-3" className="text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
      )}
      <CardContent>
        {isLoading ? <CardLoading rows={loadingRows} /> : children}
      </CardContent>
    </Card>
  );
}

// Inline loading text with spinner
export function LoadingText({ text = 'Memuat...', className }: { text?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground', className)}>
      <LoadingSpinner size="h-4 w-4" />
      <span>{text}</span>
    </div>
  );
}

// Overlay loading — semi-transparent overlay on top of content
export function LoadingOverlay({ visible, text = 'Memuat...' }: { visible: boolean; text?: string }) {
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoadingSpinner size="h-5 w-5" />
        <span>{text}</span>
      </div>
    </div>
  );
}

// Skeleton grid (for dashboard cards)
export function SkeletonGrid({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}
