// ============================================================
//  /api/import-drive — Import Excel/CSV from Google Drive URL
//  Non-streaming (reliable JSON response)
//  Optimized: direct Excel parse + cached lookups + batch 5000
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { importFromDriveUrl } from '@/lib/drive-import';
import { processIngestion } from '@/lib/ingestion';
import { safeParse, importDriveBodySchema } from '@/lib/validation';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : process.env.VERCEL
    ? '/tmp/inventory'
    : path.resolve(process.cwd(), 'data/inventory');

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const ip = getClientIP(req);
    const rl = rateLimit(`import-drive:${ip}`, RATE_LIMITS.importDrive.maxRequests, RATE_LIMITS.importDrive.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Tunggu beberapa menit.' },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { data: validatedBody, error: validationError } = safeParse(importDriveBodySchema, body);
    if (validationError || !validatedBody) {
      return NextResponse.json({ success: false, error: `Invalid input: ${validationError}` }, { status: 400 });
    }
    const url = validatedBody.url;

    // SSRF protection
    const ALLOWED_DOMAINS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ success: false, error: 'URL tidak valid' }, { status: 400 });
    }
    const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
    if (!isAllowed) {
      return NextResponse.json({
        success: false,
        error: `URL harus dari Google Drive. Domain "${parsedUrl.hostname}" tidak diizinkan.`,
      }, { status: 403 });
    }

    // Step 1: Download
    let importResult;
    try {
      importResult = await importFromDriveUrl(url, DATA_DIR);
    } catch (downloadErr: any) {
      return NextResponse.json({
        success: false,
        error: `Gagal download dari Google Drive: ${downloadErr?.message || String(downloadErr)}`,
      }, { status: 500 });
    }

    const successful = importResult.downloadedFiles.filter((f) => f.success);
    const failed = importResult.downloadedFiles.filter((f) => !f.success);

    if (successful.length === 0) {
      const failedDetails = failed.map(f => `${f.fileName}: ${f.error || 'unknown'}`).join('; ');
      return NextResponse.json({
        success: false,
        error: `No files downloaded. Pastikan link share = "Anyone with link can view". Detail: ${failedDetails}`,
        downloadResults: importResult.downloadedFiles,
      }, { status: 400 });
    }

    // Step 2: Ingest each file (optimized)
    const ingestResults: any[] = [];
    for (const file of successful) {
      const result = await processIngestion({ filePath: file.localPath });
      ingestResults.push(result[0] || {
        fileName: path.basename(file.localPath), status: 'ERROR', rowCount: 0,
        dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'No result',
      });
    }

    return NextResponse.json({
      success: true,
      downloadSummary: {
        total: importResult.downloadedFiles.length,
        success: successful.length,
        failed: failed.length,
        failedDetails: failed,
      },
      ingestResults,
      durationMs: Date.now() - startedAt,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
