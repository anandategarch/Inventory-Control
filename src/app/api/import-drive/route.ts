// ============================================================
//  /api/import-drive — Import Excel/CSV from Google Drive URL
//  ----------------------------------------------------------
//  Pipeline:
//    1. Download file(s) from Google Drive (folder/file/sheets)
//    2. For each downloaded file → use SAME ingestion logic as /api/ingest
//       (Excel → CSV conversion → streaming parse → batch insert)
//
//  This route delegates to /api/ingest's logic to avoid duplication.
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { importFromDriveUrl } from '@/lib/drive-import';
import { processIngestion } from '@/lib/ingestion';
import { safeParse, importDriveBodySchema } from '@/lib/validation';
import { rateLimit, getClientIP, RATE_LIMITS } from '@/lib/rate-limit';
import path from 'path';

export const dynamic = 'force-dynamic';

// Vercel: /tmp is the only writable directory in serverless
// Local: use data/inventory folder
const DATA_DIR = process.env.INVENTORY_DATA_DIR
  ? path.resolve(process.env.INVENTORY_DATA_DIR)
  : process.env.VERCEL
    ? '/tmp/inventory'
    : path.resolve(process.cwd(), 'data/inventory');

// ============================================================
//  Ingest a single file — delegates to shared processIngestion (Bug #6 fix)
// ============================================================
async function ingestFile(filePath: string): Promise<{
  fileName: string;
  status: 'INGESTED' | 'SKIPPED' | 'ERROR';
  rowCount: number;
  dqStatus: string;
  dqErrors: number;
  dqWarnings: number;
  error?: string;
}> {
  // Bug #6 fix: delegate to shared processIngestion instead of duplicating ~200 lines
  const results = await processIngestion({ filePath });
  return results[0] || { fileName: path.basename(filePath), status: 'ERROR', rowCount: 0, dqStatus: 'ERROR', dqErrors: 1, dqWarnings: 0, error: 'No result returned' };
}


export const maxDuration = 300; // 5 minutes for Railway

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // Bug #10 fix: Rate limiting (import-drive = very heavy)
    const ip = getClientIP(req);
    const rl = rateLimit(`import-drive:${ip}`, RATE_LIMITS.importDrive.maxRequests, RATE_LIMITS.importDrive.windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Import dari Drive adalah operasi berat, tunggu beberapa menit.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    const body = await req.json().catch(() => ({}));

    // Bug #3 fix: Zod validation
    const { data: validatedBody, error: validationError } = safeParse(importDriveBodySchema, body);
    if (validationError || !validatedBody) {
      return NextResponse.json({ success: false, error: `Invalid input: ${validationError}` }, { status: 400 });
    }
    const url = validatedBody.url;

    // Bug 2 fix: SSRF protection — only allow Google Drive / Google Sheets URLs
    const ALLOWED_DOMAINS = [
      'drive.google.com',
      'docs.google.com',
      'drive.usercontent.google.com',
    ];
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ success: false, error: 'URL tidak valid' }, { status: 400 });
    }
    const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
    if (!isAllowed) {
      console.error('[import-drive] SSRF blocked:', parsedUrl.hostname);
      return NextResponse.json({
        success: false,
        error: `URL harus dari Google Drive atau Google Sheets. Domain "${parsedUrl.hostname}" tidak diizinkan.`,
      }, { status: 403 });
    }

    // Step 1: Download files from Google Drive
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
      // Build detailed error message
      const failedDetails = failed.map(f => `${f.fileName}: ${f.error || 'unknown error'}`).join('; ');
      return NextResponse.json({
        success: false,
        error: `No files could be downloaded. Pastikan link share diset "Anyone with link can view". Detail: ${failedDetails}`,
        downloadResults: importResult.downloadedFiles,
      }, { status: 400 });
    }

    // Step 2: Ingest each file using streaming CSV pipeline
    const ingestResults: Array<{ fileName: string; status: string; rowCount: number; dqStatus: string; dqErrors: number; dqWarnings: number; error?: string }> = [];
    for (const file of successful) {
      const result = await ingestFile(file.localPath);
      ingestResults.push(result);
    }

    return NextResponse.json({
      success: true,
      folderId: importResult.folderId,
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
