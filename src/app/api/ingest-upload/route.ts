// ============================================================
//  /api/ingest-upload — Chunked upload, chunks stored in DB
//  Vercel /tmp doesn't persist between invocations, so we
//  store each chunk in FileChunk table. Last chunk returns
//  metadata so frontend can call /api/ingest-process.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-upload:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded.' },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const chunk = formData.get('chunk') as File | null;
    const chunkIndexStr = formData.get('chunkIndex') as string | null;
    const totalChunksStr = formData.get('totalChunks') as string | null;
    const fileName = formData.get('fileName') as string | null;
    const fileHash = formData.get('fileHash') as string | null;
    const fileSizeStr = formData.get('fileSize') as string | null;

    if (!chunk || chunkIndexStr === null || totalChunksStr === null || !fileName || !fileHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields.' },
        { status: 400 }
      );
    }

    const chunkIndex = parseInt(chunkIndexStr);
    const totalChunks = parseInt(totalChunksStr);
    const fileSize = parseInt(fileSizeStr || '0');
    const ext = path.extname(fileName).toLowerCase();

    if (ext !== '.xlsx' && ext !== '.csv') {
      return NextResponse.json(
        { success: false, error: `Format tidak didukung: ${ext}. Hanya .xlsx dan .csv.` },
        { status: 400 }
      );
    }

    if (fileSize > 50 * 1024 * 1024) {
      return NextResponse.json(
        { success: false, error: `File terlalu besar: ${(fileSize / 1024 / 1024).toFixed(1)}MB. Maks 50MB.` },
        { status: 400 }
      );
    }

    // Store chunk in DB (persistent across function invocations)
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());
    await db.fileChunk.upsert({
      where: {
        fileHash_chunkIndex: { fileHash, chunkIndex },
      },
      update: {
        data: chunkBuffer,
        totalChunks, // P2-11 fix: store totalChunks for validation
      },
      create: {
        fileHash,
        chunkIndex,
        totalChunks,
        data: chunkBuffer,
      },
    });

    // If not last chunk, return progress
    if (chunkIndex < totalChunks - 1) {
      return NextResponse.json({
        success: true,
        received: chunkIndex,
        totalChunks,
        progress: ((chunkIndex + 1) / totalChunks) * 100,
      });
    }

    // Last chunk — return metadata for processing
    return NextResponse.json({
      success: true,
      uploaded: true,
      fileHash,
      fileName,
      fileSize,
      ext,
      message: 'Upload selesai. Siap untuk processing.',
    });
  } catch (e: any) {
    console.error('[ingest-upload] error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
