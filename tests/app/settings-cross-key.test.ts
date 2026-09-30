// Tests for /api/settings POST cross-key validation (BUGHUNT-R1 FIX 6).
//
// BOM_DEVIATION_DISPROPORTIONATE (priority 56, WARNING) becomes a strict
// subset of BOM_DEVIATION_MISMATCH (priority 88, ABNORMAL) whenever
// BOM_DISPROPORTIONATE_FACTOR >= BOM_DEVIATION_FACTOR — the rule can then
// NEVER top-flag (invisible). The per-key ranges (1..5 vs 1..100) allow
// that combination, so the POST handler validates the EFFECTIVE pair
// (request merged over the stored values) and rejects it with a 400.
//
// Route-level test following the tests/app pattern (mocked @/lib/db +
// infra modules; real zod validation + SETTING_DEFINITIONS so the payload
// shapes match production exactly).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockGetAllSettings, mockUpsert, mockTransaction, mockInvalidateAnalysisCache } = vi.hoisted(() => ({
  mockGetAllSettings: vi.fn(),
  mockUpsert: vi.fn(),
  mockTransaction: vi.fn(),
  mockInvalidateAnalysisCache: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    setting: { findMany: vi.fn().mockResolvedValue([]), upsert: mockUpsert },
    $transaction: mockTransaction,
  },
}));

vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>();
  return {
    ...actual,
    ensureDefaultSettings: vi.fn().mockResolvedValue(undefined),
    getAllSettings: mockGetAllSettings,
  };
});

vi.mock('@/lib/aggregation-cache', () => ({
  invalidateAnalysisCache: mockInvalidateAnalysisCache,
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ allowed: true }),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  RATE_LIMITS: { settings: { maxRequests: 10, windowMs: 60_000 } },
}));

import { POST } from '@/app/api/settings/route';

/** Minimal NextRequest stand-in — POST only touches req.json(). */
function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** Stored-settings fixture (defaults mirror settings/definitions.ts). */
function storedSettings(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map([
    ['BOM_DEVIATION_FACTOR', '2'],
    ['BOM_DISPROPORTIONATE_FACTOR', '1.5'],
    ...Object.entries(overrides),
  ]);
}

beforeEach(() => {
  mockGetAllSettings.mockReset().mockResolvedValue(storedSettings());
  mockUpsert.mockReset().mockResolvedValue({});
  // The route calls db.$transaction(<array of upsert promises>) — resolve it.
  mockTransaction.mockReset().mockResolvedValue([]);
  mockInvalidateAnalysisCache.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/settings — BUGHUNT-R1 FIX 6 cross-key BOM factor validation', () => {
  it('rejects BOTH keys sent together with dispro >= dev (dead-rule pair) → 400', async () => {
    const res = await POST(makeReq({
      values: { BOM_DISPROPORTIONATE_FACTOR: 3, BOM_DEVIATION_FACTOR: 2 },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('BOM_DISPROPORTIONATE_FACTOR');
    expect(json.error).toContain('BOM_DEVIATION_FACTOR');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects a ONE-KEY update that would break the pair against the STORED other key', async () => {
    // Only dispro sent (4); stored dev = 2 → effective 4 >= 2 → dead pair.
    const res = await POST(makeReq({
      values: { BOM_DISPROPORTIONATE_FACTOR: 4 },
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('tidak mati');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects lowering BOM_DEVIATION_FACTOR below the STORED disproportionate factor', async () => {
    // Only dev sent (1.2); stored dispro = 1.5 → effective 1.5 >= 1.2.
    const res = await POST(makeReq({
      values: { BOM_DEVIATION_FACTOR: 1.2 },
    }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('accepts the safe pair (dispro < dev) and proceeds to the upsert transaction', async () => {
    const res = await POST(makeReq({
      values: { BOM_DISPROPORTIONATE_FACTOR: 1.5, BOM_DEVIATION_FACTOR: 2 },
      updatedBy: 'tester',
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.updated).toBe(2);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockInvalidateAnalysisCache).toHaveBeenCalledTimes(1);
  });

  it('accepts a one-key dispro update that stays below the stored dev', async () => {
    const res = await POST(makeReq({
      values: { BOM_DISPROPORTIONATE_FACTOR: 1.8 },
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.updated).toBe(1);
  });

  it('accepts unrelated keys without touching the pair (stored pair is safe)', async () => {
    const res = await POST(makeReq({
      values: { TOP_N_ITEMS: 15 },
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.updated).toBe(1);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('equal values are rejected too (dispro == dev still makes the subset strict)', async () => {
    const res = await POST(makeReq({
      values: { BOM_DISPROPORTIONATE_FACTOR: 2, BOM_DEVIATION_FACTOR: 2 },
    }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
