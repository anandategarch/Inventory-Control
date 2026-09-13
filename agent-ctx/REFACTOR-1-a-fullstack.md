# REFACTOR-1-a — Backend god-file split (pure move)

Task ID: REFACTOR-1-a
Agent: fullstack (backend refactor)
Repo: /home/z/audit-inventory (branch: working tree, NOT committed — user will commit)

## Scope
Split 3 backend god files into small modules. ZERO behavior change, zero test edits, public import paths kept stable via barrels.

## 1. src/app/api/ingest-process/route.ts (963 lines → 7 files)
- `services/file-reassembly.ts` (95): SAFE_FILEHASH_RE/SAFE_EXT_ALLOWLIST (latter exported for route's ext fallback check), validateFileMetadata, reassembleFile, reuseTempFile — verbatim + FIX-A-1/PERF-UPLOAD-5/P2-11 markers kept.
- `services/shared.ts` (60): `IngestProcessContext` (mutable ctx: fileName/monthInfo reassignable by handlers — preserves the original `let` mutation flow) + extractMonthFromRows (module-level const arrow, verbatim).
- `services/detect-mode.ts` (130): handleDetect(ctx) — MODE 1 block verbatim (lines 239-350 old).
- `services/import-mode.ts` (325): handleImport(ctx) — MODE 2 block verbatim (355-653), incl. advisory-lock transaction + monthLabelForTx/monthKeyForTx captures + AUDIT-BUG-1/5, BUG2-INGEST-2/3 markers.
- `services/import-all-mode.ts` (287): handleImportAll(ctx) — MODE 3 block verbatim (661-920).
- `services/delete-mode.ts` (41): handleDelete(req) — DELETE block verbatim (936-963, AUDIT8-ROLLBACK-1 marker).
- `route.ts` (187, thin): keeps `export const dynamic`/`maxDuration`, POST = rate limit + Zod + destructure + locale + manual rename + fileHash/ext sanitize + placeholder detection → builds ctx → dispatches to the 3 mode handlers; DELETE delegates to handleDelete. PLACEHOLDER_PATTERNS/isPlaceholderName stay module-private in route.ts (Next.js forbids extra exports from route files). Only type-level adaptations: `body: Record<string, unknown>` in ctx (handlers read weekLabel via `as string`, weeksToImport via `(x as string[]) || []` — runtime identical to the old `any` destructure); variable reads via `ctx.*`.
- Pre-existing `services/parse-excel.ts` + `validate-input.ts` (committed at HEAD, referenced by nobody — dead code from an earlier refactor) were NOT touched.

## 2. src/lib/queries/growth-drivers.ts (696 → dir, 4 files, old file deleted)
- `types.ts` (105): all 6 interfaces (DriverEntry, DriverResult, GrowthDriverMetric, TopGrowthContributor, TopGrowthRow, TopGrowthResult) + FilterOpts alias (now exported — additive; was a private alias before).
- `drivers.ts` (290): queryGrowthDrivers + private aggregateSalesMode/aggregateItemMetrics/computePareto (TASK H-6/H-7 banners kept).
- `top-growth.ts` (325): queryTopGrowth + private aggregateDeviationMatrix/topContributors/shapeTopGrowthRows + DeviationCell + TOP_GROWTH_* consts.
- `index.ts` (21): barrel `export * from './types'|'./drivers'|'./top-growth'` — '@/lib/queries/growth-drivers' path unchanged for run-queries.ts, TopGrowthCard.tsx, useAnalysis/types.ts, both query test files. Internal imports are file-to-file ('../shared' for shared helpers). src/lib/queries/index.ts NOT touched (still does not re-export growth-drivers).

## 3. src/lib/aggregation-cache.ts (644 → dir, 7 files, old file deleted)
- `key-builder.ts` (108): SEP/SENTINEL_ALL/SENTINEL_NONE hoisted to module consts (task-directed), buildCacheKey verbatim, pure (no db import).
- `generation.ts` (40): `let cacheGeneration` + getCacheGeneration() + internal bumpCacheGeneration() — the BUG-2-b invariant comment moved with the state. bumpCacheGeneration NOT in the barrel (internal file-to-file use only).
- `store.ts` (194): DEFAULT_TTL_MS, getCached/getCachedWithMeta/getCachedRawWithMeta/setCached/setCachedRaw, CLEANUP_* consts + _lastCleanupAt + cleanupExpiredCache.
- `inflight.ts` (49): inflightPromises map + getInflight/setInflight with the guarded `finally` cleanup (BUG-2-b marker intact).
- `swr.ts` (170): withCacheAndDedup moved INTACT — only mechanical change: the 8 `cacheGeneration` reads became `getCacheGeneration()` (synchronous reads of the same module counter, semantically identical).
- `invalidate.ts` (138): invalidateCache + invalidateAnalysisCache — `cacheGeneration++` → `bumpCacheGeneration()` at both call sites (comments verbatim); ALL 36 route prefixes preserved ('analysis' … 'q-hist-catavg').
- `index.ts` (44): barrel re-exporting EXACTLY the old 13 public exports (explicit named re-exports, no `export *` → no accidental API additions). vi.mock('@/lib/aggregation-cache') in query-cache.test.ts keeps working; no non-mock code imports sub-files directly.

## Gates (all green)
- `bunx tsc --noEmit` → 0 errors
- `bun run test` → 473/473 passed (27 files), zero test edits
- `bunx eslint <scope>` → 0 errors; 5 warnings in new files map 1:1 to warnings of the deleted monoliths at HEAD (verified via `git worktree` lint of HEAD: old route.ts:736, aggregation-cache.ts:138/405/406, growth-drivers.ts:289); 3 more in untouched pre-existing parse-excel.ts/validate-input.ts
- `git status` → only scope files: route.ts (M), 2 old files (D), 3 new dirs; `git status tests/` empty

## Not done / notes for next agent
- No commit / push (user commits).
- Concurrent REFACTOR-1-b (frontend) agent's changes present in the working tree — do not revert.
