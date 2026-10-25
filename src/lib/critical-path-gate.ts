// ============================================================
//  critical-path-gate — PERF-FILTER4 Layer 2 (client-side stagger)
//  ------------------------------------------------------------
//  Insiden produksi 25 Okt 2026 ("Gagal Memuat Analisis" tiap ganti
//  filter periode — September WEEK 4, laporan ke-3 dari user):
//
//  REPRODUKSI LIVE (kombinasi dingin, 6 endpoint paralel):
//    analysis 500 @54,7s · waste-top-items 500 @55,9s ·
//    waste-rate-league 500 @58,0s (pareto/recommendations/waste-series 200).
//  KETIGA endpoint YANG SAMA SUKSES saat ditembak SENDIRI-SENDIRI
//    (analysis 28,1s · waste-top-items 22,0s · waste-rate-league 15,1s).
//
//  → Akar masalah: fan-out 6 endpoint berat BERSAMAAN pada kombinasi
//    filter dingin menjenuhkan pooler Supabase free-tier → query melambat
//    2-3× → error ~54-58s yang (sebelum Layer 1) tidak terklasifikasi
//    transient → kartu MERAH permanen "Gagal Memuat Analisis".
//
//  Gate ini memutus kontensi di SUMBERNYA (browser): /api/analysis
//  (pemilik kartu merah + backbone dashboard) menjadi CRITICAL PATH —
//  queryFn-nya menandai gate saat mulai dan menyelesaikannya saat settle.
//  Query NON-KRITIS (keluarga waste + pareto + recommendations) menunggu
//  gate settle (dengan cap waktu) sebelum menembak, lalu diberi delay
//  bertingkat agar tidak bangun BERSAMAAN setelah analysis selesai.
//
//  Properti penting:
//   • Kombinasi HANGAT: queryFn analysis TIDAK jalan (cache TanStack/
//     server) → gate tidak pernah armed → nol delay. Stagger hanya
//     aktif saat benar-benar ada compute dingin di jalur kritis.
//   • Gate berumur maksimal satu siklus fetch analysis (fetchAnalysis
//     punya AbortController 90s → settle dijamin terpanggil via finally).
//   • waitForCriticalPath ber-cap maxWaitMs — kartu non-kritis tidak
//     pernah kelaparan lebih dari cap walau gate bocor.
//   • Module-scope (client-only) — dipakai dari hook/komponen 'use client'.
// ============================================================

/** Cap default: analysis dingin terberat terukur ~34s (produksi) — 40s memberi margin tanpa membuat kartu non-kritis menunggu tak berarti. */
export const DEFAULT_CRITICAL_PATH_MAX_WAIT_MS = 40_000;

/**
 * Grace sebelum snapshot gate: efek React berjalan BOTTOM-UP (kartu anak
 * mount duluan daripada hook analysis di komponen induk) — queryFn
 * non-kritis bisa start beberapa mikro-detik SEBELUM queryFn analysis
 * meng-arm gate. Tanpa grace, snapshot `armed === null` salah baca
 * "hangat" padahal critical sedang akan berangkat. 50ms cukup untuk
 * satu commit React, dan tak terasa bagi user.
 */
export const CRITICAL_PATH_ARM_GRACE_MS = 50;

interface Gate {
  readonly key: string;
  readonly settle: () => void;
  readonly promise: Promise<void>;
}

// Satu-satunya state module — gate yang sedang armed (atau null).
let armed: Gate | null = null;

/**
 * Tandai JALUR KRITIS dimulai. Dipanggil dari queryFn /api/analysis
 * (useAnalysis + prefetchAnalysis — TanStack dedupe keduanya ke satu
 * queryFn run per key, jadi tidak ada double-arm untuk key sama).
 *
 * Mengembalikan fungsi settle() — PANGGIL di finally{} agar gate pasti
 * terlepas walau fetch error/abort. Memanggil settle() dua kali aman
 * (idempotent terhadap gate yang masih aktif).
 *
 * Jika gate lama masih armed saat ini dipanggil (ganti filter cepat
 * berturut-turut), gate lama di-settle dulu — waiter-nya tidak boleh
 * menggantung selamanya menunggu key yang sudah tidak relevan.
 */
export function criticalPathStart(key: string): () => void {
  const prev = armed;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    // Hanya lepaskan state module bila gate INI yang masih armed —
    // jangan menghapus gate baru yang menggantikan (race ganti filter).
    if (armed?.settle === settle) armed = null;
    resolvePromise();
  };
  armed = { key, settle, promise };
  // Key berganti (filter berubah cepat) → waiter gate lama dibebaskan.
  prev?.settle();
  return settle;
}

/** Apakah jalur kritis sedang berjalan? (diagnostic/testing) */
export function isCriticalPathInFlight(): boolean {
  return armed !== null;
}

/**
 * Tunggu jalur kritis selesai. Resolve SEGERA bila tidak ada gate
 * (kombinasi hangat / analysis disabled / belum mounted). Bila gate
 * armed: resolve saat settle() ATAU setelah maxWaitMs mana yang lebih
 * dulu — kartu non-kritis tetap mendapat giliran walau gate bocor.
 */
export async function waitForCriticalPath(
  maxWaitMs: number = DEFAULT_CRITICAL_PATH_MAX_WAIT_MS,
): Promise<void> {
  const gate = armed;
  if (!gate) return;
  if (maxWaitMs <= 0) return;
  await Promise.race([
    gate.promise,
    new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

/**
 * Helper untuk queryFn non-kritis: tunggu gate + delay bertingkat per
 * keluarga endpoint agar mereka tidak memulai BERSAMAAN tepat setelah
 * analysis settle (mencegah burst kontensi kedua).
 *
 * Semantik:
 *   1. Grace 50ms — beri kesempatan queryFn analysis (commit React yang
 *      sama, efek bottom-up) meng-arm gate sebelum kita membaca state.
 *   2. Bila gate armed (compute analysis dingin sedang berjalan): tunggu
 *      settle (cap maxWaitMs) LALU delay keluarga — bangun bergiliran.
 *   3. Bila gate TIDAK armed (kombinasi hangat / analysis disabled):
 *      TIDAK ada delay sama sekali — hanya biaya grace 50ms.
 */
export async function waitForCriticalPathThenDelay(
  familyDelayMs: number,
  maxWaitMs: number = DEFAULT_CRITICAL_PATH_MAX_WAIT_MS,
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, CRITICAL_PATH_ARM_GRACE_MS));
  const gate = armed;
  if (!gate) return;
  await waitForCriticalPath(maxWaitMs);
  if (familyDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, familyDelayMs));
  }
}

/** Reset penuh — hanya untuk testing. */
export function __resetCriticalPathGateForTests(): void {
  armed?.settle();
  armed = null;
}
