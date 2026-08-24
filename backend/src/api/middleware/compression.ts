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
 *   app.use(compressionMiddleware());
 */

import compression from "compression";
import { createBrotliCompress, constants as zlibConstants } from "zlib";
import type { Request, Response, NextFunction, RequestHandler } from "express";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum response size in bytes before compression is applied. */
export const COMPRESSION_THRESHOLD = 1024; // 1 KB

/**
 * Content-type patterns that are already compressed or binary —
 * applying gzip/brotli on top wastes CPU and grows the payload.
 */
const SKIP_CONTENT_TYPES =
  /^(image\/|audio\/|video\/|application\/(zip|gzip|x-gzip|x-bzip|x-bzip2|x-7z-compressed|x-rar-compressed|octet-stream|wasm)|font\/)/i;

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
function brotliMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const acceptEncoding = req.headers["accept-encoding"] ?? "";
    if (!acceptEncoding.includes("br")) {
      next();
      return;
    }

    // Intercept res.write / res.end to stream through Brotli.
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    let brotliEnabled = false;
    let brotliStream: ReturnType<typeof createBrotliCompress> | null = null;

    // We defer Brotli setup until the first write so we know the content-type.
    const setupBrotli = (): boolean => {
      if (brotliEnabled) return true;
      const ct = res.getHeader("content-type") as string | undefined;
      if (shouldSkipContentType(ct)) return false;

      const level = Math.min(
        Math.max(Number(process.env.COMPRESSION_LEVEL ?? 6), 1),
        11, // Brotli max quality
      );
      brotliStream = createBrotliCompress({
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: level },
      });
      brotliEnabled = true;
      res.setHeader("Content-Encoding", "br");
      res.removeHeader("Content-Length"); // length will change after compression
      brotliStream.pipe(res as unknown as NodeJS.WritableStream);
      return true;
    };

    (res as any).write = function (
      chunk: any,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean {
      if (!setupBrotli()) {
        return (originalWrite as any)(chunk, encodingOrCallback, callback);
      }
      return brotliStream!.write(chunk, encodingOrCallback as BufferEncoding, callback);
    };

    (res as any).end = function (
      chunk?: any,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: () => void,
    ): Response {
      if (!setupBrotli()) {
        return (originalEnd as any)(chunk, encodingOrCallback, callback);
      }
      if (chunk) {
        brotliStream!.write(chunk, encodingOrCallback as BufferEncoding);
      }
      brotliStream!.end(callback);
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
 *  1. Brotli compression (when client supports it) — highest priority.
 *  2. gzip/deflate compression via the `compression` npm package.
 *
 * Mount the returned array with `app.use(...compressionMiddleware())`.
 */
export function compressionMiddleware(
  opts: CompressionOptions = {},
): RequestHandler[] {
  const threshold = opts.threshold ?? COMPRESSION_THRESHOLD;
  const level = opts.level ?? Math.min(Math.max(Number(process.env.COMPRESSION_LEVEL ?? 6), 1), 9);
  const enableBrotli = opts.enableBrotli ?? true;

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

  return enableBrotli ? [brotliMiddleware(), gzipHandler] : [gzipHandler];
}
