// ============================================================
//  TopItems — Barrel Export — GODSPLIT-W2-B
//  --------------------------------------------------------
//  GODSPLIT-W2-B: split grab-bag 4 kartu → folder; barrel menjaga
//  import path. TopItems.tsx (457 LOC) was a multi-export grab-bag
//  whose four unrelated cards serve two different tabs — each card
//  now lives in its own file (pure move: zero logic / JSX changes,
//  dead-code history comments moved with their cards).
//
//  Usage (unchanged public API — named exports, verbatim):
//    import { TopItemsByNominal, TopItemsByDevBom } from '@/components/dashboard/TopItems';   // tabs/ItemTab
//    import { ParetoDevBomCard, GapAnalysisCard } from '@/components/dashboard/TopItems';     // ParetoDashboard
//
//  Path resolution: '@/components/dashboard/TopItems' resolves to this
//  index.tsx (folder import via moduleResolution: bundler) — same trick
//  as Charts/index.ts; both consumers above keep working unchanged.
// ============================================================
export { TopItemsByNominal } from './TopItemsByNominal';
export { TopItemsByDevBom } from './TopItemsByDevBom';
export { ParetoDevBomCard } from './ParetoDevBomCard';
export { GapAnalysisCard } from './GapAnalysisCard';
