// Tests for the use-toast reducer's variant-aware default duration
// (BUG-3-b A7). Destructive (error) toasts carry long actionable Indonesian
// messages ("Timeout — server tidak merespons...", export failures, upload
// errors) — the old Radix default of 5s auto-closed them before the user
// could read them. The reducer now defaults destructive toasts to 10s while
// leaving every other variant on the Radix default (undefined → 5s) and
// always honoring an explicit caller-provided duration.
// The duration flows: reducer state → Toaster spreads the toast object onto
// <Toast> → Radix ToastPrimitives.Root auto-closes on it.
import { describe, it, expect } from 'vitest';
import { reducer } from '@/hooks/use-toast';

const EMPTY_STATE = { toasts: [] };

describe('use-toast reducer — destructive duration (BUG-3-b A7)', () => {
  it('assigns a 10s default duration to destructive toasts', () => {
    const state = reducer(EMPTY_STATE, {
      type: 'ADD_TOAST',
      toast: { id: 't1', open: true, variant: 'destructive' },
    });
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0].duration).toBe(10_000);
  });

  it('leaves non-destructive toasts on the Radix default (duration undefined)', () => {
    const state = reducer(EMPTY_STATE, {
      type: 'ADD_TOAST',
      toast: { id: 't2', open: true, variant: 'default' },
    });
    expect(state.toasts[0].duration).toBeUndefined();
  });

  it('honors an explicit caller-provided duration even for destructive toasts', () => {
    const state = reducer(EMPTY_STATE, {
      type: 'ADD_TOAST',
      toast: { id: 't3', open: true, variant: 'destructive', duration: 3000 },
    });
    expect(state.toasts[0].duration).toBe(3000);
  });

  it('keeps the rest of the ADD_TOAST payload untouched (id/variant pass through)', () => {
    const state = reducer(EMPTY_STATE, {
      type: 'ADD_TOAST',
      toast: { id: 't4', open: true, variant: 'destructive', title: 'Gagal' },
    });
    expect(state.toasts[0].id).toBe('t4');
    expect(state.toasts[0].variant).toBe('destructive');
    expect(state.toasts[0].title).toBe('Gagal');
  });
});
