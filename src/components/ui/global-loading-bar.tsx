'use client';

import { useIsFetching } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

// ============================================================
//  GlobalLoadingBar — top progress bar (like NProgress)
//  Shows when ANY React Query is fetching (background refetch,
//  filter change, tab switch, mutation, etc.)
//  Pure CSS animation — no setState in effects.
// ============================================================

export function GlobalLoadingBar() {
  const isFetching = useIsFetching();
  const active = isFetching > 0;

  return (
    <div
      className={cn(
        'fixed top-0 left-0 right-0 z-[100] h-0.5 pointer-events-none overflow-hidden',
        active ? 'opacity-100' : 'opacity-0'
      )}
      style={{ transition: 'opacity 200ms ease-out' }}
    >
      <div
        className={cn(
          'h-full bg-primary',
          active ? 'global-loading-bar-active' : 'global-loading-bar-done'
        )}
      />
      <style jsx>{`
        @keyframes loadingBarProgress {
          0% { width: 0%; }
          50% { width: 70%; }
          100% { width: 90%; }
        }
        @keyframes loadingBarDone {
          0% { width: 90%; }
          100% { width: 100%; }
        }
        .global-loading-bar-active {
          animation: loadingBarProgress 1.5s ease-out forwards;
        }
        .global-loading-bar-done {
          animation: loadingBarDone 200ms ease-out forwards;
        }
      `}</style>
    </div>
  );
}
