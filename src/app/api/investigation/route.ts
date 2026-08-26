import { NextRequest, NextResponse } from 'next/server';
import { client } from '@/lib/db';
import { apiError, apiSuccess } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

// ============================================================
//  INVESTIGATION API — CRUD for the Investigation workflow
//  Investigation table tracks per-anomaly investigation state
//  (status, notes, assignee, resolvedAt) keyed by worklistKey
//  = "outletCode|itemName|monthLabel|weekLabel".
// ============================================================

export interface InvestigationRecord {
  id: number;
  worklistKey: string;
  outletCode: string;
  itemName: string;
  monthLabel: string;
  weekLabel: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED';
  priority: 'P1' | 'P2' | 'P3';
  notes: string | null;
  assignedTo: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

// GET /api/investigation[?status=OPEN]
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const outletCode = url.searchParams.get('outletCode');
    const monthLabel = url.searchParams.get('monthLabel');
    const weekLabel = url.searchParams.get('weekLabel');

    const conditions: string[] = [];
    const args: unknown[] = [];
    if (status) {
      conditions.push('status = ?');
      args.push(status);
    }
    if (outletCode) {
      conditions.push('outletCode = ?');
      args.push(outletCode);
    }
    if (monthLabel) {
      conditions.push('monthLabel = ?');
      args.push(monthLabel);
    }
    if (weekLabel) {
      conditions.push('weekLabel = ?');
      args.push(weekLabel);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const res = await client.execute({
      sql: `SELECT * FROM Investigation ${where} ORDER BY updatedAt DESC`,
      args: args as never[],
    });
    const records = (res.rows as Array<Record<string, unknown>>).map(mapRow);
    return NextResponse.json({ success: true, data: records });
  } catch (e: unknown) {
    console.error('[investigation] GET error:', e);
    return apiError(e instanceof Error ? e.message : String(e), 500, 'DATABASE_ERROR');
  }
}

// POST /api/investigation  (upsert by worklistKey)
// Body: {
//   worklistKey: string,
//   outletCode: string,
//   itemName: string,
//   monthLabel: string,
//   weekLabel: string,
//   status?: 'OPEN' | 'INVESTIGATING' | 'RESOLVED',
//   priority?: 'P1' | 'P2' | 'P3',
//   notes?: string,
//   assignedTo?: string,
// }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const worklistKey = String(body.worklistKey || '').trim();
    if (!worklistKey) {
      return apiError('worklistKey is required', 400, 'BAD_REQUEST');
    }
    const outletCode = String(body.outletCode || '').trim();
    const itemName = String(body.itemName || '').trim();
    const monthLabel = String(body.monthLabel || '').trim();
    const weekLabel = String(body.weekLabel || '').trim();
    if (!outletCode || !itemName || !monthLabel || !weekLabel) {
      return apiError('outletCode, itemName, monthLabel, weekLabel are required', 400, 'BAD_REQUEST');
    }

    const status = body.status && ['OPEN', 'INVESTIGATING', 'RESOLVED'].includes(body.status)
      ? body.status : 'OPEN';
    const priority = body.priority && ['P1', 'P2', 'P3'].includes(body.priority)
      ? body.priority : 'P3';
    const notes = body.notes != null ? String(body.notes) : null;
    const assignedTo = body.assignedTo != null ? String(body.assignedTo) : null;

    // Upsert by worklistKey (composite unique key).
    // If row exists, update status/notes/assignedTo/priority and bump updatedAt.
    // If row doesn't exist, insert.
    const existing = await client.execute({
      sql: 'SELECT id, status, notes, assignedTo, priority FROM Investigation WHERE worklistKey = ?',
      args: [worklistKey],
    });
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;

    if (existingRow) {
      // Merge — only overwrite fields that were explicitly provided
      const mergedStatus = body.status ? status : String(existingRow.status);
      const mergedPriority = body.priority ? priority : String(existingRow.priority);
      const mergedNotes = body.notes != null ? notes : (existingRow.notes == null ? null : String(existingRow.notes));
      const mergedAssignedTo = body.assignedTo != null ? assignedTo : (existingRow.assignedTo == null ? null : String(existingRow.assignedTo));

      const resolvedAt = mergedStatus === 'RESOLVED'
        ? (existingRow.status === 'RESOLVED' ? '(SELECT resolvedAt FROM Investigation WHERE id = ?)' : 'CURRENT_TIMESTAMP')
        : 'NULL';

      if (mergedStatus === 'RESOLVED' && existingRow.status !== 'RESOLVED') {
        await client.execute({
          sql: `UPDATE Investigation
                SET status = ?, priority = ?, notes = ?, assignedTo = ?, resolvedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
                WHERE worklistKey = ?`,
          args: [mergedStatus, mergedPriority, mergedNotes, mergedAssignedTo, worklistKey],
        });
      } else {
        await client.execute({
          sql: `UPDATE Investigation
                SET status = ?, priority = ?, notes = ?, assignedTo = ?, resolvedAt = ${resolvedAt}, updatedAt = CURRENT_TIMESTAMP
                WHERE worklistKey = ?`,
          args: [mergedStatus, mergedPriority, mergedNotes, mergedAssignedTo, worklistKey],
        });
      }
      // Re-fetch
      const updated = await client.execute({
        sql: 'SELECT * FROM Investigation WHERE worklistKey = ?',
        args: [worklistKey],
      });
      const rec = (updated.rows[0] as Record<string, unknown>);
      return NextResponse.json({ success: true, data: mapRow(rec), action: 'updated' });
    }

    // Insert new
    const resolvedAt = status === 'RESOLVED' ? 'CURRENT_TIMESTAMP' : 'NULL';
    await client.execute({
      sql: `INSERT INTO Investigation
            (worklistKey, outletCode, itemName, monthLabel, weekLabel, status, priority, notes, assignedTo, resolvedAt, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${resolvedAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: [worklistKey, outletCode, itemName, monthLabel, weekLabel, status, priority, notes, assignedTo],
    });
    const inserted = await client.execute({
      sql: 'SELECT * FROM Investigation WHERE worklistKey = ?',
      args: [worklistKey],
    });
    const rec = (inserted.rows[0] as Record<string, unknown>);
    return NextResponse.json({ success: true, data: mapRow(rec), action: 'created' });
  } catch (e: unknown) {
    console.error('[investigation] POST error:', e);
    return apiError(e instanceof Error ? e.message : String(e), 500, 'DATABASE_ERROR');
  }
}

// DELETE /api/investigation?worklistKey=KEY  |  ?id=ID
export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const worklistKey = url.searchParams.get('worklistKey');
    const id = url.searchParams.get('id');
    if (!worklistKey && !id) {
      return apiError('worklistKey or id is required', 400, 'BAD_REQUEST');
    }
    if (id) {
      await client.execute({ sql: 'DELETE FROM Investigation WHERE id = ?', args: [Number(id)] });
    } else {
      await client.execute({ sql: 'DELETE FROM Investigation WHERE worklistKey = ?', args: [worklistKey] });
    }
    return apiSuccess({ deleted: 1 });
  } catch (e: unknown) {
    console.error('[investigation] DELETE error:', e);
    return apiError(e instanceof Error ? e.message : String(e), 500, 'DATABASE_ERROR');
  }
}
