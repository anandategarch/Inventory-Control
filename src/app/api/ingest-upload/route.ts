// ============================================================
//  /api/ingest-upload — Chunked upload ONLY (no processing)
//  Saves chunks to /tmp. Last chunk returns file metadata.
//  Processing happens in separate /api/ingest-process endpoint.
//  This prevents 504 timeout: each request is fast (<5s).
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Short — just saving chunks

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`ingest-upload:${ip}`, RATE_LIMITS.ingest.maxRequests, RATE_LIMITS.ingest.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit.' },
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

    const tmpDir = '/tmp/ingest-upload';
    if (!existsSync(tmpDir)) {
      await fs.mkdir(tmpDir, { recursive: true });
    }

    // Append chunk to temp file
    const partPath = path.join(tmpDir, `${fileHash}.part`);
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());
    await fs.appendFile(partPath, chunkBuffer);

    // If not last chunk, return progress
    if (chunkIndex < totalChunks - 1) {
      return NextResponse.json({
        success: true,
        received: chunkIndex,
        totalChunks,
        progress: ((chunkIndex + 1) / totalChunks) * 100,
      });
    }

    // Last chunk — rename to final, return metadata for processing
    const finalPath = path.join(tmpDir, `${fileHash}${ext}`);
    await fs.rename(partPath, finalPath);

    // Verify size
    const actualSize = (await fs.stat(finalPath)).size;
    if (actualSize !== fileSize) {
      await fs.unlink(finalPath).catch(() => {});
      return NextResponse.json(
        { success: false, error: `File size mismatch: expected ${fileSize}, got ${actualSize}.` },
        { status: 400 }
      );
    }

    // Return metadata — frontend will call /api/ingest-process next
    return NextResponse.json({
      success: true,
      uploaded: true,
      fileHash,
      fileName,
      fileSize,
      filePath: finalPath,
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
