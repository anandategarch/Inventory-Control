# FIX-A — Security Bug Fixer

**Task ID:** FIX-A
**Agent:** Security Bug Fixer
**Task:** Fix CRITICAL security bugs (path traversal, rate limit, file size, race condition)

## Summary

Fixed 6 security/data-integrity bugs reported in BUG-5 audit. All fixes are minimal and
targeted — no unrelated code touched. `bun run lint` and `npx tsc --noEmit --skipLibCheck`
both pass with 0 errors after the changes.

## Bugs Fixed

### FIX-A-1 (BUG-5-1, CRITICAL) — Path traversal in ingest-process
**File:** `src/app/api/ingest-process/route.ts`

**Problem:** `reassembleFile()` wrote to `path.join('/tmp/ingest-process', \`${fileHash}${ext}\`)`
using unsanitized client-supplied `fileHash` and `ext`. An attacker could supply
`fileHash="../../etc/cron.d/evil"` to write files outside /tmp/ingest-process.

**Fix:**
- Added `SAFE_FILEHASH_RE = /^[a-f0-9]{8,128}$/i` and `SAFE_EXT_ALLOWLIST = Set(['.xlsx', '.xls', '.csv'])`.
- Added `validateFileMetadata(fileHash, ext)` helper at `route.ts:29-47` that rejects
  non-hex fileHash or non-allowlisted ext with HTTP 400.
- Validation runs in POST handler at `route.ts:104-123` BEFORE any disk I/O.
- Replaced all subsequent usages of raw `fileHash` with validated `safeFileHash`:
  `reassembleFile(safeFileHash, fileExt)`, `db.fileChunk.deleteMany({ where: { fileHash: safeFileHash } })`,
  `fileHash: \`${safeFileHash}-${weekLabel}\`` for SourceFile creation.
- Removed the duplicate `const fileExt = ext || path.extname(fileName).toLowerCase()`
  that was computing ext from raw `ext`.
- DELETE handler kept unchanged (DB-only, no disk operation — Prisma parameterizes).

### FIX-A-2 (BUG-5-3, CRITICAL) — Missing rate limit on GET /api/ingest
**File:** `src/app/api/ingest/route.ts:44-69` (GET handler)

**Problem:** GET handler (bulk ingestion path, heavier than POST) had no rate limiting.
Attacker could DoS by repeatedly calling `GET /api/ingest?fast=true`.

**Fix:**
- Mirrored POST handler's rate-limit pattern at the top of GET:
  ```ts
  const ip = getClientIP(req);
  const rl = rateLimit(`ingest:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
  if (!rl.allowed) return NextResponse.json({ ... }, { status: 429, headers: { 'Retry-After': ... } });
  ```
- Imports (`rateLimit, getClientIP, RATE_LIMITS`) already present from POST — no new imports.
- Verified other routes (`ingest-upload`, `ingest-process`, `export-report`, `analysis`)
  already have rate limiting — only GET /api/ingest was missing.

### FIX-A-3 (BUG-5-4, CRITICAL) — Client-trusted file size in ingest-upload
**File:** `src/app/api/ingest-upload/route.ts`

**Problem:** 50MB cap used client-provided `fileSize` — attacker could set `fileSize: 0`
to bypass. Also no per-chunk size validation → OOM risk via single oversized chunk.

**Fix:**
- Added `MAX_CHUNK_SIZE = 5MB` and `MAX_TOTAL_SIZE = 50MB` constants at `route.ts:19-20`.
- Per-chunk size validation BEFORE `chunk.arrayBuffer()` (which loads whole chunk into RAM):
  `if (chunk.size > MAX_CHUNK_SIZE) return 413` at `route.ts:64-69`.
- Removed client-provided `fileSize` from the size cap check (kept `fileSizeStr` parse
  only for backward-compat, but it's no longer used for enforcement).
- After last chunk: query all chunks for `fileHash`, sum `data.length` server-side,
  if `totalBytes > MAX_TOTAL_SIZE` → delete chunks and return 413 at `route.ts:99-114`.
- Response `fileSize` field now returns server-verified `totalBytes` (not client value)
  at `route.ts:122`.
- Also changed `parseInt(chunkIndexStr)` → `parseInt(chunkIndexStr, 10)` for radix safety
  (same change applied to `totalChunksStr`).

### FIX-A-4 (BUG-5-5, CRITICAL) — Race condition in outlet/item creation
**File:** `src/lib/ingestion.ts` (two locations)

**Problem:** Lazy `findUnique + create` for new outlets/items raced under concurrent
imports of different weeks for the same new outlet → P2002 unique constraint violation
→ entire week import failed.

**Fix (both `processIngestion` and `processRowsForImport`):**
- Replaced `findUnique + create` with atomic `db.outlet.upsert({ where: { code }, update, create })`.
- Outlet update preserves LOGIC-12 behavior: updates `area` + `name` only when `n.area`
  is truthy (outlet moved to different area).
- Item upsert in `processRowsForImport` preserves satuan back-fill: when existing item
  has null satuan and current row provides one, `update: { satuan: n.satuan }` fills it.
  Returns row after upsert (via `select: { id: true, satuan: true }`) so cache reflects
  post-update value.
- Item upsert in `processIngestion` is simpler (no satuan back-fill needed there —
  pre-loaded allItems cache handles existing items, upsert only handles race window):
  `update: {}`, cache set with `satuan: n.satuan` (consistent with prior behavior).

### FIX-A-5 (BUG-5-2, CRITICAL) — Alphabetical month sort
**File:** `src/app/api/analysis/route.ts:149-171`

**Problem:** `orderBy: [{ monthLabel: 'desc' }, { weekLabel: 'desc' }]` sorted Indonesian
month names alphabetically — `SEPTEMBER > OKTOBER > NOVEMBER > MEI > ...`. Returned wrong
"latest" period (e.g., September instead of December) when dashboard loaded with no
query params.

**Fix:**
- Replaced with Prisma nested orderBy on the `week` relation:
  ```ts
  orderBy: [
    { week: { monthKey: 'desc' } },     // "2026-12" > "2026-07" chronologically
    { week: { periodEnd: 'desc' } },    // 25 > 21 > 14 > 7 (cumulative week-end day)
  ],
  ```
- Verified schema: `InventoryRecord.week → Week` has `monthKey: String` (YYYY-MM)
  and `periodEnd: Int` (cumulative day-end) — both chronologically sortable.
- Verified NO other places in src/ sort by `monthLabel` (grep confirmed only one match).
- Did NOT add a `monthNum` field (audit's alternative proposal) — using existing
  `Week.monthKey` + `Week.periodEnd` avoids schema migration.

### FIX-A-6 (BUG-5-14, HIGH) — Settings DELETE no transaction
**File:** `src/app/api/settings/route.ts:212-234` (reset-all branch of DELETE)

**Problem:** Reset-all loop called `db.setting.upsert` individually for each
`SETTING_DEFINITIONS` entry — NOT wrapped in transaction. If one upsert failed midway
(DB timeout on 5th of 30 settings), DB left with some settings reset and others at old
values → inconsistent state.

**Fix:**
- Wrapped the loop in `await db.$transaction(SETTING_DEFINITIONS.map(def => db.setting.upsert({...})))`
  — same pattern as POST handler at `route.ts:139-156`.
- Single-key reset branch (line 199-211) left unchanged — single upsert is atomic by itself.
- POST handler already used this pattern; DELETE now matches.

## Verification

```
$ bun run lint
$ eslint .
(0 errors, 0 warnings)

$ npx tsc --noEmit --skipLibCheck
(0 errors, exit 0)
```

Dev server confirmed running on port 3000 — no compile errors after changes
(see `/home/z/my-project/dev.log`).

## Files Modified

1. `src/app/api/ingest-process/route.ts` — FIX-A-1 (path traversal validation)
2. `src/app/api/ingest/route.ts` — FIX-A-2 (rate limit on GET)
3. `src/app/api/ingest-upload/route.ts` — FIX-A-3 (server-side size enforcement)
4. `src/lib/ingestion.ts` — FIX-A-4 (upsert instead of findUnique+create, two locations)
5. `src/app/api/analysis/route.ts` — FIX-A-5 (chronological sort via Week.monthKey)
6. `src/app/api/settings/route.ts` — FIX-A-6 (transaction-wrapped reset-all)

## Notes

- FIX-A-1 also addresses the related concern in BUG-5-4(a) (ingest-process trust of
  client fileSize) by noting that client fileSize is now advisory only — real size
  enforcement moved to upload time (FIX-A-3).
- The audit suggested ext allowlist `['.xlsx', '.xls', '.csv']` for ingest-process.
  ingest-upload route kept its stricter `['.xlsx', '.csv']` allowlist unchanged
  (no `.xls`) to avoid expanding the upload attack surface beyond what was there
  before. ingest-process accepts `.xls` because it parses whatever ingest-upload
  already accepted plus files coming from other paths (drive-import).
