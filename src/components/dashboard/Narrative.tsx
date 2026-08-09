'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Lightbulb, FileText, Sparkles } from 'lucide-react';
import type { AnalysisData } from '@/hooks/useAnalysis';

export function NarrativePanel({ data }: { data: AnalysisData }) {
  const isLLM = data.narrativeSource === 'llm';
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Automatic Narrative
          </CardTitle>
          <Badge variant={isLLM ? 'default' : 'secondary'} className="text-xs">
            {isLLM ? (
              <><Sparkles className="h-3 w-3 mr-1" /> LLM Generated</>
            ) : (
              'Fallback (rule-based)'
            )}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-64">
          <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed text-foreground/90">
            {data.narrative}
          </pre>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export function RecommendationPanel({ data }: { data: AnalysisData }) {
  const recs = data.recommendation || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Lightbulb className="h-4 w-4" />
          Recommendation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {recs.map((r, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase">WHY</p>
                <p className="text-sm mt-0.5">{r.why}</p>
              </div>
              <Badge variant="outline" className={`text-xs ${r.priority === 'P1' ? 'text-red-600 border-red-300' : r.priority === 'P2' ? 'text-amber-600 border-amber-300' : 'text-sky-600 border-sky-300'}`}>
                {r.priority}
              </Badge>
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">WHAT TO CHECK</p>
              <ul className="mt-1 space-y-1">
                {r.what.map((w, j) => (
                  <li key={j} className="text-xs flex items-start gap-1.5">
                    <span className="text-muted-foreground mt-0.5">•</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
