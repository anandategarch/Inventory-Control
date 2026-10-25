// ============================================================
//  transient-db-error.test.ts — RETRYABLE-1 detection helper
//  --------------------------------------------------------
//  Covers the incident signature set for "error DB transient"
//  (insiden "Gagal Memuat Analisis / Gagal memproses permintaan"
//  saat filter resto, 21 Okt 2026 — lanjutan DBDOWN-1):
//    • Prisma P2024 pool checkout timeout (verbatim production text)
//    • PG "sorry, too many clients already" + pooler client limit
//    • PG statement_timeout (raw + terbungkus Prisma)
//    • Interactive-transaction timeout
//    • Connection terminated mid-query (3 varian)
//  And the negatives that MUST NOT be flagged transient:
//  DB-down signatures (P1001/P1002/tenant-not-found — milik
//  db-unreachable.ts), missing-table, error aplikasi/validasi biasa.
//  Also pins:
//    • prefix stabil TRANSIENT_ERROR_MESSAGE (marker ErrorState)
//    • bentuk body errorResponse produksi: retryable:true +
//      errorClass client-safe + pesan ramah (bukan "Gagal
//      memproses permintaan").
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import {
  classifyTransientDbError,
  collectErrorMessages,
  TRANSIENT_ERROR_MESSAGE,
} from '@/lib/transient-db-error';
import { errorResponse } from '@/lib/error-response';

describe('classifyTransientDbError (RETRYABLE-1)', () => {
  it('mengenali P2024 pool checkout timeout — teks persis Prisma', () => {
    const err = new Error(
      'Timed out fetching a new connection from the connection pool. More info: https://pris.ly/d/pool-timeout (P2024)',
    );
    expect(classifyTransientDbError(err)).toBe('pool-timeout');
  });

  it('mengenali kode P2024 saja bila tercetak tanpa kalimat lengkap', () => {
    expect(classifyTransientDbError(new Error('PrismaClientKnownRequestError: P2024'))).toBe('pool-timeout');
  });

  it('mengenali PG "sorry, too many clients already"', () => {
    expect(classifyTransientDbError(new Error('FATAL: sorry, too many clients already (max_connections 100)'))).toBe('pool-timeout');
  });

  it('mengenali statement_timeout PG (raw dan underscore variant)', () => {
    expect(classifyTransientDbError(new Error('canceling statement due to statement timeout'))).toBe('statement-timeout');
    expect(classifyTransientDbError(new Error('canceling statement due to statement_timeout'))).toBe('statement-timeout');
  });

  it('mengenali interactive-transaction timeout', () => {
    expect(classifyTransientDbError(new Error('Timed out during query execution: transaction timed out'))).toBe('statement-timeout');
  });

  it('mengenali connection terminated mid-query (3 varian)', () => {
    expect(classifyTransientDbError(new Error('Connection terminated unexpectedly'))).toBe('connection-terminated');
    expect(classifyTransientDbError(new Error('Connection terminated due to connection timeout'))).toBe('connection-terminated');
    expect(classifyTransientDbError(new Error('Error querying the database: connection terminated'))).toBe('connection-terminated');
  });

  it('mengenali "connection closed unexpectedly"', () => {
    expect(classifyTransientDbError(new Error('the connection closed unexpectedly'))).toBe('connection-terminated');
  });

  it('menerima input string (bukan Error)', () => {
    expect(classifyTransientDbError('Timed out fetching a new connection from the connection pool')).toBe('pool-timeout');
  });

  it('TIDAK menandai signature DB-down (milik db-unreachable.ts)', () => {
    // P1001 init error — DB paused:
    expect(classifyTransientDbError(new Error("Can't reach database server at `aws-0-ap-southeast-1.pooler.supabase.com:6543`"))).toBeNull();
    // P1002:
    expect(classifyTransientDbError(new Error('Database could not be reached: connection attempt timed out.'))).toBeNull();
    // Supavisor tenant-not-found:
    expect(classifyTransientDbError(new Error('(ENOTFOUND) tenant/user postgres.proosjqivxadwgftofry not found'))).toBeNull();
  });

  it('TIDAK menandai missing-table / error aplikasi / validasi biasa', () => {
    expect(classifyTransientDbError(new Error('relation "SourceFile" does not exist'))).toBeNull();
    expect(classifyTransientDbError(new Error('Invalid month parameter'))).toBeNull();
    expect(classifyTransientDbError(new Error('No records found for 2026-07 / WEEK 1 with given filters.'))).toBeNull();
    expect(classifyTransientDbError(new Error('Gagal memproses permintaan'))).toBeNull();
  });

  it('aman terhadap nilai kosong', () => {
    expect(classifyTransientDbError(null)).toBeNull();
    expect(classifyTransientDbError(undefined)).toBeNull();
    expect(classifyTransientDbError('')).toBeNull();
    expect(classifyTransientDbError({ odd: true })).toBeNull();
  });
});

describe('TRANSIENT_ERROR_MESSAGE kontrak (RETRYABLE-1)', () => {
  it('prefix stabil — marker ErrorState (/^server database sedang sibuk/i)', () => {
    // ErrorState (src/components/dashboard/shared/index.tsx) match prefix ini
    // untuk cabang amber + judul "Server Sedang Sibuk". Mengubah prefix tanpa
    // menyamakan marker = regresi senyap (kembali ke tampilan merah generik).
    expect(TRANSIENT_ERROR_MESSAGE).toMatch(/^Server database sedang sibuk/i);
  });

  it('menjelaskan sifat transient + memberi panduan Coba Lagi', () => {
    expect(TRANSIENT_ERROR_MESSAGE).toMatch(/pulih/i);
    expect(TRANSIENT_ERROR_MESSAGE).toMatch(/Coba Lagi/i);
  });

  it('client-safe — tidak membocorkan host/sql/kredensial internal', () => {
    expect(TRANSIENT_ERROR_MESSAGE).not.toMatch(/pooler\.supabase\.com/i);
    expect(TRANSIENT_ERROR_MESSAGE).not.toMatch(/postgres\.|password|@|SELECT|P2024/i);
  });
});

describe('errorResponse transient branch (RETRYABLE-1)', () => {
  it('P2024 → 500 dengan retryable:true + errorClass client-safe + pesan ramah', async () => {
    // NODE_ENV vitest = 'test' → jalur produksi (pesan generik) aktif —
    // inilah bentuk body yang dilihat client di produksi.
    const res = errorResponse(
      new Error('Timed out fetching a new connection from the connection pool. More info: https://pris.ly/d/pool-timeout (P2024)'),
      'test-context',
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      success: boolean; retryable?: boolean; errorClass?: string; error?: string;
      dbUnreachable?: boolean; detail?: string;
    };
    expect(body.success).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.errorClass).toBe('pool-timeout');
    expect(body.error).toBe(TRANSIENT_ERROR_MESSAGE);
    // BUKAN pesan generik yang tidak bisa di-retry:
    expect(body.error).not.toBe('Gagal memproses permintaan');
    // BUKAN cabang DB-down:
    expect(body.dbUnreachable).toBeUndefined();
    // Produksi (non-dev) tidak membocorkan detail mentah:
    expect(body.detail).toBeUndefined();
  });

  it('error biasa → tetap 500 generik TANPA retryable (bukan transient)', async () => {
    const res = errorResponse(new Error('TypeError: cannot read property of undefined'), 'test-context');
    const body = (await res.json()) as {
      success: boolean; retryable?: boolean; errorClass?: string; error?: string;
    };
    expect(body.success).toBe(false);
    expect(body.retryable).toBeUndefined();
    expect(body.errorClass).toBeUndefined();
    expect(body.error).toBe('Gagal memproses permintaan');
  });

  it('DB-down P1001 tetap diprioritaskan di atas klasifikasi transient', async () => {
    // isDbUnreachable dicek LEBIH DULU di errorResponse — P1001 harus tetap
    // menghasilkan cabang dbUnreachable walau teksnya mengandung kata
    // "database".
    const res = errorResponse(
      new Error("Can't reach database server at `aws-0-ap-southeast-1.pooler.supabase.com:6543`"),
      'test-context',
    );
    const body = (await res.json()) as {
      dbUnreachable?: boolean; retryable?: boolean; error?: string;
    };
    expect(body.dbUnreachable).toBe(true);
    expect(body.retryable).toBeUndefined();
    expect(body.error).toMatch(/^Database tidak dapat dijangkau/i);
  });
});

describe('fetchAnalysis propagasi retryable (RETRYABLE-1 — chain produksi)', () => {
  it('body 500 retryable → Error.retryable=true (dibaca retry useAnalysis)', async () => {
    // Simulasi persis insiden produksi: /api/analysis mengembalikan
    // {"success":false,"retryable":true,"errorClass":"pool-timeout",
    //  "error":"Server database sedang sibuk …"} — fetchAnalysis harus
    // membungkusnya ke Error dengan flag retryable agar retry useAnalysis
    // aktif (substring matching lama tidak pernah cocok dengan teks ini).
    const { fetchAnalysis } = await import('@/hooks/useAnalysis/fetchAnalysis');
    const body = {
      success: false,
      retryable: true,
      errorClass: 'pool-timeout',
      error: TRANSIENT_ERROR_MESSAGE,
    };
    const fakeResponse = {
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse as unknown as Response)));
    try {
      await expect(fetchAnalysis(new URLSearchParams('month=Oktober 2026&week=WEEK 1'))).rejects.toThrow(
        /server database sedang sibuk/i,
      );
      // Verifikasi flag lewat try/catch (toThrow hanya cek pesan):
      let caught: unknown;
      try {
        await fetchAnalysis(new URLSearchParams('month=Oktober 2026&week=WEEK 1'));
      } catch (e) {
        caught = e;
      }
      expect((caught as { retryable?: boolean }).retryable).toBe(true);
      expect((caught as { errorClass?: string }).errorClass).toBe('pool-timeout');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('body 500 generik (bug aplikasi) → Error TANPA retryable', async () => {
    const { fetchAnalysis } = await import('@/hooks/useAnalysis/fetchAnalysis');
    const body = { success: false, error: 'Gagal memproses permintaan' };
    const fakeResponse = {
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse as unknown as Response)));
    try {
      let caught: unknown;
      try {
        await fetchAnalysis(new URLSearchParams('month=Oktober 2026&week=WEEK 1'));
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toBe('Gagal memproses permintaan');
      expect((caught as { retryable?: boolean }).retryable).toBeUndefined();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});

describe('shouldRetryAnalysis (RETRYABLE-1 — retry predicate query utama)', () => {
  it('error ber-flag retryable (produksi P2024) → RETRY — insiden 21 Okt 2026', async () => {
    // Chain produksi lengkap: body errorResponse → Error.fetchAnalysis →
    // predicate. Sebelum RETRYABLE-1, predicate hanya match substring teks
    // mentah → di produksi TIDAK PERNAH retry → kartu merah permanen.
    const { shouldRetryAnalysis } = await import('@/hooks/useAnalysis/useAnalysis');
    const { fetchAnalysis } = await import('@/hooks/useAnalysis/fetchAnalysis');
    const body = {
      success: false,
      retryable: true,
      errorClass: 'pool-timeout',
      error: TRANSIENT_ERROR_MESSAGE,
    };
    const fakeResponse = {
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fakeResponse as unknown as Response)));
    let caught: unknown;
    try {
      try {
        await fetchAnalysis(new URLSearchParams('month=Oktober 2026&week=WEEK 1'));
      } catch (e) {
        caught = e;
      }
      // Kondisi insiden: produksi, teks pesan ramah (tanpa 'connection'/'timeout'
      // bahasa Inggris) — predicate lama akan return false:
      expect(shouldRetryAnalysis(0, caught)).toBe(true);
      expect(shouldRetryAnalysis(2, caught)).toBe(true);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('maksimal 3 retry — failureCount >= 3 selalu berhenti', async () => {
    const { shouldRetryAnalysis } = await import('@/hooks/useAnalysis/useAnalysis');
    const err: Error & { retryable?: boolean } = new Error(TRANSIENT_ERROR_MESSAGE);
    err.retryable = true;
    expect(shouldRetryAnalysis(3, err)).toBe(false);
    expect(shouldRetryAnalysis(4, err)).toBe(false);
  });

  it('pesan produksi generik TANPA flag (bug aplikasi) → TIDAK retry', async () => {
    const { shouldRetryAnalysis } = await import('@/hooks/useAnalysis/useAnalysis');
    // "Gagal memproses permintaan" tanpa flag = bug nyata (TypeError dll.) —
    // retry hanya membuang 3× compute berat. Jangan retry.
    expect(shouldRetryAnalysis(0, new Error('Gagal memproses permintaan'))).toBe(false);
  });

  it('jalur legacy teks mentah (dev-mode) tetap dijaga', async () => {
    const { shouldRetryAnalysis } = await import('@/hooks/useAnalysis/useAnalysis');
    expect(shouldRetryAnalysis(0, new Error('HTTP 504'))).toBe(true);
    expect(shouldRetryAnalysis(0, new Error('Server timeout (90s). Query terlalu berat'))).toBe(true);
    expect(shouldRetryAnalysis(0, new Error('Server error (HTTP 500). Server mungkin crash'))).toBe(true);
    expect(shouldRetryAnalysis(0, new Error('Timed out fetching a new connection from the connection pool'))).toBe(true);
    expect(shouldRetryAnalysis(0, new Error('ECHECKOUTRETRIES'))).toBe(true);
  });

  it('error tanpa message (non-Error) aman', async () => {
    const { shouldRetryAnalysis } = await import('@/hooks/useAnalysis/useAnalysis');
    expect(shouldRetryAnalysis(0, null)).toBe(false);
    expect(shouldRetryAnalysis(0, undefined)).toBe(false);
    expect(shouldRetryAnalysis(0, 'odd')).toBe(false);
  });
});

// ============================================================
//  PERF-FILTER3 (22 Okt 2026): kelas lanjutan dari insiden "Gagal
//  Memuat Analisis / Gagal memproses permintaan" TIAP ganti filter —
//  fan-out 6 endpoint berat paralel menjenuhkan Supabase free tier;
//  error yang muncul (40-60 detik) TIDAK cocok pola RETRYABLE-1
//  manapun → kartu MERAH tanpa auto-retry. Pola baru yang kini
//  dikenali (lihat TRANSIENT_DB_ERROR_PATTERNS):
//    • Prisma P2028 interactive-transaction/query timeout
//    • Supavisor "connection pool exhausted"
//    • PgBouncer "no more connections in pool"
//    • PG 53300 "remaining connection slots are reserved"
//    • Network "connection reset by peer"
// ============================================================
describe('classifyTransientDbError (PERF-FILTER3 — insiden 22 Okt 2026)', () => {
  it('mengenali Prisma P2028 (interactive-transaction timeout — withStatementTimeout)', () => {
    expect(classifyTransientDbError(new Error(
      'PrismaClientKnownRequestError: A query or transaction timed out during query execution (P2028)',
    ))).toBe('statement-timeout');
    expect(classifyTransientDbError(new Error('P2028'))).toBe('statement-timeout');
  });

  it('mengenali "Timed out during query execution" tanpa kode P', () => {
    expect(classifyTransientDbError(new Error('Timed out during query execution'))).toBe('statement-timeout');
    expect(classifyTransientDbError(new Error('query execution timed out after 30000ms'))).toBe('statement-timeout');
  });

  it('mengenali Supavisor/Supabase pooler "connection pool exhausted"', () => {
    expect(classifyTransientDbError(new Error(
      'db error: timeout: connection pool exhausted (Supavisor)',
    ))).toBe('pool-timeout');
  });

  it('mengenali PgBouncer "no more connections in pool"', () => {
    expect(classifyTransientDbError(new Error('ERROR: no more connections in pool'))).toBe('pool-timeout');
  });

  it('mengenali PG 53300 "remaining connection slots are reserved"', () => {
    expect(classifyTransientDbError(new Error(
      'remaining connection slots are reserved for non-replication superuser connections',
    ))).toBe('pool-timeout');
  });

  it('mengenali network "connection reset by peer" (TLS serverless→DB blip)', () => {
    expect(classifyTransientDbError(new Error('read ECONNRESET: connection reset by peer'))).toBe('connection-terminated');
  });

  it('errorResponse: P2028 produksi → retryable:true + errorClass (bukan kartu merah generik)', async () => {
    const res = errorResponse(new Error(
      'PrismaClientKnownRequestError: A query or transaction timed out during query execution (P2028)',
    ), 'analysis');
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(body.retryable).toBe(true);
    expect(body.errorClass).toBe('statement-timeout');
    expect(body.error).toBe(TRANSIENT_ERROR_MESSAGE);
  });

  it('errorResponse: pool exhausted produksi → retryable:true (kartu amber + auto-retry)', async () => {
    const res = errorResponse(new Error('connection pool exhausted'), 'waste-series');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryable).toBe(true);
    expect(body.errorClass).toBe('pool-timeout');
    expect(String(body.error)).toMatch(/^Server database sedang sibuk/);
  });
});

// ============================================================
//  PERF-FILTER4 (25 Okt 2026): insiden "Gagal Memuat Analisis"
//  September WEEK 4 — laporan user ke-3. Reproduksi live: fan-out
//  6 endpoint paralel → analysis/waste-top-items/waste-rate-league
//  500 @54-58s; ketiganya SUKSES solo. Root cause dua lapis:
//    (a) kontensi pooler (→ critical-path-gate, Layer 2), dan
//    (b) error yang muncul TIDAK cocok regex message manapun —
//        klasifikasi lama buta terhadap error.code + cause-chain.
//  Blok ini menguji lapisan (b): klasifikasi by Prisma P-code,
//  Node errno, cause-chain, dan prioritas db-unreachable atas
//  SEMUA teks error.
// ============================================================
describe('classifyTransientDbError — by ERROR CODE (PERF-FILTER4)', () => {
  // Bentuk produksi PrismaClientKnownRequestError: {code, message,
  // meta} — message-nya bisa generik dan TIDAK memuat signature.
  const prismaError = (code: string, message: string) =>
    Object.assign(new Error(message), { code, meta: {} });

  it('P2024 via .code (message generik) → pool-timeout', () => {
    expect(classifyTransientDbError(prismaError('P2024', 'Error querying the database'))).toBe('pool-timeout');
  });

  it('P2028 via .code (message generik) → statement-timeout', () => {
    expect(classifyTransientDbError(prismaError('P2028', 'Error occurred during query execution'))).toBe('statement-timeout');
  });

  it('P2034 via .code (transaction failed — koneksi putus di tengah transaksi) → connection-terminated', () => {
    // Insiden Sep-W4: pooler kick koneksi saat jenuh → interactive
    // transaction gagal. P2034 TIDAK ada di daftar pola lama sama sekali.
    expect(
      classifyTransientDbError(prismaError('P2034', 'Transaction failed due to a write conflict or a connection failure')),
    ).toBe('connection-terminated');
  });

  it('P2034 teks saja tanpa .code → connection-terminated', () => {
    expect(classifyTransientDbError(new Error('Transaction failed due to a connection failure'))).toBe('connection-terminated');
    expect(classifyTransientDbError(new Error('Transaction failed due to a write conflict'))).toBe('connection-terminated');
  });

  it('Node errno via .code (ECONNRESET/ETIMEDOUT/EPIPE) → connection-terminated', () => {
    expect(classifyTransientDbError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe('connection-terminated');
    expect(classifyTransientDbError(Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:5432'), { code: 'ETIMEDOUT' }))).toBe('connection-terminated');
    expect(classifyTransientDbError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe('connection-terminated');
  });

  it('kode Node LAIN (ERR_*) TIDAK ikut transient — allowlist exact-match', () => {
    expect(classifyTransientDbError(Object.assign(new Error('The "fetch" failed'), { code: 'ERR_INVALID_ARG_TYPE' }))).toBeNull();
    expect(classifyTransientDbError(Object.assign(new Error('boom'), { code: 'EACCES' }))).toBeNull();
    expect(classifyTransientDbError(Object.assign(new Error('boom'), { code: 'UNKNOWN_PRISMA_CODE' }))).toBeNull();
  });

  it('teks errno NAKED di message (tanpa .code) → connection-terminated', () => {
    expect(classifyTransientDbError(new Error('read ECONNRESET'))).toBe('connection-terminated');
    expect(classifyTransientDbError(new Error('connect ETIMEDOUT 127.0.0.1:6543'))).toBe('connection-terminated');
    expect(classifyTransientDbError(new Error('getaddrinfo EAI_AGAIN db.example.com'))).toBe('connection-terminated');
    expect(classifyTransientDbError(new Error('socket connection timeout'))).toBe('connection-terminated');
  });
});

describe('classifyTransientDbError — cause-chain (PERF-FILTER4)', () => {
  it('signature transient tersembunyi di error.cause → terklasifikasi', () => {
    const err = new Error('Error occurred during query execution', {
      cause: new Error('read ECONNRESET'),
    });
    expect(classifyTransientDbError(err)).toBe('connection-terminated');
  });

  it('rantai cause 2 level → signature di level terdalam terbaca', () => {
    const err = new Error('Request failed', {
      cause: new Error('fetch failed', { cause: new Error('Connection terminated unexpectedly') }),
    });
    expect(classifyTransientDbError(err)).toBe('connection-terminated');
  });

  it('Prisma meta.cause berisi signature → terklasifikasi', () => {
    const err = Object.assign(new Error('Error querying the database'), {
      meta: { cause: 'Timed out fetching a new connection from the connection pool' },
    });
    expect(classifyTransientDbError(err)).toBe('pool-timeout');
  });

  it('semua teks bersih → tetap null (tidak over-classify)', () => {
    const err = new Error('Wrapper', { cause: new Error('inner biasa tanpa signature') });
    expect(classifyTransientDbError(err)).toBeNull();
  });

  it('cause-chain SIKLIS tidak menggantung (depth cap)', () => {
    const a: { message: string; cause?: unknown } = { message: 'a' };
    const b: { message: string; cause?: unknown } = { message: 'b', cause: a };
    a.cause = b;
    expect(classifyTransientDbError(a as unknown as Error)).toBeNull();
  });
});

describe('errorResponse — PERF-FILTER4 integrasi', () => {
  it('P2034 via .code (message generik) → 500 retryable:true + errorClass + pesan amber', async () => {
    // Bentuk insiden Sep-W4 yang lolos klasifikasi lama: error Prisma
    // dengan code P2034 tapi message generik — dulunya jatuh ke 500
    // "Gagal memproses permintaan" tanpa retryable → kartu MERAH.
    const err = Object.assign(new Error('Error occurred during query execution'), { code: 'P2034' });
    const res = errorResponse(err, 'analysis');
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(body.retryable).toBe(true);
    expect(body.errorClass).toBe('connection-terminated');
    expect(body.error).toBe(TRANSIENT_ERROR_MESSAGE);
    expect(body.error).not.toBe('Gagal memproses permintaan');
  });

  it('ECONNRESET via cause-chain → retryable:true (kartu amber + auto-retry)', async () => {
    const err = new Error('Error querying the database', { cause: new Error('read ECONNRESET') });
    const res = errorResponse(err, 'waste-top-items');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryable).toBe(true);
    expect(body.errorClass).toBe('connection-terminated');
  });

  it('P1001 tersembunyi di cause-chain TETAP menang → cabang dbUnreachable (bukan transient)', async () => {
    // Prioritas db-down dijaga atas SEMUA teks (message + cause):
    // P1001 di cause dulunya lolos → salah klaim transient.
    const err = new Error('Request failed', {
      cause: new Error("Can't reach database server at `aws-0-ap-southeast-1.pooler.supabase.com:6543`"),
    });
    const res = errorResponse(err, 'analysis');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dbUnreachable).toBe(true);
    expect(body.retryable).toBeUndefined();
    expect(String(body.error)).toMatch(/^Database tidak dapat dijangkau/i);
  });

  it('error aplikasi murni TETAP 500 generik tanpa retryable (tidak over-classify)', async () => {
    const err = Object.assign(new Error('TypeError: cannot read property of undefined'), { code: 'ERR_JS' });
    const res = errorResponse(err, 'analysis');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryable).toBeUndefined();
    expect(body.error).toBe('Gagal memproses permintaan');
  });
});

describe('collectErrorMessages (PERF-FILTER4 helper)', () => {
  it('mengumpulkan message + cause berjenjang', () => {
    const msgs = collectErrorMessages(
      new Error('outer', { cause: new Error('inner', { cause: new Error('deepest') }) }),
    );
    expect(msgs).toEqual(['outer', 'inner', 'deepest']);
  });

  it('menerima input string', () => {
    expect(collectErrorMessages('plain string')).toEqual(['plain string']);
  });

  it('input kosong → array kosong', () => {
    expect(collectErrorMessages(null)).toEqual([]);
    expect(collectErrorMessages(undefined)).toEqual([]);
    expect(collectErrorMessages({ odd: true })).toEqual([]);
  });
});
