// ============================================================
//  LRU in-memory cache for expensive computations
// ============================================================
export class LRUCache<K, V> {
  private map = new Map<K, V>();
  private max: number;

  constructor(max = 100) {
    this.max = max;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // refresh recency
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const analysisCache = new LRUCache<string, unknown>(200);
