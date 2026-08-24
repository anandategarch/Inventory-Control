import { describe, it, expect } from 'vitest';
import { validateQuery, validateBody, analysisQuerySchema, drilldownQuerySchema, monthLabelSchema, weekLabelSchema } from '@/lib/validation';

describe('validation helpers', () => {
  describe('validateQuery', () => {
    it('returns success with parsed data for valid params', () => {
      const params = new URLSearchParams();
      params.set('month', 'Agustus 2026');
      params.set('week', 'WEEK 1');
      const result = validateQuery(analysisQuerySchema, params);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.month).toBe('Agustus 2026');
        expect(result.data.week).toBe('WEEK 1');
      }
    });

    it('returns failure with error message for invalid month', () => {
      const params = new URLSearchParams();
      params.set('month', 'INVALID');
      params.set('week', 'WEEK 1');
      const result = validateQuery(analysisQuerySchema, params);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid query params');
        expect(result.error).toContain('month');
      }
    });

    it('returns failure for invalid week format', () => {
      const params = new URLSearchParams();
      params.set('month', 'Agustus 2026');
      params.set('week', 'invalid');
      const result = validateQuery(analysisQuerySchema, params);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('week');
      }
    });

    it('accepts empty params (all fields optional)', () => {
      const params = new URLSearchParams();
      const result = validateQuery(analysisQuerySchema, params);
      expect(result.success).toBe(true);
    });
  });

  describe('validateBody', () => {
    it('returns success for valid body', () => {
      // Use a simple schema that always passes
      const result = validateBody(analysisQuerySchema, { month: 'Agustus 2026', week: 'WEEK 1' });
      expect(result.success).toBe(true);
    });

    it('returns failure for invalid body', () => {
      const result = validateBody(analysisQuerySchema, { month: 123 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid body');
      }
    });
  });

  describe('monthLabelSchema', () => {
    it('accepts valid Indonesian month labels', () => {
      const valid = ['Januari 2026', 'Mei 2026', 'Agustus 2026', 'Desember 2099'];
      for (const m of valid) {
        expect(monthLabelSchema.safeParse(m).success).toBe(true);
      }
    });

    it('rejects lowercase month', () => {
      expect(monthLabelSchema.safeParse('januari 2026').success).toBe(false);
    });

    it('rejects all uppercase month', () => {
      expect(monthLabelSchema.safeParse('AGUSTUS 2026').success).toBe(false);
    });

    it('rejects non-20xx year', () => {
      expect(monthLabelSchema.safeParse('Januari 1999').success).toBe(false);
    });

    it('accepts undefined (optional)', () => {
      expect(monthLabelSchema.safeParse(undefined).success).toBe(true);
    });
  });

  describe('weekLabelSchema', () => {
    it('accepts valid week labels', () => {
      const valid = ['WEEK 1', 'WEEK 2', 'WEEK 4', 'week 1', 'Week 12'];
      for (const w of valid) {
        expect(weekLabelSchema.safeParse(w).success).toBe(true);
      }
    });

    it('rejects non-WEEK prefix', () => {
      expect(weekLabelSchema.safeParse('W1').success).toBe(false);
      expect(weekLabelSchema.safeParse('Week-1').success).toBe(false);
    });

    it('accepts undefined (optional)', () => {
      expect(weekLabelSchema.safeParse(undefined).success).toBe(true);
    });
  });

  describe('drilldownQuerySchema', () => {
    it('accepts valid drilldown params', () => {
      const params = new URLSearchParams();
      params.set('outletCode', '1251.CBIPAS');
      params.set('weekLabel', 'WEEK 1');
      params.set('monthLabel', 'Agustus 2026');
      params.set('limit', '50');
      const result = validateQuery(drilldownQuerySchema, params);
      expect(result.success).toBe(true);
    });

    it('accepts cursor param', () => {
      const params = new URLSearchParams();
      params.set('cursor', '12345');
      const result = validateQuery(drilldownQuerySchema, params);
      expect(result.success).toBe(true);
    });

    it('rejects invalid cursor (non-numeric)', () => {
      const params = new URLSearchParams();
      params.set('cursor', 'abc');
      const result = validateQuery(drilldownQuerySchema, params);
      expect(result.success).toBe(false);
    });
  });
});
