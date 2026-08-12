// ============================================================
//  /api/import-drive — Import Excel/CSV from Google Drive URL
//  With SSE streaming for real-time progress updates.
// ============================================================
import { NextRequest } from 'next/server';
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
  const encoder = new TextEncoder();

  // Set up SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Rate limiting
        const ip = getClientIP(req);
        const rl = rateLimit(`import-drive:${ip}`, RATE_LIMITS.importDrive.maxRequests, RATE_LIMITS.importDrive.windowMs);
        if (!rl.allowed) {
          send({ success: false, error: 'Rate limit exceeded. Tunggu beberapa menit.' });
          controller.close();
          return;
        }

        const body = await req.json().catch(() => ({}));
        const { data: validatedBody, error: validationError } = safeParse(importDriveBodySchema, body);
        if (validationError || !validatedBody) {
          send({ success: false, error: `Invalid input: ${validationError}` });
          controller.close();
          return;
        }
        const url = validatedBody.url;

        // SSRF protection
        const ALLOWED_DOMAINS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
        } catch {
          send({ success: false, error: 'URL tidak valid' });
          controller.close();
          return;
        }
        const isAllowed = ALLOWED_DOMAINS.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d));
        if (!isAllowed) {
          send({ success: false, error: `URL harus dari Google Drive. Domain "${parsedUrl.hostname}" tidak diizinkan.` });
          controller.close();
          return;
        }

        // Step 1: Download
        send({ phase: 'download', status: 'processing', message: '⏳ Downloading from Google Drive...' });

        let importResult;
        try {
          importResult = await importFromDriveUrl(url, DATA_DIR);
        } catch (downloadErr: any) {
          send({ success: false, error: `Gagal download: ${downloadErr?.message || String(downloadErr)}` });
          controller.close();
          return;
        }

        const successful = importResult.downloadedFiles.filter((f) => f.success);
        const failed = importResult.downloadedFiles.filter((f) => !f.success);

        if (successful.length === 0) {
          const failedDetails = failed.map(f => `${f.fileName}: ${f.error || 'unknown'}`).join('; ');
          send({ success: false, error: `No files downloaded. Pastikan link share = "Anyone with link can view". Detail: ${failedDetails}` });
          controller.close();
          return;
        }

        send({
          phase: 'download',
          status: 'done',
          message: `✅ Downloaded ${successful.length} file(s)`,
          files: successful.map(f => f.fileName),
        });

        // Step 2: Ingest each file
        const ingestResults: any[] = [];
        for (let i = 0; i < successful.length; i++) {
          const file = successful[i];
          const fileName = path.basename(file.localPath);

          send({
            phase: 'ingest',
            status: 'processing',
            fileIndex: i + 1,
            totalFiles: successful.length,
            fileName,
            message: `⏳ [${i + 1}/${successful.length}] Processing ${fileName}...`,
          });

          try {
            const results = await processIngestion({ filePath: file.localPath });
            const result = results[0] || {
              fileName, status: 'ERROR', rowCount: 0, dqStatus: 'ERROR',
              dqErrors: 1, dqWarnings: 0, error: 'No result returned',
            };

            ingestResults.push(result);

            send({
              phase: 'ingest',
              status: 'done',
              fileIndex: i + 1,
              totalFiles: successful.length,
              fileName,
              result,
              message: result.status === 'INGESTED'
                ? `✅ [${i + 1}/${successful.length}] ${fileName}: ${result.rowCount.toLocaleString()} rows imported`
                : result.status === 'SKIPPED'
                ? `⏭️ [${i + 1}/${successful.length}] ${fileName}: skipped (already exists)`
                : `❌ [${i + 1}/${successful.length}] ${fileName}: ${result.error || 'error'}`,
            });
          } catch (e: any) {
            const result = {
              fileName, status: 'ERROR', rowCount: 0, dqStatus: 'ERROR',
              dqErrors: 1, dqWarnings: 0, error: e?.message || String(e),
            };
            ingestResults.push(result);
            send({
              phase: 'ingest',
              status: 'error',
              fileIndex: i + 1,
              totalFiles: successful.length,
              fileName,
              result,
              message: `❌ [${i + 1}/${successful.length}] ${fileName}: ${e?.message || 'error'}`,
            });
          }
        }

        // Final result
        send({
          success: true,
          phase: 'complete',
          downloadSummary: {
            total: importResult.downloadedFiles.length,
            success: successful.length,
            failed: failed.length,
            failedDetails: failed,
          },
          ingestResults,
          durationMs: Date.now() - startedAt,
          message: `✅ Import complete: ${ingestResults.filter(r => r.status === 'INGESTED').length} file(s) ingested in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        });
      } catch (e: any) {
        send({ success: false, error: e?.message || String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
