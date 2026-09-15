'use client';

// ============================================================
//  use-ingest — the "Sinkron File" action state (POST /api/ingest
//  re-scan of the server's Excel folder). Moved verbatim from
//  FilterBar.tsx (SPLIT-C pure code motion — zero behavior change):
//  the request, AbortController + 120s timeout, content-type guard,
//  ingest message lifecycle (8s auto-dismiss), and the full 19-key
//  invalidation are unchanged.
// ============================================================

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAllData } from '@/lib/query-invalidation';

export function useIngest() {
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  const queryClient = useQueryClient();

  async function handleIngest() {
    setIngesting(true);
    setIngestMsg(null);
    // FIX (BUG-3-b B11): AbortController + 120s timeout — a hung /api/ingest
    // kept the Sinkron File button spinning forever with no way out (pattern:
    // useDashboardActions handleExport / fetchAnalysis.ts).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      // FIX: Check content-type before parsing — server crash returns HTML
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server returned non-JSON response (HTTP ${res.status}). ${text.slice(0, 300)}`);
      }
      const d = await res.json();
      if (d.success) {
        const ingested = d.results.filter((r: any) => r.status === 'INGESTED');
        const skipped = d.results.filter((r: any) => r.status === 'SKIPPED');
        const errors = d.results.filter((r: any) => r.status === 'ERROR');
        setIngestMsg(`Ingested: ${ingested.length}, Skipped: ${skipped.length}, Errors: ${errors.length}`);
        // FIX (H-14/T3): full 19-key invalidation via shared helper — the old
        // 6-key subset left pareto/heatmap/trend/flip/drilldown/price-effect
        // keys stale in keep-alive tabs after an ingest.
        invalidateAllData(queryClient);
      } else {
        // UI-04 FIX: Show error to user instead of silent failure
        setIngestMsg(`Error: ${d.error || 'Unknown server error'}`);
      }
    } catch (e: unknown) {
      // FIX (BUG-3-b B11): AbortError → friendly Indonesian message instead
      // of "The user aborted a request".
      if (e instanceof Error && e.name === 'AbortError') {
        setIngestMsg('Error: Server timeout (120s) — server tidak merespons. Coba lagi nanti.');
      } else {
        setIngestMsg(`Error: ${(e instanceof Error ? e.message : String(e))}`);
      }
    } finally {
      clearTimeout(timeoutId);
      setIngesting(false);
      setTimeout(() => setIngestMsg(null), 8000);
    }
  }

  return { ingesting, ingestMsg, handleIngest };
}
