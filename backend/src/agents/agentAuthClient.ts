/**
 * Client side of the agent ownership proof (#557, #558).
 *
 * Mirrors what `src/api/agentSignature.ts` does on the server: fetch a
 * challenge, sign the canonical message, send it as `x-challenge` /
 * `x-signature`. Shared by `BaseAgent.register()` and `HeartbeatClient` so the
 * two agent entry points in this repo cannot drift from the server contract.
 */
import { Keypair } from '@stellar/stellar-sdk';
import type { AgentAuthPurpose } from '../api/agentSignature';
import { buildAgentAuthMessage, hashAgentPayload } from '../api/agentSignature';
import { getConfig } from '../config';
import { fetchWithTimeout } from '../utils/timeout';

export interface AgentAuthRequest {
  apiBaseUrl: string;
  purpose: AgentAuthPurpose;
  /** Stellar public key of the agent. */
  publicKey: string;
  /** Stellar secret used to sign. Never logged or transmitted. */
  secret?: string;
  /** Object that will be sent to the protected route. */
  payload: unknown;
  agentId?: string;
}

export interface SignedAgentHeaders {
  'x-challenge': string;
  'x-signature': string;
}

interface ChallengeResponse {
  challenge: string;
  message: string;
  expiresAt: string;
}

function authHeaders(apiBaseUrl: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Ask the coordinator for a challenge and sign it.
 *
 * Returns `null` when no secret is configured or the challenge could not be
 * obtained — the caller then falls back to an unsigned request, which the
 * server only tolerates while the migration flag is on.
 */
export async function signAgentRequest(
  request: AgentAuthRequest
): Promise<SignedAgentHeaders | null> {
  if (!request.secret) return null;

  const base = request.apiBaseUrl.replace(/\/$/, '');
  const challengeBody = {
    purpose: request.purpose,
    publicKey: request.publicKey,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    payload: request.payload,
  };

  let issued: ChallengeResponse;
  try {
    const response = await fetchWithTimeout(
      `${base}/api/agents/challenge`,
      authHeaders(base, challengeBody),
      getConfig().TIMEOUT_BUDGET_READ_MS
    );
    if (!response.ok) return null;
    issued = (await response.json()) as ChallengeResponse;
  } catch {
    return null;
  }

  if (!issued?.challenge || !issued.message) return null;

  try {
    const keypair = Keypair.fromSecret(request.secret);
    const signature = keypair.sign(Buffer.from(issued.message, 'utf8'));
    return {
      'x-challenge': issued.challenge,
      'x-signature': signature.toString('base64'),
    };
  } catch {
    return null;
  }
}

export { buildAgentAuthMessage, hashAgentPayload };
