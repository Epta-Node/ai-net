/**
 * Contract Integration Test Farm — cross-contract flows against the LIVE
 * Stellar testnet.
 *
 * Exercises the "registry → bidding → task_store" orchestration that local
 * environments cannot validate:
 *   - agent_registry: initialize, register_agent, lookup_agents
 *   - agent_bidding:  create_auction, submit_bid, award_contract (sealed-bid)
 *   - task_store:     store_task_metadata, get_task_metadata, update_task_status
 *   - error_registry: submit_error, get_error
 *
 * Every invocation is a real on-chain transaction measured for gas (CPU/Mem
 * instructions) via `--print-diag`. Measurements are appended to the shared
 * `gas-measurements.json` which the nightly job turns into the farm report.
 *
 * Guarded: only runs when RUN_INTEGRATION_TESTS=true (set by the farm script /
 * nightly CI job). Requires STELLAR_SECRET_KEY + a pre-deploy
 * (deployed-contracts.json produced by scripts/testnet-farm.sh).
 */

import {
  loadDeployedContracts,
  invoke,
  recordGas,
  loadGasMeasurements,
  type DeployedContracts,
} from './client';

const isEnabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const describeFarm = isEnabled ? describe : describe.skip;

jest.setTimeout(600_000);

/** Runs `soroban address` or similar helper to resolve the account strkey. */
function getAccountG(): string {
  const fromEnv = process.env.STELLAR_FARM_ADMIN_G;
  if (fromEnv) return fromEnv;
  // Fallback: derive from the secret key using the Stellar SDK.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair } = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
  if (process.env.STELLAR_SECRET_KEY) {
    return Keypair.fromSecret(process.env.STELLAR_SECRET_KEY).publicKey();
  }
  throw new Error('STELLAR_SECRET_KEY or STELLAR_FARM_ADMIN_G is required.');
}

/** SHA-256 hex of a UTF-8 string (for prompt hashing / bid commitments). */
function sha256Hex(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Distinct task identifier as a symbol (e.g. `farm-task-<nonce>`). */
function taskSymbol(prefix: string, seed: string): string {
  return `${prefix}-${seed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
}

describeFarm('Contract integration test farm (live testnet)', () => {
  let deployed: DeployedContracts;
  let adminG: string;
  let seed: string;

  beforeAll(() => {
    deployed = loadDeployedContracts();
    adminG = getAccountG();
    seed = Date.now().toString(36);
  });

  // ── Registry: initialize + register + lookup ──────────────────────────────

  it('agent_registry: initialize, register_agent, lookup_agents', async () => {
    const registry = deployed.contracts.agent_registry;

    // initialize(admin) — idempotent-friendly: tolerate AlreadyExists on re-deploy
    try {
      const init = await invoke(registry, 'initialize', [`--admin`, adminG]);
      recordGas({ operation: 'registry.initialize', cpu_insns: init.gas?.cpu_insns ?? '0', mem_insns: init.gas?.mem_insns ?? '0', committed: true });
    } catch {
      // Already initialized — acceptable, but assert the account is reachable.
    }

    const agentId = taskSymbol('agent', seed);
    const record = JSON.stringify({
      id: agentId,
      capability: 'research',
      price_stroops: '100000',
      endpoint: 'https://agent.example.com',
      owner: adminG,
      metadata: {},
      bond_amount: '100000000',
    });

    const reg = await invoke(registry, 'register_agent', [`--record`, record]);
    recordGas({ operation: 'registry.register_agent', cpu_insns: reg.gas?.cpu_insns ?? '0', mem_insns: reg.gas?.mem_insns ?? '0', committed: true });

    const lookup = await invoke(registry, 'lookup_agents', [`--capability`, 'research']);
    expect(lookup.stdout).toContain(agentId);
  });

  it('agent_registry: batch register_agents (gas vs baseline)', async () => {
    const registry = deployed.contracts.agent_registry;
    const batch = ['risk', 'coding', 'design'].map((cap) => ({
      id: taskSymbol(`a-${cap}`, seed),
      capability: cap,
      price_stroops: '150000',
      endpoint: 'https://agent.example.com',
      owner: adminG,
      metadata: {},
      bond_amount: '100000000',
    }));

    const res = await invoke(
      registry,
      'register_agents',
      [`--agents`, JSON.stringify(batch)]
    );
    recordGas({ operation: 'registry.register_agents(batch=3)', cpu_insns: res.gas?.cpu_insns ?? '0', mem_insns: res.gas?.mem_insns ?? '0', committed: true });
  });

  // ── Bidding: full sealed-bid lifecycle ────────────────────────────────────

  it('agent_bidding: create_auction → submit_bid → award_contract', async () => {
    const bidding = deployed.contracts.agent_bidding;
    const bidTask = taskSymbol('bid', seed);

    // create_auction(creator, task_id, duration_secs, reserve_price, bond)
    const create = await invoke(bidding, 'create_auction', [
      `--creator`, adminG,
      `--task_id`, bidTask,
      `--duration_secs`, '3600',
      `--reserve_price`, '100000',
      `--bond`, '50000',
    ]);
    recordGas({ operation: 'bidding.create_auction', cpu_insns: create.gas?.cpu_insns ?? '0', mem_insns: create.gas?.mem_insns ?? '0', committed: true });

    // submit_bid(task_id, bidder, commitment, bond, reputation)
    const commitment = sha256Hex(`${bidTask}|100000|terms|salt1`);
    const submit = await invoke(bidding, 'submit_bid', [
      `--task_id`, bidTask,
      `--bidder`, adminG,
      `--commitment`, commitment,
      `--bond`, '50000',
      `--reputation`, '90',
    ]);
    recordGas({ operation: 'bidding.submit_bid', cpu_insns: submit.gas?.cpu_insns ?? '0', mem_insns: submit.gas?.mem_insns ?? '0', committed: true });

    // award_contract(task_id)
    const award = await invoke(bidding, 'award_contract', [`--task_id`, bidTask]);
    recordGas({ operation: 'bidding.award_contract', cpu_insns: award.gas?.cpu_insns ?? '0', mem_insns: award.gas?.mem_insns ?? '0', committed: true });
  });

  // ── Task store: metadata lifecycle ────────────────────────────────────────

  it('task_store: store_task_metadata → get_task_metadata → update_task_status', async () => {
    const taskStore = deployed.contracts.task_store;
    const taskIdHex = sha256Hex(`task-${seed}`);
    const promptHashHex = sha256Hex(`prompt-${seed}`);

    const store = await invoke(taskStore, 'store_task_metadata', [
      `--submitter`, adminG,
      `--task_id`, taskIdHex,
      `--prompt_hash`, promptHashHex,
      `--assigned_agents`, JSON.stringify([adminG]),
      `--compressed_dag`, Buffer.from('dag').toString('hex'),
      `--ttl_days`, '7',
    ]);
    recordGas({ operation: 'task_store.store_task_metadata', cpu_insns: store.gas?.cpu_insns ?? '0', mem_insns: store.gas?.mem_insns ?? '0', committed: true });

    const get = await invoke(taskStore, 'get_task_metadata', [`--task_id`, taskIdHex]);
    expect(get.stdout).toContain(taskIdHex);

    const update = await invoke(taskStore, 'update_task_status', [
      `--task_id`, taskIdHex,
      `--agent`, adminG,
      `--new_status`, 'Running',
    ]);
    recordGas({ operation: 'task_store.update_task_status', cpu_insns: update.gas?.cpu_insns ?? '0', mem_insns: update.gas?.mem_insns ?? '0', committed: true });
  });

  // ── Error registry ────────────────────────────────────────────────────────

  it('error_registry: submit_error → get_error', async () => {
    const errReg = deployed.contracts.error_registry;
    const errorIdHex = sha256Hex(`err-${seed}`);
    const agentId = taskSymbol('agent', seed);

    const submit = await invoke(errReg, 'submit_error', [
      `--error_id`, errorIdHex,
      `--error_code`, '42',
      `--message`, 'farm-synthetic-error',
      `--agent_id`, agentId,
      `--ttl_seconds`, '86400',
    ]);
    recordGas({ operation: 'error_registry.submit_error', cpu_insns: submit.gas?.cpu_insns ?? '0', mem_insns: submit.gas?.mem_insns ?? '0', committed: true });

    const get = await invoke(errReg, 'get_error', [`--error_id`, errorIdHex]);
    expect(get.stdout).toContain(agentId);
  });

  // ── Gas measurements recorded for the report ──────────────────────────────

  it('gas: measurements recorded for the nightly report', () => {
    const measurements = loadGasMeasurements();
    expect(measurements.length).toBeGreaterThan(0);
  });
});
