// ============================================================
//  critical-path-gate.test.ts — PERF-FILTER4 Layer 2
//  ------------------------------------------------------------
//  Gate client-side yang memutus kontensi pooler Supabase pada
//  fan-out 6 endpoint saat ganti filter (insiden "Gagal Memuat
//  Analisis" September WEEK 4 — analysis/waste-top-items/
//  waste-rate-league 500 @54-58s paralel, ketiganya 200 saat solo).
//
//  Kontrak yang dipin:
//   • Tanpa gate armed → waitForCriticalPath resolve SEGERA
//     (kombinasi hangat = nol delay untuk kartu non-kritis).
//   • Gate armed → waiter menunggu sampai settle().
//   • settle() → SEMUA waiter dibebaskan.
//   • maxWaitMs cap → waiter tetap dibebaskan walau gate bocor.
//   • criticalPathStart baru mensettle gate lama (ganti filter
//     cepat — waiter key lama tidak menggantung selamanya).
//   • settle() idempotent + tidak menghapus gate pengganti.
//   • waitForCriticalPathThenDelay = gate + delay bertingkat,
//     dan TIDAK memberi delay saat gate tidak armed (hangat).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  criticalPathStart,
  isCriticalPathInFlight,
  waitForCriticalPath,
  waitForCriticalPathThenDelay,
  CRITICAL_PATH_ARM_GRACE_MS,
  __resetCriticalPathGateForTests,
} from '@/lib/critical-path-gate';

describe('critical-path-gate (PERF-FILTER4 Layer 2)', () => {
  beforeEach(() => {
    __resetCriticalPathGateForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    __resetCriticalPathGateForTests();
    vi.useRealTimers();
  });

  it('tanpa gate armed → waitForCriticalPath resolve segera (kombinasi hangat)', async () => {
    expect(isCriticalPathInFlight()).toBe(false);
    let resolved = false;
    void waitForCriticalPath().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('gate armed → waiter menunggu SAMPAI settle dipanggil', async () => {
    const settle = criticalPathStart('analysis|month=September 2026&week=WEEK 4');
    expect(isCriticalPathInFlight()).toBe(true);
    let resolved = false;
    void waitForCriticalPath(40_000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(39_999);
    // Masih menunggu — cap belum tercapai, settle belum dipanggil.
    expect(resolved).toBe(false);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(isCriticalPathInFlight()).toBe(false);
  });

  it('settle() membebaskan SEMUA waiter', async () => {
    const settle = criticalPathStart('k1');
    let a = false, b = false, c = false;
    void waitForCriticalPath().then(() => { a = true; });
    void waitForCriticalPath(1_000).then(() => { b = true; });
    void waitForCriticalPathThenDelay(5_000).then(() => { c = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect([a, b, c]).toEqual([false, false, false]);
    settle();
    // settle melepaskan gate untuk a/b; c masih menjalankan delay 5s.
    await vi.advanceTimersByTimeAsync(0);
    expect([a, b]).toEqual([true, true]);
    expect(c).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c).toBe(true);
  });

  it('maxWaitMs cap → waiter dibebaskan walau settle TIDAK pernah dipanggil (gate bocor)', async () => {
    criticalPathStart('k-leak'); // settle dibuang (tidak pernah dipanggil)
    let resolved = false;
    void waitForCriticalPath(3_000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('criticalPathStart BARU mensettle gate lama (ganti filter cepat)', async () => {
    const settleOld = criticalPathStart('k-old');
    let oldWaiterResolved = false;
    void waitForCriticalPath(40_000).then(() => { oldWaiterResolved = true; });
    // Ganti filter sebelum analysis lama selesai:
    const settleNew = criticalPathStart('k-new');
    await vi.advanceTimersByTimeAsync(0);
    expect(oldWaiterResolved).toBe(true); // waiter key lama tidak menggantung
    expect(isCriticalPathInFlight()).toBe(true); // gate BARU masih armed
    settleNew();
    expect(isCriticalPathInFlight()).toBe(false);
    expect(() => settleOld()).not.toThrow(); // settle lama terlambat — aman
  });

  it('settle() idempotent + tidak menghapus gate pengganti', async () => {
    const settleOld = criticalPathStart('k-old');
    settleOld();
    settleOld(); // idempotent
    expect(isCriticalPathInFlight()).toBe(false);
    const settleNew = criticalPathStart('k-new');
    settleOld(); // settle lama datang lagi — TIDAK boleh melepas gate baru
    expect(isCriticalPathInFlight()).toBe(true);
    settleNew();
    expect(isCriticalPathInFlight()).toBe(false);
  });

  it('waitForCriticalPathThenDelay: TIDAK delay saat gate tidak armed (hangat)', async () => {
    let resolved = false;
    void waitForCriticalPathThenDelay(6_000).then(() => { resolved = true; });
    // Grace 50ms tetap berjalan (memberi kesempatan analysis meng-arm gate
    // di commit yang sama — efek React bottom-up), tapi delay keluarga 6s
    // TIDAK dikenakan tanpa gate:
    await vi.advanceTimersByTimeAsync(CRITICAL_PATH_ARM_GRACE_MS);
    expect(resolved).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(resolved).toBe(true); // tetap true — delay keluarga tidak aktif
  });

  it('grace memberi kesempatan analysis meng-arm gate SETELAH waiter mulai (efek bottom-up)', async () => {
    // Waiter non-kritis start duluan; analysis baru arm 10ms kemudian —
    // grace 50ms harus menangkap gate itu dan waiter menunggu settle.
    let resolved = false;
    void waitForCriticalPathThenDelay(0).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(10);
    const settle = criticalPathStart('late-armed');
    await vi.advanceTimersByTimeAsync(39_000);
    expect(resolved).toBe(false); // masih menunggu critical
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('waitForCriticalPathThenDelay: gate + delay dikenakan berurutan saat dingin', async () => {
    const settle = criticalPathStart('k');
    let resolved = false;
    void waitForCriticalPathThenDelay(6_000).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false); // masih dalam delay keluarga 6s
    await vi.advanceTimersByTimeAsync(6_000);
    expect(resolved).toBe(true);
  });

  it('maxWait <= 0 → tidak menunggu sama sekali (escape hatch)', async () => {
    criticalPathStart('k');
    let resolved = false;
    void waitForCriticalPath(0).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });
});
