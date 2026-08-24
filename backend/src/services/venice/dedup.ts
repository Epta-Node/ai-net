/**
 * Deduplicates concurrent requests that share the same key so that multiple
 * in-flight calls for the same prompt collapse into a single upstream call.
 */
export class RequestDeduplicator {
  private readonly inflight = new Map<string, Promise<string>>();

  dedup(key: string, fn: () => Promise<string>): Promise<string> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
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
