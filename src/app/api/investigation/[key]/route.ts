import { NextRequest } from 'next/server';
import { client } from '@/lib/db';
import { apiError, apiSuccess } from '@/lib/api-response';
import type { InvestigationRecord } from '../route';

export const dynamic = 'force-dynamic';

function mapRow(r: Record<string, unknown>): InvestigationRecord {
  return {
    id: Number(r.id),
    worklistKey: String(r.worklistKey),
    outletCode: String(r.outletCode),
    itemName: String(r.itemName),
    monthLabel: String(r.monthLabel),
    weekLabel: String(r.weekLabel),
    status: String(r.status) as InvestigationRecord['status'],
    priority: String(r.priority) as InvestigationRecord['priority'],
    notes: r.notes == null ? null : String(r.notes),
    assignedTo: r.assignedTo == null ? null : String(r.assignedTo),
    resolvedAt: r.resolvedAt == null ? null : String(r.resolvedAt),
    createdAt: String(r.createdAt),
    updatedAt: String(r.updatedAt),
  };
}

// GET /api/investigation/[key] — key is URL-encoded worklistKey
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const worklistKey = decodeURIComponent(key);
    const res = await client.execute({
      sql: 'SELECT * FROM Investigation WHERE worklistKey = ?',
      args: [worklistKey],
    });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return apiSuccess(null);
    }
    return apiSuccess(mapRow(row));
  } catch (e: unknown) {
    console.error('[investigation/[key]] GET error:', e);
    return apiError(e instanceof Error ? e.message : String(e), 500, 'DATABASE_ERROR');
  }
}

// PATCH /api/investigation/[key]
// Body: { status?, notes?, assignedTo?, priority? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await params;
    const worklistKey = decodeURIComponent(key);
    const body = await req.json().catch(() => ({}));

    // Verify exists
    const existing = await client.execute({
      sql: 'SELECT * FROM Investigation WHERE worklistKey = ?',
      args: [worklistKey],
    });
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (!existingRow) {
      return apiError('Investigation not found', 404, 'NOT_FOUND');
    }

    const mergedStatus = body.status && ['OPEN', 'INVESTIGATING', 'RESOLVED'].includes(body.status)
      ? body.status : String(existingRow.status);
    const mergedPriority = body.priority && ['P1', 'P2', 'P3'].includes(body.priority)
      ? body.priority : String(existingRow.priority);
    const mergedNotes = body.notes != null ? String(body.notes) : (existingRow.notes == null ? null : String(existingRow.notes));
    const mergedAssignedTo = body.assignedTo != null ? String(body.assignedTo) : (existingRow.assignedTo == null ? null : String(existingRow.assignedTo));

    // Set resolvedAt when transitioning to RESOLVED; clear it when leaving RESOLVED
    const wasResolved = existingRow.status === 'RESOLVED';
    const isResolved = mergedStatus === 'RESOLVED';
    const resolvedAtExpr = (!wasResolved && isResolved)
      ? 'CURRENT_TIMESTAMP'
      : (wasResolved && !isResolved ? 'NULL' : 'resolvedAt');

    await client.execute({
      sql: `UPDATE Investigation
            SET status = ?, priority = ?, notes = ?, assignedTo = ?, resolvedAt = ${resolvedAtExpr}, updatedAt = CURRENT_TIMESTAMP
            WHERE worklistKey = ?`,
      args: [mergedStatus, mergedPriority, mergedNotes, mergedAssignedTo, worklistKey],
    });

    const updated = await client.execute({
      sql: 'SELECT * FROM Investigation WHERE worklistKey = ?',
      args: [worklistKey],
    });
    const row = updated.rows[0] as Record<string, unknown>;
    return apiSuccess(mapRow(row));
  } catch (e: unknown) {
    console.error('[investigation/[key]] PATCH error:', e);
    return apiError(e instanceof Error ? e.message : String(e), 500, 'DATABASE_ERROR');
  }
}
