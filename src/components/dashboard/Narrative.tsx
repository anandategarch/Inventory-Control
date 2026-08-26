'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { AnalysisData } from '@/hooks/useAnalysis';

export function RecommendationPanel({ data }: { data: AnalysisData }) {
  const recs = data.recommendation || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          Rekomendasi
        </CardTitle>
      </CardHeader>
      <CardContent>
        {recs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">Tidak ada rekomendasi</p>
        ) : (
          <div className="space-y-3">
            {recs.map((r, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Badge
                    variant="outline"
                    className={`text-[11px] ${r.priority === 'P1' ? 'text-red-700 bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-900 dark:text-red-400' : r.priority === 'P2' ? 'text-amber-700 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-400' : 'text-sky-700 bg-sky-50 border-sky-200 dark:bg-sky-950/40 dark:border-sky-900 dark:text-sky-400'}`}
                  >
                    {r.priority}
                  </Badge>
                  <AlertCircle className="h-3 w-3 text-muted-foreground" />
                </div>
                <p className="text-xs font-semibold text-foreground mb-1">{r.why}</p>
                <ul className="text-xs text-muted-foreground space-y-0.5 ml-4 list-disc">
                  {r.what.map((w, j) => (
                    <li key={j}>{w}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
