/**
 * Cache client — in-process LRU cache (default) or Redis.
 *
 * Issue #263
 * ──────────
 * Implements a cache-aside client that all route handlers and middleware use.
 *
 * LRU strategy:
 *  - Uses the `lru-cache` package (battle-tested, zero native deps).
 *  - Items are stored with individual TTLs; `lru-cache` v10 supports per-item
 *    TTL natively via `set(key, value, { ttl })`.
 *  - Max size defaults to 500 entries (config.CACHE_LRU_MAX_SIZE).
 *
 * Redis strategy:
 *  - Optional: when CACHE_DRIVER=redis, the same `CacheClient` interface is
 *    backed by Redis via `ioredis`.  Redis is not a hard dependency in
 *    package.json (ioredis is optional) so the LRU path works without it.
 *
 * Key convention:  api:{METHOD}:{path}:{query_hash}
 */

import { LRUCache } from 'lru-cache';

// ---------------------------------------------------------------------------
// Shared interface
// ---------------------------------------------------------------------------

export interface CacheClient {
  /** Returns the cached value or undefined on miss */
  get(key: string): Promise<string | undefined>;

  /**
   * Store a value.
   * @param ttlSeconds — per-item TTL; falls back to client default if omitted
   */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Remove one key */
  del(key: string): Promise<void>;

  /**
   * Remove all keys matching a glob-style prefix, e.g. `api:GET:/api/agents*`
   * Pattern support: '*' matches any sequence of characters.
   */
  delByPattern(pattern: string): Promise<void>;

  /** Wipe the entire cache — used in tests */
  flush(): Promise<void>;

  /** Number of items currently in cache */
  size(): Promise<number>;
}

// ---------------------------------------------------------------------------
// LRU implementation
// ---------------------------------------------------------------------------

/** Default TTL for LRU items — 60 s.  Individual sets may override. */
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SIZE = 500;

export class LRUCacheClient implements CacheClient {
  private readonly cache: LRUCache<string, string>;

  constructor(maxSize = DEFAULT_MAX_SIZE, defaultTtlMs = DEFAULT_TTL_MS) {
    this.cache = new LRUCache<string, string>({
      max: maxSize,
      ttl: defaultTtlMs,
      // Allow stale reads while revalidating (optional — false for strict freshness)
      allowStale: false,
    });
  }

  async get(key: string): Promise<string | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const opts = ttlSeconds !== undefined ? { ttl: ttlSeconds * 1_000 } : undefined;
    this.cache.set(key, value, opts);
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async delByPattern(pattern: string): Promise<void> {
    // Convert glob '*' to a regex '.*'
    const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${regexStr}$`);
    for (const key of this.cache.keys()) {
      if (re.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  async flush(): Promise<void> {
    this.cache.clear();
  }

  async size(): Promise<number> {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Redis implementation (optional — loaded dynamically)
// ---------------------------------------------------------------------------

export class RedisCacheClient implements CacheClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any; // ioredis.Redis
  private readonly defaultTtl: number;

  constructor(redisUrl: string, defaultTtlSeconds = 60) {
    // ioredis is an optional peer dep — fail loudly if not installed
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Redis } = require('ioredis');
      this.client = new Redis(redisUrl, { lazyConnect: true });
    } catch {
      throw new Error(
        '[cache] CACHE_DRIVER=redis requires ioredis: run `npm install ioredis`',
      );
    }
    this.defaultTtl = defaultTtlSeconds;
  }

  async get(key: string): Promise<string | undefined> {
    const val: string | null = await this.client.get(key);
    return val ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtl;
    await this.client.set(key, value, 'EX', ttl);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async delByPattern(pattern: string): Promise<void> {
    // Redis SCAN is non-blocking; use cursor-based iteration
    let cursor = '0';
    do {
      const [nextCursor, keys]: [string, string[]] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } while (cursor !== '0');
  }

  async flush(): Promise<void> {
    await this.client.flushdb();
  }

  async size(): Promise<number> {
    return this.client.dbsize();
  }
}

// ---------------------------------------------------------------------------
// Factory — creates the right client from config
// ---------------------------------------------------------------------------

let _instance: CacheClient | null = null;

/**
 * Returns the singleton cache client.
 * Call `initCache(config)` once at startup; subsequent calls return the same instance.
 */
export function getCacheClient(): CacheClient {
  if (!_instance) {
    throw new Error('[cache] Cache not initialised — call initCache() first');
  }
  return _instance;
}

export interface CacheConfig {
  driver: 'lru' | 'redis';
  redisUrl?: string;
  lruMaxSize?: number;
  defaultTtlSeconds?: number;
}

export function initCache(cfg: CacheConfig): CacheClient {
  if (cfg.driver === 'redis') {
    _instance = new RedisCacheClient(
      cfg.redisUrl ?? 'redis://localhost:6379',
      cfg.defaultTtlSeconds ?? 60,
    );
  } else {
    _instance = new LRUCacheClient(
      cfg.lruMaxSize ?? DEFAULT_MAX_SIZE,
      (cfg.defaultTtlSeconds ?? 60) * 1_000,
    );
  }
  return _instance;
}

/** Override the singleton — useful in tests */
export function setCacheClient(client: CacheClient): void {
  _instance = client;
}

/** Reset singleton — test teardown */
export function resetCache(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// Cache key builder
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';

/**
 * Builds a cache key following the convention:
 *   api:{METHOD}:{path}:{query_hash}
 *
 * The query hash is a short SHA-256 of the sorted query string so keys remain
 * deterministic regardless of parameter order.
 */
export function buildCacheKey(
  method: string,
  path: string,
  query: Record<string, unknown> = {},
): string {
  const sortedQuery = Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const queryHash = sortedQuery
    ? createHash('sha256').update(sortedQuery).digest('hex').slice(0, 8)
    : 'noquery';
  return `api:${method.toUpperCase()}:${path}:${queryHash}`;
}
