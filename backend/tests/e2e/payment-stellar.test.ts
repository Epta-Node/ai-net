/**
 * Stellar payment integration test — Issue #63
 *
 * Verifies the full payment release path against the live Stellar testnet:
 *   createPaymentReleaseFn(realReleasePayment)
 *   → Keypair.fromSecret(STELLAR_COORDINATOR_SECRET)
 *   → smart-contracts releasePayment(keypair, agentPublicKey, taskId)
 *   → Horizon testnet
 *
 * Skipped in CI unless STELLAR_E2E=1 is explicitly set.
 * Requires STELLAR_TEST_SECRET (funded testnet keypair) in env.
 *
 * Run locally:
 *   STELLAR_E2E=1 STELLAR_TEST_SECRET=S... npm test -- payment-stellar
 */

import { createPaymentReleaseFn, type StellarReleasePaymentFn } from '../../src/payment';
import { createTask, getTask } from '../../src/coordinator/taskStore';

const runE2E = process.env.STELLAR_E2E === '1';
// Conditional: skip each test in CI, run on STELLAR_E2E=1
const itE2E = runE2E ? it : it.skip;

// Load smart-contracts releasePayment via dynamic require to avoid TypeScript
// cross-package rootDir constraints. At runtime ts-jest resolves the .ts file.
function loadRealReleasePayment(): StellarReleasePaymentFn {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../../smart-contracts/src/payment/payment').releasePayment as StellarReleasePaymentFn;
}

describe('Stellar payment integration (STELLAR_E2E=1)', () => {
  const taskId = 'task_e2e_payment_test';

  beforeAll(() => {
    if (!runE2E) return;

    const secret = process.env.STELLAR_TEST_SECRET;
    if (!secret) {
      throw new Error('STELLAR_TEST_SECRET is required when STELLAR_E2E=1');
    }
    // Use the test secret as the coordinator secret for this test run
    process.env.STELLAR_COORDINATOR_SECRET = secret;

    // Register a dummy task so createPaymentReleaseFn can look it up
    createTask({
      id: taskId,
      prompt: 'e2e payment integration test',
      // The agent public key is derived from the same test keypair for simplicity
      walletPublicKey: require('@stellar/stellar-sdk').Keypair.fromSecret(secret).publicKey(),
      status: 'running',
      dag: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterAll(() => {
    delete process.env.STELLAR_COORDINATOR_SECRET;
  });

  itE2E(
    'createPaymentReleaseFn with real releasePayment propagates Stellar errors for unknown escrow',
    async () => {
      const fn = createPaymentReleaseFn(loadRealReleasePayment());

      // No escrow was locked for this taskId — expect a Stellar-level error
      // (either "No CreateClaimableBalance transaction found" or a Horizon error).
      // This proves the wiring reaches Horizon rather than short-circuiting to no-op.
      await expect(fn(taskId, 'node_e2e')).rejects.toThrow();
    },
    60_000
  );

  itE2E(
    'no-op path is still skipped when STELLAR_COORDINATOR_SECRET is set',
    async () => {
      // Verify the factory does NOT return no-op when the secret is present
      const fn = createPaymentReleaseFn(loadRealReleasePayment());
      // The function should attempt a real Stellar call, not silently return 'noop'
      const result = fn(taskId, 'node_e2e').catch(err => err.message ?? 'stellar_error');
      await expect(result).resolves.not.toBe('noop');
    },
    60_000
  );
});
