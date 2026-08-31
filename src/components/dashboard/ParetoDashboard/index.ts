// ============================================================
//  ParetoDashboard — Barrel Export
//  --------------------------------------------------------
//  Import path '@/components/dashboard/ParetoDashboard' resolves
//  to this file (folder + index.ts). Re-exports the main
//  component (named export — preserves existing caller imports
//  like `import { ParetoDashboard } from '@/components/dashboard/ParetoDashboard'`)
//  plus all types, constants, and sub-components for reuse.
//
//  Usage:
//    import { ParetoDashboard } from '@/components/dashboard/ParetoDashboard';
//    import type { ParetoData, ParetoDimension } from '@/components/dashboard/ParetoDashboard';
// ============================================================

// Main component (named export — preserves existing caller import shape)
export { ParetoDashboard } from './ParetoDashboard';

// Sub-components (re-exported for reusability)
export { QuadrantCard } from './QuadrantCard';
export { NestedItemToOutlet } from './NestedItemToOutlet';
export { GeneralizedNested } from './GeneralizedNested';
export { ActionPlanFooter } from './ActionPlanFooter';

// Types
export type {
  ParetoDimension,
  NestedChild,
  NestedGeneralizedItem,
  ParetoRow,
  ParetoResult,
  NestedOutlet,
  NestedItem,
  ParetoData,
} from './types';

// Constants & helpers
export { DIM_LABELS, QUADRANT_TOOLTIPS, countSuffix } from './constants';
