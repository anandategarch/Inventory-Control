'use client';

// ============================================================
//  Error Boundary — Next.js App Router convention
//  Catches client-side errors to prevent white screen.
//  FIX BUG #6: Previously, a client-side crash (like the
//  fmtIDR ReferenceError) would show a blank white page.
// ============================================================

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console for debugging
    console.error('[Error Boundary]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full">
        <CardContent className="p-6 text-center space-y-4">
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 dark:bg-red-950/40">
              <AlertTriangle className="h-8 w-8 text-red-600" />
            </div>
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Terjadi Kesalahan</h2>
            <p className="text-sm text-muted-foreground">
              Aplikasi mengalami error. Coba muat ulang halaman atau kembali ke beranda.
            </p>
          </div>
          {error?.message && (
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground text-left">
              <p className="font-mono break-all">{error.message}</p>
              {error.digest && (
                <p className="mt-1 text-[10px]">Error ID: {error.digest}</p>
              )}
            </div>
          )}
          <div className="flex gap-2 justify-center">
            <Button onClick={reset} size="sm">
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Coba Lagi
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.href = '/'}
            >
              Ke Beranda
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
