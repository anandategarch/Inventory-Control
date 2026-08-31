'use client';

// ============================================================
//  useStatus — TanStack Query hook for /api/status
//  --------------------------------------------------------
//  Source: extracted from src/hooks/useAnalysis.ts (split by
//  Task ID 3-a). Self-contained — defines its own response
//  types (SourceFileInfo, StatusData) next to the hook.
// ============================================================
import { useQuery } from '@tanstack/react-query';

// ============================================================
//  Source file metadata — mirrors /api/status SourceFile select.
// ============================================================
export interface SourceFileInfo {
  fileName: string;
  monthLabel: string;
  monthKey: string;
  rowCount: number;
  dqStatus: string;
  importedAt: string;
}

export interface StatusData {
  success: boolean;
  // FIX (AUDIT8-ROLLBACK-1, Item 12): backend EMPTY_STATE returns setupRequired:true
  // when DB tables are not yet created — frontend uses this to redirect to /setup.
  setupRequired?: boolean;
  files: SourceFileInfo[];
  months: Array<{ label: string; key: string }>;
  weeksByMonth: Record<string, string[]>;
  outlets: Array<{ code: string; name: string; area: string; pic: string | null }>;
  areas: string[];
  pics: string[];
  kelompokOptions?: Array<{ kelompok: string; outletCount: number; area: string }>;
  stats: { totalFiles: number; totalOutlets: number; totalItems: number; totalRecords: number };
  warning?: string;
  cached?: boolean;
}

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      const res = await fetch('/api/status');
      // Guard: server crashes return HTML, not JSON
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error (HTTP ${res.status}). Server mungkin crash atau timeout. Coba refresh halaman.`);
      }
      if (!res.ok) {
        const e = (await res.json().catch(() => ({ message: 'Request failed' }))) as { message?: string };
        throw new Error(e.message || `HTTP ${res.status}`);
      }
      return res.json() as Promise<StatusData>;
    },
    staleTime: 5 * 60 * 1000, // Phase 1d: 5 min (was 30s) — data rarely changes
    // PERF-FE: status is a setup/index query — switching browser tabs should NOT
    // trigger a refetch. The 5-min staleTime is sufficient. Manual refresh button
    // is available in the header for the rare case where the user uploaded a
    // file in another tab and wants to see it here.
    refetchOnWindowFocus: false,
  });
}
