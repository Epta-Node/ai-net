/**
 * API response compression middleware.
 *
 * Strategy:
 *  - Uses the `compression` package which automatically negotiates
 *    gzip or deflate based on the client's `Accept-Encoding` header.
 *  - Brotli (`br`) is supported natively in Node ≥ 10.16 and is applied
 *    on top via a lightweight wrapper when the client advertises it.
 *  - Only responses larger than COMPRESSION_THRESHOLD bytes are compressed
 *    (default: 1 KB) to avoid CPU overhead on tiny payloads.
 *  - Already-compressed content types (images, audio, video, gzip, zip, etc.)
 *    are bypassed to prevent double-compression.
 *  - Compression level is configurable via COMPRESSION_LEVEL env var (1–9,
 *    default 6). Lower values trade size for speed; higher values do the
 *    opposite. Level 6 is the standard zlib default.
 *
 * Usage:
 *   import { compressionMiddleware } from './compression';
 *   app.use(...compressionMiddleware());
 */

import compression from "compression";
import { createBrotliCompress, constants as zlibConstants } from "zlib";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getConfig } from "../../config";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum response size in bytes before compression is applied. */
export const COMPRESSION_THRESHOLD = 1024; // 1 KB

/**
 * Content-type patterns that are already compressed or binary —
 * applying gzip/brotli on top wastes CPU and grows the payload.
 */
const SKIP_CONTENT_TYPES =
  /^(image\/|audio\/|video\/|text\/event-stream|application\/(zip|gzip|x-gzip|x-bzip|x-bzip2|x-7z-compressed|x-rar-compressed|octet-stream|wasm)|font\/)/i;

/** Whether a content-type should be skipped (already compressed / binary). */
function shouldSkipContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return SKIP_CONTENT_TYPES.test(contentType);
}

// ── Brotli wrapper ────────────────────────────────────────────────────────────

/**
 * Thin Express middleware that applies Brotli compression when the client
 * sends `Accept-Encoding: br` AND the response content-type is not already
 * compressed.
 *
 * Must be mounted AFTER the gzip middleware so that it runs first in the
 * outgoing direction (middleware stack is LIFO for response processing).
 *
 * Note: Node's built-in `zlib.createBrotliCompress` is synchronous and does
 * not require an extra npm package.
 */
function brotliMiddleware(threshold: number, level: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const acceptEncoding = req.headers["accept-encoding"] ?? "";
    if (!acceptEncoding.includes("br")) {
      next();
      return;
    }

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const chunks: Buffer[] = [];
    const callbacks: Array<() => void> = [];
    let bytes = 0;
    let bypassed = false;

    const restore = (): void => {
      (res as any).write = originalWrite;
      (res as any).end = originalEnd;
    };

    const isBypassed = (): boolean => {
      const ct = res.getHeader("content-type") as string | undefined;
      const cacheControl = res.getHeader("cache-control") as string | undefined;
      return (
        shouldSkipContentType(ct) ||
        (typeof cacheControl === "string" && /no-transform/i.test(cacheControl))
      );
    };

    const toBuffer = (chunk: any, encoding?: BufferEncoding): Buffer => {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (typeof chunk === "string") return Buffer.from(chunk, encoding);
      return Buffer.from(chunk);
    };

    const flushRaw = (chunk: any, encoding?: BufferEncoding, callback?: () => void): Response => {
      restore();
      for (const buffered of chunks) {
        (originalWrite as any)(buffered);
      }
      for (const done of callbacks) done();
      if (chunk !== undefined && chunk !== null) {
        (originalWrite as any)(toBuffer(chunk, encoding));
      }
      return (originalEnd as any)(callback);
    };

    (res as any).write = function (
      chunk: any,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean {
      if (!bypassed && isBypassed()) {
        bypassed = true;
        restore();
      }
      if (bypassed) {
        return (originalWrite as any)(chunk, encodingOrCallback, callback);
      }

      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const buffered = toBuffer(chunk, encoding);
      chunks.push(buffered);
      bytes += buffered.length;
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (done) callbacks.push(done);
      return true;
    };

    (res as any).end = function (
      chunk?: any,
      encodingOrCallback?: BufferEncoding | (() => void),
      callback?: () => void,
    ): Response {
      if (!bypassed && isBypassed()) bypassed = true;
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (bypassed) return flushRaw(chunk, encoding, done);

      const declaredLength = Number(res.getHeader("content-length") ?? 0);
      const largeEnough =
        declaredLength > 0 ? declaredLength >= threshold : bytes >= threshold;
      if (!largeEnough) return flushRaw(chunk, encoding, done);
      const stream = createBrotliCompress({
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: level },
      });
      restore();
      res.setHeader("Content-Encoding", "br");
      res.removeHeader("Content-Length");
      stream.pipe(res as unknown as NodeJS.WritableStream);
      for (const buffered of chunks) stream.write(buffered);
      for (const flushCallback of callbacks) flushCallback();
      if (chunk !== undefined && chunk !== null) stream.write(toBuffer(chunk, encoding));
      stream.end(done);
      return res;
    };

    next();
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CompressionOptions {
  /** Minimum response size to compress. Default: 1024 bytes (1 KB). */
  threshold?: number;
  /** Compression level 1–9. Default: env COMPRESSION_LEVEL or 6. */
  level?: number;
  /** Enable Brotli compression when client advertises `br`. Default: true. */
  enableBrotli?: boolean;
}

/**
 * Returns an array of Express middleware that together provide:
 *  1. gzip/deflate compression via the `compression` npm package.
 *  2. Brotli compression (when client supports it) — outer response wrapper.
 *
 * Mount the returned array with `app.use(...compressionMiddleware())`.
 */
export function compressionMiddleware(
  opts: CompressionOptions = {},
): RequestHandler[] {
  const config = getConfig();
  const threshold = opts.threshold ?? config.COMPRESSION_THRESHOLD;
  const level = opts.level ?? Math.min(Math.max(config.COMPRESSION_LEVEL, 1), 9);
  const enableBrotli = opts.enableBrotli ?? config.COMPRESSION_ENABLE_BROTLI;

  const gzipHandler = compression({
    threshold,
    level,
    filter(req, res) {
      // Honour the default filter (checks Accept-Encoding), then layer on
      // our own content-type bypass.
      const ct = res.getHeader("content-type") as string | undefined;
      if (shouldSkipContentType(ct)) return false;
      return compression.filter(req, res);
    },
  });

  return enableBrotli ? [gzipHandler, brotliMiddleware(threshold, level)] : [gzipHandler];
}
