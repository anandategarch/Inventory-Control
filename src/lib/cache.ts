// ============================================================
//  LRU cache with TTL for expensive computations
//  Bug 4 fix: add TTL (default 5 min) + explicit clear()
//
//  NOTE: analysisCache (in-memory LRU for /api/analysis) was REMOVED.
//  It was unreliable in serverless (each cold start = fresh memory).
//  /api/analysis now uses DB-level AggregationCache (src/lib/aggregation-cache.ts)
//  which persists across cold starts and is shared across instances.
//  Keep statusCache — it's still used by /api/status for fast dropdown responses.
// ============================================================

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class LRUCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private max: number;
  private ttlMs: number;

  constructor(max = 100, ttlMs = 5 * 60 * 1000) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return false;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// Shared status cache — used by /api/status to avoid re-querying DB on every request.
// Exported so other routes (/api/data, /api/pic) can clear it after mutations
// that affect the status response (e.g., deleting SourceFiles, updating PIC assignments).
export const statusCache = new LRUCache<string, unknown>(1, 5 * 60 * 1000);

