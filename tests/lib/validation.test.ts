// Tests for Zod validation schemas — covers schemas NOT yet covered by
// src/lib/validation.test.ts (outletItemsQuerySchema, itemHistoryQuerySchema,
// recommendationsQuerySchema, paretoQuerySchema, peerComparisonQuerySchema,
// exportReportQuerySchema, dataDeleteQuerySchema, dataGetQuerySchema,
// picPostBodySchema, ingestProcessBodySchema, ingestProcessDeleteBodySchema,
// importDriveBodySchema, settingsUpdateSchema, etc.).
import { describe, it, expect } from 'vitest';
import {
  outletItemsQuerySchema,
  itemHistoryQuerySchema,
  recommendationsQuerySchema,
  paretoQuerySchema,
  peerComparisonQuerySchema,
  peerComparisonItemsQuerySchema,
  peerComparisonTrendQuerySchema,
  exportReportQuerySchema,
  dataDeleteQuerySchema,
  dataGetQuerySchema,
  picPostBodySchema,
  ingestPostBodySchema,
  ingestProcessBodySchema,
  ingestProcessDeleteBodySchema,
  ingestUploadBodySchema,
  importDriveBodySchema,
  settingsUpdateSchema,
  outletCodeSchema,
  itemNameSchema,
  areaSchema,
  picSchema,
  kelompokSchema,
  compareWeekSchema,
  limitSchema,
  cursorSchema,
  validateBody,
} from '@/lib/validation';

describe('outletItemsQuerySchema', () => {
  it('accepts valid params with required outletCode', () => {
    const r = outletItemsQuerySchema.safeParse({
      outletCode: '1251.CBIPAS',
      month: 'Agustus 2026',
      week: 'WEEK 1',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when outletCode is missing (required)', () => {
    const r = outletItemsQuerySchema.safeParse({ month: 'Agustus 2026' });
    expect(r.success).toBe(false);
  });

  it('accepts compareWeek + compareMonth', () => {
    const r = outletItemsQuerySchema.safeParse({
      outletCode: 'A.B1',
      month: 'Agustus 2026',
      week: 'WEEK 1',
      compareWeek: 'WEEK 1|||Juli 2026',
      compareMonth: 'Juli 2026',
    });
    expect(r.success).toBe(true);
  });
});

describe('itemHistoryQuerySchema', () => {
  it('accepts valid params', () => {
    const r = itemHistoryQuerySchema.safeParse({
      outletCode: '1251.CBIPAS',
      itemName: 'Ayam Goreng',
      month: 'Agustus 2026',
      week: 'WEEK 1',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when outletCode missing', () => {
    const r = itemHistoryQuerySchema.safeParse({ itemName: 'Ayam' });
    expect(r.success).toBe(false);
  });

  it('rejects when itemName missing', () => {
    const r = itemHistoryQuerySchema.safeParse({ outletCode: 'A.B1' });
    expect(r.success).toBe(false);
  });
});

describe('recommendationsQuerySchema', () => {
  it('accepts valid params with limit', () => {
    const r = recommendationsQuerySchema.safeParse({
      month: 'Agustus 2026',
      week: 'WEEK 1',
      limit: '50',
      area: 'JAWA TIMUR 1',
    });
    expect(r.success).toBe(true);
  });

  it('coerces limit to number', () => {
    const r = recommendationsQuerySchema.safeParse({ limit: '25' });
    if (r.success) {
      expect(typeof r.data.limit).toBe('number');
      expect(r.data.limit).toBe(25);
    }
  });

  it('rejects limit > 500', () => {
    const r = recommendationsQuerySchema.safeParse({ limit: '501' });
    expect(r.success).toBe(false);
  });
});

describe('paretoQuerySchema', () => {
  it('accepts valid params with parentDim + childDim enums', () => {
    const r = paretoQuerySchema.safeParse({
      month: 'Agustus 2026',
      week: 'WEEK 1',
      parentDim: 'item',
      childDim: 'outlet',
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid parentDim', () => {
    const r = paretoQuerySchema.safeParse({
      parentDim: 'invalid',
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid childDim', () => {
    const r = paretoQuerySchema.safeParse({
      childDim: 'not-valid',
    });
    expect(r.success).toBe(false);
  });
});

describe('peerComparisonQuerySchema', () => {
  it('accepts valid params', () => {
    const r = peerComparisonQuerySchema.safeParse({
      outletCode: '1251.CBIPAS',
      month: 'Agustus 2026',
      week: 'WEEK 1',
      mode: 'week',
      limit: '20',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when outletCode missing (required)', () => {
    const r = peerComparisonQuerySchema.safeParse({ month: 'Agustus 2026' });
    expect(r.success).toBe(false);
  });

  it('rejects invalid mode', () => {
    const r = peerComparisonQuerySchema.safeParse({
      outletCode: 'A.B1',
      mode: 'invalid',
    });
    expect(r.success).toBe(false);
  });

  it('accepts kelompok (scopes peer set only)', () => {
    const r = peerComparisonQuerySchema.safeParse({
      outletCode: 'A.B1',
      kelompok: 'BDG',
    });
    expect(r.success).toBe(true);
  });
});

describe('peerComparisonItemsQuerySchema + peerComparisonTrendQuerySchema', () => {
  it('items schema accepts valid params', () => {
    const r = peerComparisonItemsQuerySchema.safeParse({
      outletCode: 'A.B1',
      month: 'Agustus 2026',
      week: 'WEEK 1',
    });
    expect(r.success).toBe(true);
  });

  it('trend schema accepts valid params', () => {
    const r = peerComparisonTrendQuerySchema.safeParse({
      outletCode: 'A.B1',
      month: 'Agustus 2026',
      week: 'WEEK 1',
    });
    expect(r.success).toBe(true);
  });

  it('items schema rejects when outletCode missing', () => {
    const r = peerComparisonItemsQuerySchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe('exportReportQuerySchema', () => {
  it('accepts valid params with sections', () => {
    const r = exportReportQuerySchema.safeParse({
      month: 'Agustus 2026',
      week: 'WEEK 1',
      sections: 'summary,pareto',
    });
    expect(r.success).toBe(true);
  });

  it('accepts compareWeek + compareMonth', () => {
    const r = exportReportQuerySchema.safeParse({
      month: 'Agustus 2026',
      week: 'WEEK 1',
      compareWeek: 'WEEK 1',
      compareMonth: 'Juli 2026',
    });
    expect(r.success).toBe(true);
  });
});

describe('dataDeleteQuerySchema', () => {
  it('accepts delete by month', () => {
    const r = dataDeleteQuerySchema.safeParse({ month: 'Agustus 2026' });
    expect(r.success).toBe(true);
  });

  it('accepts delete by monthKey', () => {
    const r = dataDeleteQuerySchema.safeParse({ monthKey: '2026-08' });
    expect(r.success).toBe(true);
  });

  it('accepts delete by fileId', () => {
    const r = dataDeleteQuerySchema.safeParse({ fileId: '42' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fileId).toBe(42);
  });

  it('accepts delete all with confirm', () => {
    const r = dataDeleteQuerySchema.safeParse({ all: 'true', confirm: 'yes' });
    expect(r.success).toBe(true);
  });

  it('rejects invalid "all" value', () => {
    const r = dataDeleteQuerySchema.safeParse({ all: 'maybe' });
    expect(r.success).toBe(false);
  });
});

describe('dataGetQuerySchema', () => {
  it('accepts valid positive integer fileId', () => {
    const r = dataGetQuerySchema.safeParse({ fileId: '42' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fileId).toBe(42);
  });

  it('rejects zero or negative fileId', () => {
    expect(dataGetQuerySchema.safeParse({ fileId: '0' }).success).toBe(false);
    expect(dataGetQuerySchema.safeParse({ fileId: '-1' }).success).toBe(false);
  });

  it('accepts empty params (fileId optional)', () => {
    expect(dataGetQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe('picPostBodySchema', () => {
  it('accepts valid body', () => {
    const r = picPostBodySchema.safeParse({ outletCode: 'A.B1', pic: 'Andi' });
    expect(r.success).toBe(true);
  });

  it('rejects when outletCode missing', () => {
    const r = picPostBodySchema.safeParse({ pic: 'Andi' });
    expect(r.success).toBe(false);
  });

  it('rejects when pic missing', () => {
    const r = picPostBodySchema.safeParse({ outletCode: 'A.B1' });
    expect(r.success).toBe(false);
  });
});

describe('ingestPostBodySchema', () => {
  it('accepts empty object (default {})', () => {
    const r = ingestPostBodySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts undefined (default {})', () => {
    const r = ingestPostBodySchema.safeParse(undefined);
    expect(r.success).toBe(true);
  });

  it('accepts valid numberLocale', () => {
    const r = ingestPostBodySchema.safeParse({ numberLocale: 'id' });
    expect(r.success).toBe(true);
  });

  it('rejects invalid numberLocale', () => {
    const r = ingestPostBodySchema.safeParse({ numberLocale: 'invalid' });
    expect(r.success).toBe(false);
  });

  it('rejects totalChunks > 1000', () => {
    const r = ingestPostBodySchema.safeParse({ totalChunks: 2000 });
    expect(r.success).toBe(false);
  });
});

describe('ingestProcessBodySchema', () => {
  it('accepts valid body with required fields', () => {
    const r = ingestProcessBodySchema.safeParse({
      mode: 'process',
      fileName: 'data.csv',
      fileHash: 'abcdef1234567890',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when mode missing', () => {
    const r = ingestProcessBodySchema.safeParse({ fileName: 'x.csv', fileHash: 'abcdef1234567890' });
    expect(r.success).toBe(false);
  });

  it('rejects when fileName missing', () => {
    const r = ingestProcessBodySchema.safeParse({ mode: 'process', fileHash: 'abcdef1234567890' });
    expect(r.success).toBe(false);
  });

  it('rejects when fileHash missing', () => {
    const r = ingestProcessBodySchema.safeParse({ mode: 'process', fileName: 'x.csv' });
    expect(r.success).toBe(false);
  });
});

describe('ingestProcessDeleteBodySchema', () => {
  it('accepts valid hex fileHash', () => {
    const r = ingestProcessDeleteBodySchema.safeParse({ fileHash: 'abcdef1234567890' });
    expect(r.success).toBe(true);
  });

  it('accepts missing fileHash (optional)', () => {
    const r = ingestProcessDeleteBodySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('rejects non-hex fileHash', () => {
    const r = ingestProcessDeleteBodySchema.safeParse({ fileHash: 'not-hex!' });
    expect(r.success).toBe(false);
  });

  it('rejects fileHash < 8 chars', () => {
    const r = ingestProcessDeleteBodySchema.safeParse({ fileHash: 'abc' });
    expect(r.success).toBe(false);
  });

  it('strict mode — rejects unknown extra keys', () => {
    const r = ingestProcessDeleteBodySchema.safeParse({ fileHash: 'abcdef12', extra: 'bad' });
    expect(r.success).toBe(false);
  });
});

describe('ingestUploadBodySchema', () => {
  it('accepts valid body', () => {
    const r = ingestUploadBodySchema.safeParse({
      fileHash: 'abcdef1234567890',
      chunkIndex: '0',
      totalChunks: '10',
      fileName: 'data.csv',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.chunkIndex).toBe(0);
      expect(r.data.totalChunks).toBe(10);
    }
  });

  it('rejects negative chunkIndex', () => {
    const r = ingestUploadBodySchema.safeParse({
      fileHash: 'abcdef1234567890',
      chunkIndex: '-1',
      totalChunks: '10',
      fileName: 'data.csv',
    });
    expect(r.success).toBe(false);
  });

  it('rejects totalChunks > 1000', () => {
    const r = ingestUploadBodySchema.safeParse({
      fileHash: 'abcdef1234567890',
      chunkIndex: '0',
      totalChunks: '2000',
      fileName: 'data.csv',
    });
    expect(r.success).toBe(false);
  });
});

describe('importDriveBodySchema', () => {
  it('accepts valid URL', () => {
    const r = importDriveBodySchema.safeParse({ url: 'https://drive.google.com/file/d/abc' });
    expect(r.success).toBe(true);
  });

  it('rejects invalid URL', () => {
    const r = importDriveBodySchema.safeParse({ url: 'not a url' });
    expect(r.success).toBe(false);
  });

  it('rejects missing url', () => {
    const r = importDriveBodySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts optional numberLocale', () => {
    const r = importDriveBodySchema.safeParse({ url: 'https://example.com', numberLocale: 'us' });
    expect(r.success).toBe(true);
  });
});

describe('settingsUpdateSchema', () => {
  it('accepts valid body with values + updatedBy', () => {
    const r = settingsUpdateSchema.safeParse({
      values: { STD_DEVIASI_BOM_PCT: '0.05', HISTORICAL_ZSCORE_HIGH: '3' },
      updatedBy: 'andi',
    });
    expect(r.success).toBe(true);
  });

  it('defaults values to {} when missing', () => {
    const r = settingsUpdateSchema.safeParse({ updatedBy: 'andi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.values).toEqual({});
  });

  it('accepts string/number/boolean values', () => {
    const r = settingsUpdateSchema.safeParse({
      values: { a: 'string', b: 123, c: true },
    });
    expect(r.success).toBe(true);
  });

  it('rejects updatedBy > 100 chars', () => {
    const r = settingsUpdateSchema.safeParse({ updatedBy: 'x'.repeat(101) });
    expect(r.success).toBe(false);
  });
});

describe('primitive schemas', () => {
  it('outletCodeSchema accepts alphanumeric+dot codes', () => {
    expect(outletCodeSchema.safeParse('1251.CBIPAS').success).toBe(true);
    expect(outletCodeSchema.safeParse('B.1001.MLGPAR').success).toBe(true);
  });

  it('outletCodeSchema rejects empty string', () => {
    expect(outletCodeSchema.safeParse('').success).toBe(false);
  });

  it('outletCodeSchema rejects > 50 chars', () => {
    expect(outletCodeSchema.safeParse('x'.repeat(51)).success).toBe(false);
  });

  it('itemNameSchema accepts 1-200 chars', () => {
    expect(itemNameSchema.safeParse('a').success).toBe(true);
    expect(itemNameSchema.safeParse('x'.repeat(200)).success).toBe(true);
  });

  it('itemNameSchema rejects empty + > 200 chars', () => {
    expect(itemNameSchema.safeParse('').success).toBe(false);
    expect(itemNameSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('areaSchema accepts 1-50 chars', () => {
    expect(areaSchema.safeParse('JAWA TIMUR 1').success).toBe(true);
  });

  it('picSchema accepts 1-100 chars', () => {
    expect(picSchema.safeParse('Andi').success).toBe(true);
    expect(picSchema.safeParse('x'.repeat(100)).success).toBe(true);
    expect(picSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('kelompokSchema accepts 1-50 chars', () => {
    expect(kelompokSchema.safeParse('BDG').success).toBe(true);
    expect(kelompokSchema.safeParse('x'.repeat(51)).success).toBe(false);
  });

  it('compareWeekSchema accepts min 3 chars / max 100', () => {
    expect(compareWeekSchema.safeParse('WEEK 1').success).toBe(true);
    expect(compareWeekSchema.safeParse('WEEK 1|||Juli 2026').success).toBe(true);
    expect(compareWeekSchema.safeParse('W1').success).toBe(false); // < 3
    expect(compareWeekSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('limitSchema coerces string to number', () => {
    const r = limitSchema.safeParse('25');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(25);
  });

  it('limitSchema rejects 0 and > 500', () => {
    expect(limitSchema.safeParse('0').success).toBe(false);
    expect(limitSchema.safeParse('501').success).toBe(false);
  });

  it('cursorSchema requires positive integer', () => {
    expect(cursorSchema.safeParse('1').success).toBe(true);
    expect(cursorSchema.safeParse('0').success).toBe(false); // positive
    expect(cursorSchema.safeParse('-1').success).toBe(false);
  });
});

describe('validateBody helper', () => {
  it('returns success + parsed data for valid body', () => {
    const r = validateBody(picPostBodySchema, { outletCode: 'A.B1', pic: 'Andi' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.outletCode).toBe('A.B1');
    }
  });

  it('returns failure with field-level error message', () => {
    const r = validateBody(picPostBodySchema, { outletCode: 'A.B1' }); // missing pic
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain('Invalid body');
      expect(r.error).toContain('pic');
    }
  });
});
