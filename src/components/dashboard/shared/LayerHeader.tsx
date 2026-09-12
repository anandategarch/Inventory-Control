'use client';

// ============================================================
//  LayerHeader — eyebrow heading for the narrative layers
//  (L2-L6) of the Visual Hierarchy restructure.
//  --------------------------------------------------------
//  MASTER-CONTEXT-VISUAL-HIERARCHY.md §5.1:
//    [01] EXECUTIVE STATUS ─────────────────────────────────
//    text-xs font-medium uppercase tracking-[0.14em]
//    text-muted-foreground; number tabular-nums
//    text-foreground/40; filler line h-px flex-1 bg-border.
//
//  It is a REAL <h2> (not a div) so the document keeps a valid
//  heading order: h1 (page title) → h2 (layer eyebrow) → h3
//  (card titles). Consumers pair it with
//  <section id="…" aria-labelledby="…" className="scroll-mt-32">
//  so each layer is a landmark + anchor target (spec §6.6 —
//  scroll-mt-32 compensates the sticky header).
//  SectionHeader (shared/index.tsx) stays in use INSIDE the L6
//  tab content for sub-sections — this component only labels
//  the narrative layers.
// ============================================================

export interface LayerHeaderProps {
  /** Zero-padded layer number, e.g. "01" (tabular-nums, dimmed). */
  number: string;
  /** Uppercase layer title, e.g. "EXECUTIVE STATUS". */
  title: string;
  /** Optional id — pass the value used by the section's aria-labelledby. */
  id?: string;
}

export function LayerHeader({ number, title, id }: LayerHeaderProps) {
  return (
    <h2
      id={id}
      className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground flex items-center gap-3 w-full"
    >
      <span className="tabular-nums text-foreground/40">{number}</span>
      <span>{title}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </h2>
  );
}
