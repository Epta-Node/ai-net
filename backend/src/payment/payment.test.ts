import { Keypair } from '@stellar/stellar-sdk';
import { createPaymentReleaseFn, type StellarReleasePaymentFn } from './index';
import * as taskStore from '../coordinator/taskStore';
import type { Task } from '../types/task';

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromSecret: jest.fn(() => ({ publicKey: () => 'GCOORDINATOR_MOCK_KEY' })),
  },
}));

const mockTask: Task = {
  id: 'task_abc123',
  prompt: 'test prompt',
  walletPublicKey: 'GAGENT_WALLET_PUBLIC_KEY',
  status: 'running',
  dag: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('createPaymentReleaseFn', () => {
  let stellarRelease: jest.MockedFunction<StellarReleasePaymentFn>;

  beforeEach(() => {
    stellarRelease = jest.fn();
    delete process.env.STELLAR_COORDINATOR_SECRET;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns no-op and warns when STELLAR_COORDINATOR_SECRET is unset', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const fn = createPaymentReleaseFn(stellarRelease);
    const result = await fn('task_abc123', 'node_research');

    expect(result).toBe('noop');
    expect(stellarRelease).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STELLAR_COORDINATOR_SECRET not set'));
    warn.mockRestore();
  });

  it('returns no-op and warns when stellarRelease is not provided', async () => {
    process.env.STELLAR_COORDINATOR_SECRET = 'STEST_SECRET';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const fn = createPaymentReleaseFn(undefined);
    const result = await fn('task_abc123', 'node_research');

    expect(result).toBe('noop');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stellar release function unavailable'));
    warn.mockRestore();
  });

  it('calls releasePayment with correct taskId, keypair, and walletPublicKey', async () => {
    process.env.STELLAR_COORDINATOR_SECRET = 'STEST_SECRET';
    jest.spyOn(taskStore, 'getTask').mockReturnValue(mockTask);
    stellarRelease.mockResolvedValue('stellar_tx_hash_abc');

    const fn = createPaymentReleaseFn(stellarRelease);
    const result = await fn('task_abc123', 'node_research');

    expect(result).toBe('stellar_tx_hash_abc');
    expect(Keypair.fromSecret).toHaveBeenCalledWith('STEST_SECRET');
    expect(stellarRelease).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: expect.any(Function) }),
      'GAGENT_WALLET_PUBLIC_KEY',
      'task_abc123'
    );
  });

  it('throws with nodeId in message when task is not found', async () => {
    process.env.STELLAR_COORDINATOR_SECRET = 'STEST_SECRET';
    jest.spyOn(taskStore, 'getTask').mockReturnValue(undefined);

    const fn = createPaymentReleaseFn(stellarRelease);

    await expect(fn('missing_task', 'node_risk')).rejects.toThrow(
      '[payment] Task not found: missing_task (node: node_risk)'
    );
    expect(stellarRelease).not.toHaveBeenCalled();
  });
});
