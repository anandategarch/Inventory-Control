'use client';

// ============================================================
//  fetchAnalysis — HTTP fetcher for /api/analysis
//  --------------------------------------------------------
//  Source: extracted from src/hooks/useAnalysis.ts (split by
//  Task ID 3-a). Used by useAnalysis (live query) and
//  prefetchAnalysis (warm cache before user click).
// ============================================================
import type { AnalysisData } from './types';

export async function fetchAnalysis(params: URLSearchParams): Promise<AnalysisData> {
  // FIX (LOADING-TIMEOUT): AbortController — if server doesn't respond in 90s,
  // abort the fetch so TanStack Query can retry (instead of infinite loading).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`/api/analysis?${params.toString()}`, {
      signal: controller.signal,
    });
    // FIX: Check content-type — server crash returns HTML, not JSON
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string; error?: string; success?: boolean };
      // FIX: 404 with "No records found" is NOT always a missing-data issue.
      // It can also mean the user selected contradictory filters (e.g.,
      // kelompok=BDG + outlet=JKT, or kelompok=BDG + area=JAWA TIMUR 1 where
      // no BDG outlets exist in that area). The old message ("Upload file Excel")
      // was misleading — it hinted at missing data when the real cause was
      // filter conflict. Now we check if any filter is active and tailor the
      // message accordingly.
      // FIX (BUG-FE-6 / BUG-EDGE-11): improved error message for contradictory filters.
      if (res.status === 404 && e.message?.includes('No records found')) {
        const url = new URL(res.url);
        const hasFilter = url.searchParams.get('area') || url.searchParams.get('kelompok')
          || url.searchParams.get('outlet') || url.searchParams.get('pic') || url.searchParams.get('item');
        if (hasFilter) {
          throw new Error(`Tidak ada data untuk kombinasi filter ini. Periksa apakah filter Area, Kelompok, Outlet, atau PIC saling bertentangan (mis: kelompok=BDG + outlet di luar BDG). Coba reset filter atau ubah kombinasi.`);
        }
        throw new Error(`Tidak ada data untuk periode ini. Upload file Excel untuk bulan/week yang dipilih.`);
      }
      throw new Error(e.message || e.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err: unknown) {
    // AbortError = timeout — throw a friendly message
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Server timeout (90s). Query terlalu berat — coba lagi atau persempit filter.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
