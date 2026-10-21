// ============================================================
//  db-unreachable.test.ts — DBDOWN-1 detection helper
//  --------------------------------------------------------
//  Covers the incident signature set for "database tidak bisa
//  dijangkau" (project Supabase paused, 21 Okt 2026):
//    • Prisma P1001-class text (verbatim from production probe)
//    • Supavisor pooler raw tenant-not-found
//    • P1002-class "database could not be reached"
//  And the negatives that MUST NOT be flagged (they have their
//  own handling): pool-exhaustion P2024 (transient load),
//  missing-table (EMPTY_STATE branch /api/status), plain
//  app/validation errors, external-service network errors.
//  Also pins the stable prefix of DB_UNREACHABLE_MESSAGE —
//  ErrorState (shared/index.tsx) matches on it for the amber
//  restore-guidance branch.
// ============================================================
import { describe, it, expect } from 'vitest';
import { isDbUnreachable, DB_UNREACHABLE_MESSAGE } from '@/lib/db-unreachable';

describe('isDbUnreachable (DBDOWN-1)', () => {
  it('mengenali teks P1001 Prisma persis dari probe produksi 21 Okt 2026', () => {
    const err = new Error(
      "Invalid `prisma.$queryRaw()` invocation:\n\nCan't reach database server at `aws-0-ap-southeast-1.pooler.supabase.com:6543`\n\nPlease make sure your database server is running at `aws-0-ap-southeast-1.pooler.supabase.com:6543`.",
    );
    expect(isDbUnreachable(err)).toBe(true);
  });

  it('mengenali FATAL Supavisor pooler tenant-not-found (raw, tanpa pembungkus Prisma)', () => {
    const err = new Error('(ENOTFOUND) tenant/user postgres.proosjqivxadwgftofry not found');
    expect(isDbUnreachable(err)).toBe(true);
  });

  it('mengenali P1002-class "database could not be reached"', () => {
    const err = new Error('Database could not be reached: connection attempt timed out.');
    expect(isDbUnreachable(err)).toBe(true);
  });

  it('mengenali kode P1001 bila tercetak di message', () => {
    expect(isDbUnreachable(new Error('PrismaClientInitializationError P1001: db init gagal'))).toBe(true);
  });

  it('menerima input string (bukan Error)', () => {
    expect(isDbUnreachable("Can't reach database server at `db.example.com:5432`")).toBe(true);
    expect(isDbUnreachable('tenant/user postgres.abc not found')).toBe(true);
  });

  it('TIDAK menandai pool exhaustion P2024 (transient — DB tetap hidup)', () => {
    const err = new Error(
      'Timed out fetching a new connection from the connection pool. More info: https://pris.ly/d/pool-timeout (P2024)',
    );
    expect(isDbUnreachable(err)).toBe(false);
  });

  it('TIDAK menandai missing-table (punya branch EMPTY_STATE sendiri di /api/status)', () => {
    expect(isDbUnreachable(new Error('relation "SourceFile" does not exist'))).toBe(false);
    expect(isDbUnreachable(new Error('table "public.Item" does not exist'))).toBe(false);
  });

  it('TIDAK menandai error aplikasi/validasi biasa', () => {
    expect(isDbUnreachable(new Error('Invalid month parameter'))).toBe(false);
    expect(isDbUnreachable(new Error('No records found for 2026-07 / WEEK 1 with given filters.'))).toBe(false);
    expect(isDbUnreachable(new Error('Gagal memproses permintaan'))).toBe(false);
  });

  it('TIDAK menandai kegagalan jaringan layanan eksternal (mis. Google Drive) — bukan DB', () => {
    // ECONNREFUSED/ETIMEDOUT telanjang sengaja tidak match agar fetch
    // layanan luar tidak salah didiagnosis "DB down" → salah arahkan user
    // ke dashboard Supabase.
    expect(isDbUnreachable(new Error('fetch failed: connect ECONNREFUSED 142.250.4.106:443'))).toBe(false);
    expect(isDbUnreachable(new Error('connect ETIMEDOUT 34.102.178.5:443'))).toBe(false);
  });

  it('aman terhadap nilai kosong', () => {
    expect(isDbUnreachable(null)).toBe(false);
    expect(isDbUnreachable(undefined)).toBe(false);
    expect(isDbUnreachable('')).toBe(false);
    expect(isDbUnreachable({ odd: true })).toBe(false);
  });
});

describe('DB_UNREACHABLE_MESSAGE kontrak (DBDOWN-1)', () => {
  it('prefix stabil — marker ErrorState (/^database tidak dapat dijangkau/i)', () => {
    // ErrorState (src/components/dashboard/shared/index.tsx) match prefix ini
    // untuk cabang amber + tombol restore Supabase. Mengubah prefix tanpa
    // menyamakan marker = regresi senyap (kembali ke tampilan merah generik).
    expect(DB_UNREACHABLE_MESSAGE).toMatch(/^Database tidak dapat dijangkau/i);
  });

  it('memuat panduan aksi: dashboard Supabase + Restore + Coba Lagi', () => {
    expect(DB_UNREACHABLE_MESSAGE).toMatch(/supabase\.com\/dashboard/i);
    expect(DB_UNREACHABLE_MESSAGE).toMatch(/Restore project/i);
    expect(DB_UNREACHABLE_MESSAGE).toMatch(/Coba Lagi/i);
  });

  it('client-safe — tidak membocorkan host/kredensial internal', () => {
    expect(DB_UNREACHABLE_MESSAGE).not.toMatch(/pooler\.supabase\.com/i);
    expect(DB_UNREACHABLE_MESSAGE).not.toMatch(/postgres\.|password|@/i);
  });
});
