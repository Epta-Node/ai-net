/**
 * Deduplicates concurrent requests that share the same key so that multiple
 * in-flight calls for the same prompt collapse into a single upstream call.
 *
 * The result type is generic: callers dedupe whatever the wrapped call returns
 * (the Venice client dedupes `FetchOutcome` objects, the cache tests dedupe
 * strings). Only calls sharing a key are merged, so a value is never observed
 * as a different type than the one it was produced as.
 */
export class RequestDeduplicator {
  private readonly inflight = new Map<string, Promise<unknown>>();

  dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.inflight.clear();
  }
}
