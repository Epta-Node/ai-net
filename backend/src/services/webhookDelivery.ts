// Webhook delivery rules (issue #1010): request signing, signing-key handling,
// response classification, the retry schedule and registration checks. These
// are pure functions over plain values (plus Node's crypto), so the retry and
// signature behaviour can be tested without a server, a clock or a database.
// The routes, the webhook_deliveries table and the dispatcher call into this
// module; none of that lives here.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/** Delays before each retry: 30s, 5m, 30m, 2h, 8h. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  30_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  8 * 60 * 60_000,
] as const;

/** A webhook is disabled once this many delivery attempts have failed. */
export const MAX_FAILED_ATTEMPTS = 5;

/** A receiver that has not answered within this long counts as a failed attempt. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Deliveries listed by `GET /api/webhooks/:id/deliveries`. */
export const DELIVERY_LOG_LIMIT = 50;

export function generateSigningKey(): string {
  return randomBytes(32).toString("hex");
}

/** The only form of a signing key that is stored: SHA-256, hex. */
export function hashSigningKey(signingKey: string): string {
  return createHash("sha256").update(signingKey, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Whether `candidate` is the key whose hash is `storedHash` (for DELETE authorisation). */
export function signingKeyMatches(candidate: unknown, storedHash: string): boolean {
  if (typeof candidate !== "string" || candidate === "") return false;
  return safeEqual(hashSigningKey(candidate), storedHash);
}

/** The `X-Signature` value: lowercase hex HMAC-SHA256 of the exact request body. */
export function signBody(signingKey: string, body: string): string {
  return createHmac("sha256", signingKey).update(body, "utf8").digest("hex");
}

/** Constant-time check of an `X-Signature` header, as a receiver would do it. */
export function verifySignature(signingKey: string, body: string, header: string | null | undefined): boolean {
  if (typeof header !== "string" || header === "") return false;
  return safeEqual(signBody(signingKey, body), header.trim().toLowerCase());
}

export interface DeliveryResult {
  /** HTTP status of the response, when one arrived. */
  httpStatus?: number | null;
  /** True when the request was aborted for taking longer than the timeout. */
  timedOut?: boolean;
  /** Set when the request failed before any response (DNS, connection refused, TLS). */
  error?: string | null;
}

export type DeliveryStatus = "delivered" | "failed";

/** A delivery succeeds only on a 2xx response; everything else is a failure to retry. */
export function classifyDelivery(result: DeliveryResult): DeliveryStatus {
  if (result.timedOut || result.error) return "failed";
  const status = result.httpStatus;
  return typeof status === "number" && status >= 200 && status < 300 ? "delivered" : "failed";
}

export type NextStep =
  | { action: "retry"; delayMs: number; nextRetryAt: Date }
  | { action: "disable" };

/**
 * What to do after a failed attempt. `failedAttempts` counts failures so far,
 * including the one that just happened (1 after the first failure). Attempt n
 * is followed by the n-th delay; the webhook is disabled after
 * MAX_FAILED_ATTEMPTS failures, so the delay after that attempt is never used.
 */
export function nextStepAfterFailure(failedAttempts: number, now: Date): NextStep {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new RangeError("failedAttempts must be a positive integer");
  }
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) return { action: "disable" };
  const delayMs = WEBHOOK_RETRY_DELAYS_MS[failedAttempts - 1];
  return { action: "retry", delayMs, nextRetryAt: new Date(now.getTime() + delayMs) };
}

/** Deliveries whose retry time has come, oldest first. */
export function dueForRetry<T extends { nextRetryAt: Date | null; status: string }>(
  deliveries: readonly T[],
  now: Date,
): T[] {
  return deliveries
    .filter((d) => d.status === "failed" && d.nextRetryAt !== null && d.nextRetryAt.getTime() <= now.getTime())
    .sort((a, b) => (a.nextRetryAt as Date).getTime() - (b.nextRetryAt as Date).getTime());
}

export interface RegistrationInput {
  url?: unknown;
  events?: unknown;
  secret?: unknown;
}

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

/**
 * Checks a registration body. Returns an error message, or null when it is
 * acceptable. Endpoints must be HTTPS and must not point at loopback, private
 * or link-local hosts, so a webhook cannot be used to reach internal services.
 * (Hostnames that resolve to private addresses must still be refused when the
 * request is made.)
 */
export function validateRegistration(input: RegistrationInput, allowedEvents: readonly string[]): string | null {
  if (typeof input.url !== "string") return "url is required.";
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return "url is not a valid URL.";
  }
  if (parsed.protocol !== "https:") return "url must use https.";
  if (parsed.username || parsed.password) return "url must not contain credentials.";
  if (PRIVATE_HOST.test(parsed.hostname)) return "url must not point at a private or local address.";
  if (!Array.isArray(input.events) || input.events.length === 0) return "events must be a non-empty array.";
  const unknown = input.events.find((e) => typeof e !== "string" || !allowedEvents.includes(e));
  if (unknown !== undefined) return `Unknown event: ${String(unknown)}.`;
  if (typeof input.secret !== "string" || input.secret.length < 16) return "secret must be at least 16 characters.";
  return null;
}
