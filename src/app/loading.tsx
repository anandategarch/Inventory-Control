// Next.js loading.tsx — shown immediately while page chunk loads
// Provides instant visual feedback before React hydrates

export default function Loading() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header skeleton */}
      <header className="border-b bg-background/95 backdrop-blur sticky top-0 z-40">
        <div className="px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary animate-pulse" />
            <div className="space-y-1">
              <div className="h-4 w-48 bg-muted rounded animate-pulse" />
              <div className="h-3 w-32 bg-muted rounded animate-pulse" />
            </div>
          </div>
          <div className="h-6 w-20 bg-muted rounded animate-pulse" />
        </div>
      </header>

      {/* Filter bar skeleton */}
      <div className="px-4 sm:px-6 py-4 max-w-[1600px] w-full mx-auto">
        <div className="rounded-lg border bg-card p-3 mb-4">
          <div className="flex flex-wrap items-end gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1 min-w-[140px]">
                <div className="h-3 w-12 bg-muted rounded animate-pulse" />
                <div className="h-9 w-full bg-muted rounded animate-pulse" />
              </div>
            ))}
            <div className="flex-1" />
            <div className="h-9 w-20 bg-muted rounded animate-pulse" />
            <div className="h-9 w-24 bg-muted rounded animate-pulse" />
          </div>
        </div>

        {/* KPI cards skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-2">
              <div className="h-3 w-20 bg-muted rounded animate-pulse" />
              <div className="h-6 w-24 bg-muted rounded animate-pulse" />
              <div className="h-3 w-16 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Secondary cards skeleton */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-3 space-y-2">
              <div className="h-3 w-16 bg-muted rounded animate-pulse" />
              <div className="h-5 w-20 bg-muted rounded animate-pulse" />
              <div className="h-3 w-14 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Chart skeletons */}
        <div className="grid lg:grid-cols-3 gap-4 mb-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="h-4 w-32 bg-muted rounded animate-pulse" />
              <div className="h-48 w-full bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Table skeletons */}
        <div className="grid lg:grid-cols-3 gap-4 mb-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="h-4 w-40 bg-muted rounded animate-pulse" />
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className="h-6 w-full bg-muted rounded animate-pulse" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer skeleton */}
      <footer className="mt-auto border-t bg-background/95">
        <div className="px-4 sm:px-6 py-2.5 flex items-center gap-3">
          <div className="h-3 w-40 bg-muted rounded animate-pulse" />
          <div className="h-3 w-32 bg-muted rounded animate-pulse ml-auto" />
        </div>
      </footer>
    </div>
  );
}
