# Task ID: FIX-DEEP-5 — Security Fixer

## Task
Fix Caddyfile SSRF (5A) + create .env.example (5B) + allow SQLite in dev mode in db.ts (5C) + add rate limiting to 5 mutation endpoints (5D). LLM timeout was already handled in FIX-DEEP-3.

## Bugs Fixed

### FIX-DEEP-5A — Caddyfile SSRF (DEEP-AUDIT-SECURITY-3, CRITICAL)
**File:** `Caddyfile`
- Replaced `query XTransformPort=*` (allows ANY port → SSRF to PostgreSQL/Redis/SSH) with explicit allowlist `query XTransformPort=3003` (only websocket mini-service port).
- mini-services folder was empty; only port 3003 (websocket example in `examples/websocket/server.ts`) is referenced in codebase.
- Comment added: "Add more allowed ports here as needed".

### FIX-DEEP-5B — .env.example (DEEP-AUDIT-SECURITY-5, HIGH)
**Files:** `.env.example` (new), `.gitignore`
- Created `.env.example` with `DATABASE_URL` (PostgreSQL placeholder), commented `ADMIN_TOKEN`, `GOOGLE_DRIVE_API_KEY`, `INVENTORY_DATA_DIR`. No real secrets.
- Added `!.env.example` exception to `.gitignore` so the template gets committed (was being ignored by `.env*` glob).

### FIX-DEEP-5C — SQLite rejection in dev (DEEP-AUDIT-SECURITY-5)
**File:** `src/lib/db.ts:51-63`
- `.env` has `DATABASE_URL=file:/home/z/my-project/db/custom.db` (SQLite). Previously `db.ts` threw hard error → local dev crashed.
- New logic: if `dbUrl.startsWith('file:' | 'libsql://' | 'http')`:
  - In production (`NODE_ENV === 'production'`): throw error (PostgreSQL required).
  - In dev: `console.warn` + return `new PrismaClient({ log: ['error', 'warn'] })`.

### FIX-DEEP-5D — Rate limiting on mutation endpoints (DEEP-AUDIT-API-5, MEDIUM)
Added `rateLimit()` + `getClientIP()` + 429 response to 5 handlers across 4 files:

| File | Handler | Rate limit key | Config |
|------|---------|----------------|--------|
| `src/app/api/data/route.ts` | DELETE | `data:${ip}` | `RATE_LIMITS.ingest` (5/min) |
| `src/app/api/settings/route.ts` | POST | `settings:${ip}` | `RATE_LIMITS.settings` (10/min) |
| `src/app/api/pic/route.ts` | POST | `pic:${ip}` | `RATE_LIMITS.ingest` (5/min) |
| `src/app/api/pic/route.ts` | DELETE | `pic:${ip}` | `RATE_LIMITS.ingest` (5/min) |
| `src/app/api/pic/import/route.ts` | POST | `pic-import:${ip}` | `RATE_LIMITS.ingest` (5/min) |

Pattern matches existing `ingest` route: `getClientIP(req)` (uses trusted `x-vercel-forwarded-for` / `x-real-ip`) → `rateLimit()` (in-memory fixed-window) → 429 JSON response if `!rl.allowed`.

## Verification
- `bun run lint` — exit 0, 0 errors, 0 warnings.
- `npx tsc --noEmit --skipLibCheck` — exit 0, 0 errors.

## Not Touched
- LLM timeout (handled in FIX-DEEP-3 per task spec).
- Settings DELETE handler (not in spec — spec only listed POST).
- Other deep-audit findings (DEEP-AUDIT-SECURITY-1, -2, -4, -6, -7, etc.) — out of scope for this task ID.
