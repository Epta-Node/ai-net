/**
 * Docker Compose integration smoke test (issue #753).
 *
 * Runs against the real containers started by `docker compose --profile test`,
 * not an in-process app, so it catches what unit and in-process E2E suites
 * cannot: a broken image, bad wiring between services, missing env vars.
 *
 * Flow: health → signed agent registration → task submit → first SSE event
 * (→ frontend reachable, when FRONTEND_URL is set). Graceful shutdown is
 * checked by the CI job after this script exits (`docker compose stop`).
 *
 * Deliberately dependency-free (Node >= 22 built-ins only) so the compose
 * `smoke` service runs it on a stock node image without `npm install`.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const BASE_URL = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const FRONTEND_URL = process.env.FRONTEND_URL?.replace(/\/$/, '');
const STEP_TIMEOUT_MS = Number(process.env.SMOKE_STEP_TIMEOUT_MS ?? 15_000);

// ── Stellar strkey encoding (ed25519 public key → G... address) ─────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function crc16xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function stellarPublicKey(rawPublicKey) {
  const payload = Buffer.concat([Buffer.from([6 << 3]), rawPublicKey]);
  const crc = crc16xmodem(payload);
  return base32(Buffer.concat([payload, Buffer.from([crc & 0xff, crc >> 8])]));
}

function createAgentKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    publicKey: stellarPublicKey(raw),
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function call(method, path, { body, headers = {}, expect = 200 } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status !== expect) {
    throw new Error(
      `${method} ${path}: expected ${expect}, got ${res.status}: ${text.slice(0, 500)}`
    );
  }
  return text ? JSON.parse(text) : undefined;
}

/** Open the SSE stream and resolve with the first `event:` name it sends. */
async function firstSseEvent(path, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers, signal: controller.signal });
    if (res.status !== 200) throw new Error(`GET ${path}: expected 200, got ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const match = buffer.match(/^event: (.+)$/m);
      if (match) return match[1].trim();
    }
    throw new Error(`GET ${path}: stream closed before any event`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

const steps = [];
const step = (name, fn) => steps.push({ name, fn });
const state = {};

step('backend is live', async () => {
  const live = await call('GET', '/health/live');
  if (live.status !== 'ok') throw new Error(`unexpected liveness body ${JSON.stringify(live)}`);
});

step('agent registers with a signed challenge', async () => {
  const keypair = createAgentKeypair();
  const agent = {
    agentId: `smoke-agent-${randomUUID().slice(0, 8)}`,
    capabilities: ['research'],
    pricingXLM: 1,
    endpoint: 'http://localhost:4001/agent/research',
    stellarPublicKey: keypair.publicKey,
  };
  const challenge = await call('POST', '/api/agents/challenge', {
    body: { purpose: 'register', publicKey: keypair.publicKey, payload: agent },
  });
  const registered = await call('POST', '/api/agents/register', {
    body: agent,
    headers: { 'x-challenge': challenge.challenge, 'x-signature': keypair.sign(challenge.message) },
    expect: 201,
  });
  if (registered.id !== agent.agentId)
    throw new Error(`registered id ${registered.id} != ${agent.agentId}`);
  await call('GET', `/api/agents/${agent.agentId}`);
  state.wallet = keypair.publicKey;
});

step('task is submitted', async () => {
  const created = await call('POST', '/api/tasks', {
    body: { prompt: 'Summarise the ai-net compose smoke test in one sentence.' },
    headers: { walletpublickey: state.wallet, 'idempotency-key': randomUUID() },
    expect: 201,
  });
  if (!created.taskId) throw new Error(`no taskId in ${JSON.stringify(created)}`);
  state.taskId = created.taskId;
});

step('task event stream delivers an event', async () => {
  const event = await firstSseEvent(`/api/tasks/${state.taskId}/events/stream`, {
    walletpublickey: state.wallet,
  });
  console.log(`    first event: ${event}`);
});

if (FRONTEND_URL) {
  step('frontend serves the app shell', async () => {
    const res = await fetch(FRONTEND_URL, { signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    const html = await res.text();
    if (res.status !== 200 || !html.includes('id="root"')) {
      throw new Error(`frontend: status ${res.status}, root element ${html.includes('id="root"')}`);
    }
  });
}

let failed = false;
for (const { name, fn } of steps) {
  const started = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    console.error(`✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
    failed = true;
    break;
  }
}
process.exit(failed ? 1 : 0);
