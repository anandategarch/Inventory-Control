// Tests for kelompok-resolver — extractKelompokFromCode (pure) + resolveKelompokOutletCodes (db-mocked).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractKelompokFromCode, resolveKelompokOutletCodes } from '@/lib/kelompok-resolver';

// vi.hoisted ensures the mock is available when vi.mock factory runs (vi.mock is hoisted).
const { mockQueryRaw, mockExecuteRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: mockQueryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
    }),
  },
}));

// Mock logger to avoid noisy console output
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('extractKelompokFromCode', () => {
  it('extracts from "1030.BDGSET" format → "BDG"', () => {
    expect(extractKelompokFromCode('1030.BDGSET')).toBe('BDG');
  });

  it('extracts from "B.1001.MLGPAR" format → "MLG"', () => {
    expect(extractKelompokFromCode('B.1001.MLGPAR')).toBe('MLG');
  });

  it('handles multi-segment codes (uses LAST segment)', () => {
    expect(extractKelompokFromCode('X.Y.Z.JKT123')).toBe('JKT');
  });

  it('handles single-segment codes (returns first 3 chars)', () => {
    expect(extractKelompokFromCode('SMG12345')).toBe('SMG');
  });

  it('uppercases the result', () => {
    expect(extractKelompokFromCode('abc.def123')).toBe('DEF');
  });

  it('handles short last segment (< 3 chars)', () => {
    expect(extractKelompokFromCode('abc.ab')).toBe('AB');
    expect(extractKelompokFromCode('abc.a')).toBe('A');
  });

  it('handles empty string', () => {
    expect(extractKelompokFromCode('')).toBe('');
  });
});

describe('resolveKelompokOutletCodes', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it('returns empty array when kelompok is null/undefined/"all"', async () => {
    expect(await resolveKelompokOutletCodes(null)).toEqual([]);
    expect(await resolveKelompokOutletCodes(undefined)).toEqual([]);
    expect(await resolveKelompokOutletCodes('')).toEqual([]);
    expect(await resolveKelompokOutletCodes('all')).toEqual([]);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('queries DB and returns outlet codes when kelompok is provided', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { code: '1010.BDG1' },
      { code: '1011.BDG2' },
      { code: 'B.1002.BDG3' },
    ]);
    const result = await resolveKelompokOutletCodes('BDG');
    expect(result).toEqual(['1010.BDG1', '1011.BDG2', 'B.1002.BDG3']);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns __NO_MATCH__ sentinel when DB query returns no rows', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const result = await resolveKelompokOutletCodes('XYZ');
    expect(result).toEqual(['__NO_MATCH__']);
  });

  it('returns empty array on DB error (graceful fallback)', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('connection refused'));
    const result = await resolveKelompokOutletCodes('BDG');
    expect(result).toEqual([]);
  });

  it('passes kelompok to SQL as parameter (case-insensitive UPPER())', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await resolveKelompokOutletCodes('bdg');
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // Prisma.Sql extends Array — when vitest mock records the call, the array items
    // are the SQL text fragments (interleaved with $-placeholders where parameters go).
    // Verify the SQL text contains the case-insensitive UPPER() wrapper.
    const call = mockQueryRaw.mock.calls[0][0];
    const sqlText = Array.isArray(call) ? call.join('$PARAM$') : String(call);
    expect(sqlText).toContain('UPPER(');
    expect(sqlText).toContain('LEFT(SUBSTRING');
    expect(sqlText).toContain('"Outlet"');
  });
});
