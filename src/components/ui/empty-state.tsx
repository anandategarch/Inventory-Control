'use client';

// ============================================================
//  EmptyState — structured empty-state component (Pattern 4)
//  --------------------------------------------------------
//  Inspired by shadcn/ui v4 empty-state pattern. Renders a
//  centered icon + title + optional description + optional
//  action. PC-focused (no mobile-specific padding).
//
//  Usage:
//    <EmptyState
//      icon={Package}
//      title="Tidak ada data untuk item ini"
//      description="Item X tidak memiliki record dengan filter aktif."
//    />
//
//  Or with an action (e.g. a Callout tips box below):
//    <EmptyState
//      icon={TrendingUp}
//      title="Pilih item untuk melihat trend"
//      description="..."
//      action={<Callout color="amber" ...>...</Callout>}
//    />
//
//  No indigo or blue colors per project rule — uses muted token
//  for icon container. Caller is free to use any project palette
//  inside `action`.
// ============================================================

import { memo } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: React.ElementType;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState = memo(function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-6', className)}>
      {Icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted/40 text-muted-foreground/50 mb-3">
          <Icon className="h-7 w-7" />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-md leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
});

export type { EmptyStateProps };
