// ============================================================
//  delete-mode — DELETE /api/ingest-process
//  --------------------------------------------------------
//  Extracted from the original 963-line route.ts (REFACTOR-1-a
//  pure-move split). Cleanup endpoint: deletes the uploaded
//  file's FileChunk rows from DB (rate-limited, Zod-validated).
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP } from '@/lib/rate-limit';
import { validateBody, ingestProcessDeleteBodySchema } from '@/lib/validation';
import { errorResponse } from '@/lib/error-response';

export async function handleDelete(req: NextRequest): Promise<NextResponse> {
  try {
    // P2-12 fix: rate limit DELETE to prevent abuse
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-process-delete:${ip}`, 10, 60_000); // 10 per min
    if (!rl.allowed) {
      return NextResponse.json({ success: false, error: 'Rate limit.' }, { status: 429 });
    }
    const body = await req.json();
    // FIX (AUDIT8-ROLLBACK-1, Item 10): Zod body validation for DELETE.
    // Previously the DELETE handler destructured `fileHash` directly from the
    // raw JSON body with no shape check — an attacker could pass arbitrary
    // shapes (objects, arrays, very long strings) that Prisma would then
    // attempt to use in a `where: { fileHash }` clause. Now validated against
    // ingestProcessDeleteBodySchema (hex string, 8-128 chars, optional).
    const validation = validateBody(ingestProcessDeleteBodySchema, body);
    if (!validation.success) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const { fileHash } = validation.data;
    if (fileHash) {
      await db.fileChunk.deleteMany({ where: { fileHash } });
    }
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return errorResponse(e, "ingest-process");
  }
}
