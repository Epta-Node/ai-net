/**
 * Agent ownership proof via Ed25519 challenge–response (#557, #558).
 *
 * Every agent-mutating route (`register`, `heartbeat`, `delete`) proves that
 * the caller controls the Stellar account it claims to act for. Without that
 * proof anyone could register an agent under a victim's public key and
 * receive escrow settlements, or keep a decommissioned agent pinned into the
 * dispatch pool by forging heartbeats.
 *
 * Flow:
 *   1. `POST /api/agents/challenge` returns a single-use, short-lived nonce
 *      plus the exact canonical message to sign.
 *   2. The client signs the message with the agent's Stellar secret key.
 *   3. The protected route re-derives the message from its own request,
 *      verifies the signature against the claimed public key, and burns the
 *      nonce.
 *
 * Binding the nonce to the route purpose, the claimed public key and a hash of
 * the request payload is what makes a signature non-transferable: a signature
 * captured for one route cannot be replayed against another, and a signature
 * over a different registration payload fails verification.
 *
 * One helper serves all three routes on purpose — #557 and #558 are the same
 * class of defect, and a second copy of this logic would drift.
 *
 * Operational note: the challenge store is per-process. Behind a load balancer,
 * either run a single API instance or enable sticky sessions, otherwise a
 * challenge minted on one instance is unknown on the next and the agent sees
 * `AGENT_CHALLENGE_INVALID` for a proof it produced correctly. Moving the store
 * to shared storage is the follow-up if the deployment scales out.
 */
import { createHash, randomBytes } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { Request } from "express";
import { AppError } from "../errors";
import { getConfig } from "../config";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "agentSignature" });

/** Routes that require an ownership proof. */
export const AGENT_AUTH_PURPOSES = ["register", "heartbeat", "delete"] as const;
export type AgentAuthPurpose = (typeof AGENT_AUTH_PURPOSES)[number];

/** Domain separator — keeps these signatures from being replayed elsewhere. */
const AGENT_AUTH_SCHEME = "ai-net:agent-auth:v1";

/** Header carrying the server-issued nonce. */
export const AGENT_CHALLENGE_HEADER = "x-challenge";
/** Header carrying the base64 Ed25519 signature of the canonical message. */
export const AGENT_SIGNATURE_HEADER = "x-signature";

/**
 * Hard cap on outstanding challenges.
 *
 * The store is in-process, so an unbounded map would be a memory-growth
 * vector against the challenge endpoint. Entries are also TTL-evicted, and
 * a burst larger than the cap can only ever push the caller's own new
 * challenges out — never another agent's.
 */
const MAX_PENDING_CHALLENGES = 10_000;

export interface AgentChallenge {
  challenge: string;
  message: string;
  expiresAt: string;
}

interface PendingChallenge {
  publicKey: string;
  purpose: AgentAuthPurpose;
  payloadHash: string;
  agentId?: string;
  expiresAtMs: number;
}

// ── Error taxonomy ────────────────────────────────────────────────────────────

/**
 * Ownership proof failed.
 *
 * `code` distinguishes the two failure classes so clients can react
 * differently: a stale `challenge` means "fetch a new nonce and retry", while
 * a `signature` failure means the caller's key does not match the agent.
 */
export class AgentAuthError extends AppError {
  constructor(
    message: string,
    code: "AGENT_CHALLENGE_INVALID" | "AGENT_SIGNATURE_INVALID",
    details?: Record<string, unknown>,
    correlationId?: string,
  ) {
    super(message, 401, code, details, correlationId);
    this.name = "AgentAuthError";
  }
}

/** True for ownership-proof failures raised by this module. */
export function isAgentAuthError(error: unknown): error is AgentAuthError {
  return (
    error instanceof AgentAuthError ||
    (error instanceof AppError &&
      (error.code === "AGENT_CHALLENGE_INVALID" ||
        error.code === "AGENT_SIGNATURE_INVALID"))
  );
}

// ── Canonicalisation ──────────────────────────────────────────────────────────

/**
 * Deterministic JSON with sorted object keys.
 *
 * Both sides of the protocol must hash byte-identical input, so key order
 * cannot depend on how the object was constructed. Array order *is* preserved —
 * it carries meaning for `capabilities`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 (hex) of the canonical form of `payload`. */
export function hashAgentPayload(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

export interface AgentAuthMessageInput {
  purpose: AgentAuthPurpose;
  publicKey: string;
  challenge: string;
  payloadHash: string;
}

/**
 * The canonical string an agent signs.
 *
 * Newline-joined so the layout is unambiguous, and includes every field that
 * scopes the proof to one specific request.
 */
export function buildAgentAuthMessage(input: AgentAuthMessageInput): string {
  return [
    AGENT_AUTH_SCHEME,
    input.purpose,
    input.publicKey,
    input.challenge,
    input.payloadHash,
  ].join("\n");
}

// ── Challenge store ───────────────────────────────────────────────────────────

const pending = new Map<string, PendingChallenge>();

function challengeTtlMs(): number {
  return getConfig().AGENT_CHALLENGE_TTL_MS;
}

function pruneExpired(now: number): void {
  for (const [nonce, entry] of pending) {
    if (entry.expiresAtMs <= now) pending.delete(nonce);
  }
}

export interface IssueChallengeInput {
  purpose: AgentAuthPurpose;
  publicKey: string;
  /** Canonical payload the signature must cover. */
  payload: unknown;
  agentId?: string;
}

/**
 * Mint a single-use nonce and return the exact message to sign.
 *
 * The TTL is read at issue time so a deployment can widen or narrow the
 * window without restarting.
 */
export function issueAgentChallenge(
  input: IssueChallengeInput,
): AgentChallenge {
  const now = Date.now();
  pruneExpired(now);

  // Evict the oldest entries rather than growing without bound.
  while (pending.size >= MAX_PENDING_CHALLENGES) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }

  const challenge = randomBytes(24).toString("base64url");
  const expiresAtMs = now + challengeTtlMs();
  const payloadHash = hashAgentPayload(input.payload);
  const message = buildAgentAuthMessage({
    purpose: input.purpose,
    publicKey: input.publicKey,
    challenge,
    payloadHash,
  });

  pending.set(challenge, {
    publicKey: input.publicKey,
    purpose: input.purpose,
    payloadHash,
    agentId: input.agentId,
    expiresAtMs,
  });

  return {
    challenge,
    message,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** Drop all outstanding challenges. Test-only escape hatch. */
export function resetAgentChallenges(): void {
  pending.clear();
}

/** Number of outstanding challenges. Exposed for tests. */
export function pendingAgentChallengeCount(): number {
  return pending.size;
}

/**
 * Field equality for challenge binding.
 *
 * Every value compared here — public keys, payload hashes, nonces, agent ids —
 * is already visible to both parties, so a constant-time comparison would add
 * cost without hiding anything. Timing attacks need a secret to leak.
 */
function sameValue(a: string, b: string): boolean {
  return a === b;
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface VerifyAgentOwnershipInput extends IssueChallengeInput {
  /** Agent the proof must resolve to — heartbeat and delete only. */
  agentId?: string;
  correlationId?: string;
}

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

function decodeSignature(signature: string): Buffer | null {
  // Accept base64 (what the docs specify) and hex, since Stellar tooling
  // emits both. Anything else is a malformed proof, not a failed one.
  if (/^[0-9a-fA-F]+$/.test(signature) && signature.length % 2 === 0) {
    return Buffer.from(signature, "hex");
  }
  const decoded = Buffer.from(signature, "base64");
  if (decoded.length === 0) return null;
  // Reject strings that are not valid base64 rather than silently truncating.
  return sameValue(
    decoded.toString("base64").replace(/=+$/, ""),
    signature.replace(/=+$/, ""),
  )
    ? decoded
    : null;
}

/**
 * Verify an agent's ownership proof for the current request.
 *
 * Throws {@link AgentAuthError} on any failure; returns normally when the
 * caller has proven control of `publicKey`. The nonce is consumed on every
 * presentation — including a failed one — so a single challenge can never
 * authorize a second request.
 */
export function verifyAgentOwnership(
  req: Request,
  input: VerifyAgentOwnershipInput,
): void {
  const { purpose, publicKey, payload, agentId, correlationId } = input;
  const now = Date.now();

  const challenge = readHeader(req, AGENT_CHALLENGE_HEADER);
  if (!challenge) {
    throw new AgentAuthError(
      "Missing agent challenge",
      "AGENT_CHALLENGE_INVALID",
      { header: AGENT_CHALLENGE_HEADER, purpose },
      correlationId,
    );
  }

  const signature = readHeader(req, AGENT_SIGNATURE_HEADER);
  if (!signature) {
    throw new AgentAuthError(
      "Missing agent signature",
      "AGENT_SIGNATURE_INVALID",
      { header: AGENT_SIGNATURE_HEADER, purpose },
      correlationId,
    );
  }

  const entry = pending.get(challenge);
  // Burn the nonce on presentation: unknown, expired and already-used
  // challenges are indistinguishable to an attacker, and a challenge that
  // survives a failed attempt is a challenge that can be retried.
  if (entry) pending.delete(challenge);

  if (!entry) {
    throw new AgentAuthError(
      "Unknown or already-used agent challenge",
      "AGENT_CHALLENGE_INVALID",
      { reason: "unknown_or_used", purpose },
      correlationId,
    );
  }

  if (entry.expiresAtMs <= now) {
    throw new AgentAuthError(
      "Agent challenge expired",
      "AGENT_CHALLENGE_INVALID",
      { reason: "expired", purpose },
      correlationId,
    );
  }

  const payloadHash = hashAgentPayload(payload);
  const bound =
    entry.purpose === purpose &&
    sameValue(entry.publicKey, publicKey) &&
    sameValue(entry.payloadHash, payloadHash) &&
    (entry.agentId === undefined || sameValue(entry.agentId, agentId ?? ""));

  if (!bound) {
    throw new AgentAuthError(
      "Agent challenge was not issued for this request",
      "AGENT_CHALLENGE_INVALID",
      { reason: "binding_mismatch", purpose },
      correlationId,
    );
  }

  const signatureBytes = decodeSignature(signature);
  if (!signatureBytes) {
    throw new AgentAuthError(
      "Agent signature is not valid base64 or hex",
      "AGENT_SIGNATURE_INVALID",
      { purpose },
      correlationId,
    );
  }

  const message = buildAgentAuthMessage({
    purpose,
    publicKey,
    challenge,
    payloadHash,
  });

  let verified = false;
  try {
    verified = Keypair.fromPublicKey(publicKey).verify(
      Buffer.from(message, "utf8"),
      signatureBytes,
    );
  } catch (err) {
    logger.warn({ err, purpose }, "agent signature verification threw");
  }

  if (!verified) {
    throw new AgentAuthError(
      "Agent signature does not match the claimed Stellar public key",
      "AGENT_SIGNATURE_INVALID",
      { reason: "signature_mismatch", purpose },
      correlationId,
    );
  }
}
