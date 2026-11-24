import {
  Keypair,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Claimant,
  Memo,
  NotFoundError,
  Account,
} from '@stellar/stellar-sdk';
import axios from 'axios';
import {
  lockEscrow,
  releasePayment,
  refundEscrow,
  getEscrowBalance,
  EscrowAlreadySettledError,
  xlmToStroops,
  stroopsToXlm,
  lockMilestoneEscrow,
  releaseMilestone,
  getMilestoneStatus,
  cancelMilestoneEscrow,
} from '../src/payment/payment';

jest.setTimeout(180000); // 3 minutes timeout for testnet network operations

// Setup Mock for Horizon Server methods
const mockLoadAccount = jest.fn();
const mockFetchBaseFee = jest.fn();
const mockTransactionsCall = jest.fn();
const mockClaimableBalanceCall = jest.fn();
const mockSubmitTransaction = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        fetchBaseFee: mockFetchBaseFee,
        submitTransaction: mockSubmitTransaction,
        transactions: jest.fn().mockReturnValue({
          forAccount: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                call: mockTransactionsCall,
              }),
            }),
          }),
        }),
        claimableBalances: jest.fn().mockReturnValue({
          claimableBalance: jest.fn().mockReturnValue({
            call: mockClaimableBalanceCall,
          }),
        }),
      })),
    },
  };
});

describe('BigInt Stroop Conversion Calculations', () => {
  it('correctly parses integer XLM amounts to stroops', () => {
    expect(xlmToStroops('1')).toBe(10000000n);
    expect(xlmToStroops(10)).toBe(100000000n);
    expect(xlmToStroops(100n)).toBe(1000000000n);
  });

  it('correctly parses floating point XLM amounts to stroops without precision loss', () => {
    expect(xlmToStroops('10.5')).toBe(105000000n);
    expect(xlmToStroops('0.0000001')).toBe(1n);
  });

  it('correctly converts stroops to formatted XLM string representations', () => {
    expect(stroopsToXlm(10000000n)).toBe('1.0000000');
    expect(stroopsToXlm(105000000n)).toBe('10.5000000');
    expect(stroopsToXlm(1n)).toBe('0.0000001');
  });

  it('correctly handles zero and extreme/rounding edge cases', () => {
    expect(xlmToStroops('0')).toBe(0n);
    expect(xlmToStroops(0)).toBe(0n);
    expect(xlmToStroops('1.00000005')).toBe(10000000n); // sub-stroop precision is truncated
    expect(stroopsToXlm(0n)).toBe('0.0000000');
    expect(stroopsToXlm(1234567890123n)).toBe('123456.7890123');
  });

  it('documents the scientific-notation precision bug when 1e-7 is passed as a JS number', () => {
    // 0.0000001 and 1e-7 are the identical IEEE-754 float. Number#toString() renders ANY
    // JS number below 1e-6 in scientific notation (e.g. "1e-7"), and xlmToStroops does not
    // special-case that format before handing it to BigInt(), which cannot parse "1e-7".
    // Passing the STRING form ('0.0000001', tested above) works fine — only the bare NUMBER
    // form is affected. This is captured here as a known sharp edge, not a fix.
    expect(() => xlmToStroops(1e-7)).toThrow(/Cannot convert 1e-7 to a BigInt/);
    expect(() => xlmToStroops(0.0000001)).toThrow(/Cannot convert 1e-7 to a BigInt/);
  });

  it('correctly parses large XLM amounts (string and bigint) without overflow', () => {
    // 922,337,203.6854775 XLM ≈ Stellar's int64 stroop ceiling — exercised as a string
    // (the safe input type for large amounts) and as a bigint passthrough.
    expect(xlmToStroops('922337203.6854775')).toBe(9223372036854775n);
    expect(xlmToStroops('1000000000')).toBe(10000000000000000n);
    expect(xlmToStroops(123456789n)).toBe(1234567890000000n);
    expect(stroopsToXlm(9223372036854775n)).toBe('922337203.6854775');
  });
});

describe('Unit Tests with Mocked Horizon', () => {
  let coordinatorKeypair: Keypair;
  let agentKeypair: Keypair;
  let taskId: string;
  let envelopeXdr: string;
  let claimEnvelopeXdr: string;
  let originalSetTimeout: any;

  beforeAll(() => {
    coordinatorKeypair = Keypair.random();
    agentKeypair = Keypair.random();
    taskId = 'task_mock_123';

    // Build a mock envelope XDR containing a CreateClaimableBalance op with the memo
    const account = new Account(coordinatorKeypair.publicKey(), '123');
    const claimants = [
      new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
    ];
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: '10.0000000',
          claimants,
        })
      )
      .addMemo(Memo.text(taskId))
      .setTimeout(180)
      .build();
    tx.sign(coordinatorKeypair);
    envelopeXdr = tx.toEnvelope().toXDR('base64');

    // Build a second envelope sharing the SAME memo, but whose op[0] is claimClaimableBalance
    // rather than createClaimableBalance — used to verify resolveBalanceId's try/catch "skip
    // and continue" logic against a history record that should NOT resolve.
    const claimAccount = new Account(coordinatorKeypair.publicKey(), '124');
    const claimTx = new TransactionBuilder(claimAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId:
            '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be',
        })
      )
      .addMemo(Memo.text(taskId))
      .setTimeout(180)
      .build();
    claimTx.sign(coordinatorKeypair);
    claimEnvelopeXdr = claimTx.toEnvelope().toXDR('base64');

    // Speed up tests by skipping timeout delay
    originalSetTimeout = global.setTimeout;
    // @ts-ignore
    global.setTimeout = (fn: any) => fn();
  });

  afterAll(() => {
    global.setTimeout = originalSetTimeout;
  });

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockFetchBaseFee.mockReset();
    mockSubmitTransaction.mockReset();
    mockTransactionsCall.mockReset();
    mockClaimableBalanceCall.mockReset();

    // Set default resolutions using the imported Account class
    mockLoadAccount.mockImplementation((pubkey: string) => Promise.resolve(
      new Account(pubkey, '123')
    ));
    mockFetchBaseFee.mockResolvedValue(100);
    mockSubmitTransaction.mockResolvedValue({ hash: 'mock_tx_hash' });
    mockTransactionsCall.mockResolvedValue({ records: [] });
    mockClaimableBalanceCall.mockResolvedValue({ amount: '10.0000000' });
  });

  it('throws EscrowAlreadySettledError when releasePayment encounters a 404 from Horizon', async () => {
    // Mock getStellarConfig
    process.env.STELLAR_NETWORK = 'testnet';

    // Mock history to return the creation transaction
    mockTransactionsCall.mockResolvedValueOnce({
      records: [
        {
          memo_type: 'text',
          memo: taskId,
          envelope_xdr: envelopeXdr,
        },
      ],
    });

    // Mock claimableBalances call to return 404
    const err = new NotFoundError('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {},
      data: {},
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(err);

    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
    ).rejects.toThrow(EscrowAlreadySettledError);
  });

  it('retries up to 5 times on 429/504 status codes and then fails', async () => {
    // Mock loadAccount to fail with 429 status code
    const err429 = new Error('Rate limit exceeded');
    (err429 as any).response = {
      status: 429,
    };
    mockLoadAccount.mockRejectedValue(err429);

    await expect(
      lockEscrow(coordinatorKeypair, agentKeypair.publicKey(), '10.0000000', 'task_retry')
    ).rejects.toThrow('Rate limit exceeded');

    // Verify loadAccount was called 5 times due to retries
    expect(mockLoadAccount).toHaveBeenCalledTimes(5);
  });

  it('succeeds after transient errors resolve', async () => {
    // Mock loadAccount to fail twice with 504 (transient), then succeed
    const err504 = new Error('Gateway Timeout');
    (err504 as any).response = {
      status: 504,
    };
    mockLoadAccount
      .mockRejectedValueOnce(err504)
      .mockRejectedValueOnce(err504)
      .mockImplementationOnce((pubkey: string) => Promise.resolve(
        new Account(pubkey, '123')
      ));

    const hash = await lockEscrow(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      '10.0000000',
      'task_success_retry'
    );

    expect(hash).toBe('mock_tx_hash');
    expect(mockLoadAccount).toHaveBeenCalledTimes(3);
  });

  it('lockEscrow builds, signs and submits a createClaimableBalance transaction, returning the tx hash', async () => {
    const hash = await lockEscrow(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      '25.5',
      'task_plain_lock'
    );

    expect(hash).toBe('mock_tx_hash');
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);

    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.operations).toHaveLength(1);
    expect(submittedTx.operations[0].type).toBe('createClaimableBalance');
    expect(submittedTx.operations[0].amount).toBe('25.5000000');
  });

  it('lockEscrow rejects a taskId longer than the 28-byte Memo.text limit without contacting Horizon', async () => {
    const longTaskId = 'a'.repeat(29); // 29 bytes > 28-byte limit

    await expect(
      lockEscrow(coordinatorKeypair, agentKeypair.publicKey(), '1', longTaskId)
    ).rejects.toThrow('taskId exceeds the 28-byte Stellar Memo.text limit.');

    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it('lockEscrow falls back to a baseFee of 100 stroops when fetchBaseFee fails', async () => {
    mockFetchBaseFee.mockRejectedValueOnce(new Error('horizon fee endpoint unavailable'));

    const hash = await lockEscrow(
      coordinatorKeypair,
      agentKeypair.publicKey(),
      '1',
      'task_fee_fallback'
    );

    expect(hash).toBe('mock_tx_hash');
    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.fee).toBe('100'); // 1 operation × fallback baseFee of 100
  });

  it('releasePayment claims the balance and pays the agent, returning the tx hash', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '42.1234567' });

    const hash = await releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId);

    expect(hash).toBe('mock_tx_hash');
    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.operations).toHaveLength(2);
    expect(submittedTx.operations[0].type).toBe('claimClaimableBalance');
    expect(submittedTx.operations[1].type).toBe('payment');
    expect(submittedTx.operations[1].destination).toBe(agentKeypair.publicKey());
    // The paid amount comes from the live balance lookup, not a hardcoded value
    expect(submittedTx.operations[1].amount).toBe('42.1234567');
  });

  it('releasePayment propagates a non-404 error unrelated to settlement', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(new Error('horizon internal error'));

    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
    ).rejects.toThrow('horizon internal error');
  });

  it('refundEscrow claims the balance back to the coordinator, returning the tx hash', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '10.0000000' });

    const hash = await refundEscrow(coordinatorKeypair, taskId);

    expect(hash).toBe('mock_tx_hash');
    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.operations).toHaveLength(1);
    expect(submittedTx.operations[0].type).toBe('claimClaimableBalance');
  });

  it('refundEscrow throws EscrowAlreadySettledError when the balance is already claimed/refunded', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    const err = new NotFoundError('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: {},
      data: {},
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(err);

    await expect(refundEscrow(coordinatorKeypair, taskId)).rejects.toThrow(
      EscrowAlreadySettledError
    );
  });

  it('refundEscrow propagates a non-404 error unrelated to settlement', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
    });
    mockClaimableBalanceCall.mockRejectedValueOnce(new Error('horizon internal error'));

    await expect(refundEscrow(coordinatorKeypair, taskId)).rejects.toThrow(
      'horizon internal error'
    );
  });

  it('resolveBalanceId skips claim/refund history records sharing the memo and finds the original creation tx', async () => {
    // The claim-style record appears FIRST in history (desc order = most recent first),
    // ahead of the original creation record — resolveBalanceId must skip it via its
    // try/catch and continue scanning rather than failing on the first candidate.
    mockTransactionsCall.mockResolvedValueOnce({
      records: [
        { memo_type: 'text', memo: taskId, envelope_xdr: claimEnvelopeXdr },
        { memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr },
      ],
    });
    mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '10.0000000' });

    const hash = await refundEscrow(coordinatorKeypair, taskId);
    expect(hash).toBe('mock_tx_hash');
  });

  it('resolveBalanceId ignores history records with a different memo or non-text memo_type', async () => {
    mockTransactionsCall.mockResolvedValueOnce({
      records: [
        { memo_type: 'text', memo: 'unrelated_task', envelope_xdr: 'irrelevant' },
        { memo_type: 'hash', memo: taskId, envelope_xdr: 'irrelevant' },
        { memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr },
      ],
    });
    mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '10.0000000' });

    const hash = await refundEscrow(coordinatorKeypair, taskId);
    expect(hash).toBe('mock_tx_hash');
  });

  it('resolveBalanceId throws a descriptive error (not EscrowAlreadySettledError) when no creation tx exists for the taskId', async () => {
    mockTransactionsCall.mockResolvedValueOnce({ records: [] });

    await expect(
      releasePayment(coordinatorKeypair, agentKeypair.publicKey(), 'task_never_locked')
    ).rejects.toThrow(/No CreateClaimableBalance transaction found/);

    // Distinguish "never existed" from "already settled" — Horizon's claimableBalance
    // endpoint should never even be reached in this case
    expect(mockClaimableBalanceCall).not.toHaveBeenCalled();
  });

  describe('getEscrowBalance', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('throws when neither STELLAR_COORDINATOR_PUBLIC_KEY nor STELLAR_SECRET_KEY is configured', async () => {
      delete process.env.STELLAR_COORDINATOR_PUBLIC_KEY;
      delete process.env.STELLAR_SECRET_KEY;

      await expect(getEscrowBalance(taskId)).rejects.toThrow(
        'Either STELLAR_COORDINATOR_PUBLIC_KEY or STELLAR_SECRET_KEY must be set.'
      );
    });

    it('derives the lookup key from STELLAR_SECRET_KEY and returns the active escrow amount', async () => {
      delete process.env.STELLAR_COORDINATOR_PUBLIC_KEY;
      process.env.STELLAR_SECRET_KEY = coordinatorKeypair.secret();

      mockTransactionsCall.mockResolvedValueOnce({
        records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
      });
      mockClaimableBalanceCall.mockResolvedValueOnce({ amount: '7.5000000' });

      await expect(getEscrowBalance(taskId)).resolves.toBe(7.5);
    });

    it('returns 0 when the claimable balance has already been settled (404)', async () => {
      process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();

      mockTransactionsCall.mockResolvedValueOnce({
        records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
      });
      const err = new NotFoundError('Not Found', {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {},
        data: {},
      });
      mockClaimableBalanceCall.mockRejectedValueOnce(err);

      await expect(getEscrowBalance(taskId)).resolves.toBe(0);
    });

    it('returns 0 when no CreateClaimableBalance transaction was ever recorded for the taskId', async () => {
      process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();
      mockTransactionsCall.mockResolvedValueOnce({ records: [] });

      await expect(getEscrowBalance('task_never_locked')).resolves.toBe(0);
    });

    it('propagates unexpected, non-404 errors instead of silently returning 0', async () => {
      process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();
      mockTransactionsCall.mockResolvedValueOnce({
        records: [{ memo_type: 'text', memo: taskId, envelope_xdr: envelopeXdr }],
      });
      mockClaimableBalanceCall.mockRejectedValueOnce(new Error('horizon 500'));

      await expect(getEscrowBalance(taskId)).rejects.toThrow('horizon 500');
    });
  });
});

const describeIntegration =
  process.env.RUN_STELLAR_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeIntegration('Stellar Payment Layer Escrow Integration Tests', () => {
  let coordinatorKeypair: Keypair;
  let agentKeypair: Keypair;
  let taskId: string;

  beforeAll(async () => {
    // Generate a fresh keypair for coordinator and agent
    coordinatorKeypair = Keypair.random();
    agentKeypair = Keypair.random();
    taskId = `task_${Math.floor(Math.random() * 1000000000)}`;

    // Set environment variables required by getEscrowBalance
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_SECRET_KEY = coordinatorKeypair.secret();
    process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();

    // Fund coordinator and agent accounts using Stellar Friendbot
    const friendbotUrl1 = `https://friendbot.stellar.org/?addr=${coordinatorKeypair.publicKey()}`;
    const friendbotUrl2 = `https://friendbot.stellar.org/?addr=${agentKeypair.publicKey()}`;
    await Promise.all([axios.get(friendbotUrl1), axios.get(friendbotUrl2)]);
  });

  describe('Escrow Lock, Release, and Balance Cycle', () => {
    const amountXLM = '5.0000000';

    it('creates a claimable balance on Stellar testnet and queries its balance', async () => {
      // 1. Lock funds
      const lockTxHash = await lockEscrow(
        coordinatorKeypair,
        agentKeypair.publicKey(),
        amountXLM,
        taskId
      );
      expect(lockTxHash).toBeDefined();
      expect(typeof lockTxHash).toBe('string');

      // 2. Query balance (should return 5.0)
      const balance = await getEscrowBalance(taskId);
      expect(balance).toBe(5.0);

      // 3. Release funds
      const releaseTxHash = await releasePayment(
        coordinatorKeypair,
        agentKeypair.publicKey(),
        taskId
      );
      expect(releaseTxHash).toBeDefined();
      expect(typeof releaseTxHash).toBe('string');

      // 4. Query balance again (should be 0 because it is settled)
      const afterBalance = await getEscrowBalance(taskId);
      expect(afterBalance).toBe(0);

      // 5. Try release again; should throw EscrowAlreadySettledError
      await expect(
        releasePayment(coordinatorKeypair, agentKeypair.publicKey(), taskId)
      ).rejects.toThrow(EscrowAlreadySettledError);
    });
  });

  describe('Escrow Refund Cycle', () => {
    const refundTaskId = `task_${Math.floor(Math.random() * 1000000000)}`;
    const amountXLM = '3.5';

    it('refunds coordinator and prevents duplicate claims', async () => {
      // 1. Lock funds
      const lockTxHash = await lockEscrow(
        coordinatorKeypair,
        agentKeypair.publicKey(),
        amountXLM,
        refundTaskId
      );
      expect(lockTxHash).toBeDefined();

      // 2. Verify balance
      const balance = await getEscrowBalance(refundTaskId);
      expect(balance).toBe(3.5);

      // 3. Refund funds
      const refundTxHash = await refundEscrow(coordinatorKeypair, refundTaskId);
      expect(refundTxHash).toBeDefined();

      // 4. Verify balance is 0
      const afterBalance = await getEscrowBalance(refundTaskId);
      expect(afterBalance).toBe(0);

      // 5. Release should fail since it was refunded (settled)
      await expect(
        releasePayment(coordinatorKeypair, agentKeypair.publicKey(), refundTaskId)
      ).rejects.toThrow(EscrowAlreadySettledError);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Milestone-based partial escrow release (issue #841)
// ─────────────────────────────────────────────────────────────────────────────

describe('Milestone Escrow', () => {
  const coordinatorKeypair = Keypair.random();
  const agent1 = Keypair.random().publicKey();
  const agent2 = Keypair.random().publicKey();
  const agent3 = Keypair.random().publicKey();

  const milestoneTaskId = 'ms-task-001';
  const milestones = [
    { milestoneId: 'm1', agentAddress: agent1, amountXLM: 1.0 },
    { milestoneId: 'm2', agentAddress: agent2, amountXLM: 1.0 },
    { milestoneId: 'm3', agentAddress: agent3, amountXLM: 1.0 },
  ];

  function setupMocksForMilestone() {
    const fakeAccount = new Account(coordinatorKeypair.publicKey(), '100');
    mockLoadAccount.mockResolvedValue(fakeAccount);
    mockFetchBaseFee.mockResolvedValue(100);
    mockSubmitTransaction.mockResolvedValue({ hash: 'ms-tx-hash-' + Math.random() });
    mockTransactionsCall.mockResolvedValue({
      records: [
        {
          memo_type: 'text',
          memo: milestoneTaskId,
          envelope_xdr: (() => {
            const dummyAccount = new Account(coordinatorKeypair.publicKey(), '99');
            const tx = new TransactionBuilder(dummyAccount, {
              fee: '100',
              networkPassphrase: Networks.TESTNET,
            })
              .addOperation(
                Operation.createClaimableBalance({
                  asset: Asset.native(),
                  amount: '3.0000000',
                  claimants: [
                    new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
                  ],
                })
              )
              .addMemo(Memo.text(milestoneTaskId))
              .setTimeout(180)
              .build();
            tx.sign(coordinatorKeypair);
            return tx.toEnvelope().toXDR('base64');
          })(),
        },
      ],
    });
    mockClaimableBalanceCall.mockResolvedValue({ amount: '3.0000000' });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksForMilestone();
  });

  it('lockMilestoneEscrow locks the total of all milestone amounts', async () => {
    const txHash = await lockMilestoneEscrow(coordinatorKeypair, milestoneTaskId, milestones);
    expect(typeof txHash).toBe('string');
    expect(txHash.length).toBeGreaterThan(0);

    const status = getMilestoneStatus(milestoneTaskId);
    expect(status).toHaveLength(3);
    expect(status.every((m) => m.releasedAt === undefined)).toBe(true);
  });

  it('releaseMilestone releases only the specified milestone', async () => {
    await lockMilestoneEscrow(coordinatorKeypair, milestoneTaskId + '-2', [
      { milestoneId: 'm1', agentAddress: agent1, amountXLM: 1.0 },
      { milestoneId: 'm2', agentAddress: agent2, amountXLM: 1.0 },
      { milestoneId: 'm3', agentAddress: agent3, amountXLM: 1.0 },
    ]);

    // Update mock to return new taskId memo
    mockTransactionsCall.mockResolvedValue({
      records: [
        {
          memo_type: 'text',
          memo: milestoneTaskId + '-2',
          envelope_xdr: (() => {
            const dummyAccount = new Account(coordinatorKeypair.publicKey(), '99');
            const tx = new TransactionBuilder(dummyAccount, {
              fee: '100',
              networkPassphrase: Networks.TESTNET,
            })
              .addOperation(
                Operation.createClaimableBalance({
                  asset: Asset.native(),
                  amount: '3.0000000',
                  claimants: [
                    new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
                  ],
                })
              )
              .addMemo(Memo.text(milestoneTaskId + '-2'))
              .setTimeout(180)
              .build();
            tx.sign(coordinatorKeypair);
            return tx.toEnvelope().toXDR('base64');
          })(),
        },
      ],
    });

    const { alreadyReleased } = await releaseMilestone(
      coordinatorKeypair,
      milestoneTaskId + '-2',
      'm1'
    );
    expect(alreadyReleased).toBe(false);

    const status = getMilestoneStatus(milestoneTaskId + '-2');
    const m1 = status.find((m) => m.milestoneId === 'm1')!;
    const m2 = status.find((m) => m.milestoneId === 'm2')!;
    expect(m1.releasedAt).toBeDefined();
    expect(m2.releasedAt).toBeUndefined();
  });

  it('releaseMilestone is idempotent — second call returns alreadyReleased=true', async () => {
    const taskId = milestoneTaskId + '-idem';
    await lockMilestoneEscrow(coordinatorKeypair, taskId, [
      { milestoneId: 'm1', agentAddress: agent1, amountXLM: 1.0 },
    ]);

    mockTransactionsCall.mockResolvedValue({
      records: [
        {
          memo_type: 'text',
          memo: taskId,
          envelope_xdr: (() => {
            const dummyAccount = new Account(coordinatorKeypair.publicKey(), '99');
            const tx = new TransactionBuilder(dummyAccount, {
              fee: '100',
              networkPassphrase: Networks.TESTNET,
            })
              .addOperation(
                Operation.createClaimableBalance({
                  asset: Asset.native(),
                  amount: '1.0000000',
                  claimants: [
                    new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
                  ],
                })
              )
              .addMemo(Memo.text(taskId))
              .setTimeout(180)
              .build();
            tx.sign(coordinatorKeypair);
            return tx.toEnvelope().toXDR('base64');
          })(),
        },
      ],
    });

    await releaseMilestone(coordinatorKeypair, taskId, 'm1');
    const second = await releaseMilestone(coordinatorKeypair, taskId, 'm1');
    expect(second.alreadyReleased).toBe(true);
  });

  it('lockMilestoneEscrow rejects duplicate milestoneIds', async () => {
    await expect(
      lockMilestoneEscrow(coordinatorKeypair, 'dup-task', [
        { milestoneId: 'same', agentAddress: agent1, amountXLM: 1.0 },
        { milestoneId: 'same', agentAddress: agent2, amountXLM: 1.0 },
      ])
    ).rejects.toThrow('Duplicate milestoneIds');
  });

  it('getMilestoneStatus returns empty array for unknown taskId', () => {
    expect(getMilestoneStatus('nonexistent-task')).toEqual([]);
  });

  it('cancelMilestoneEscrow refunds unreleased milestones', async () => {
    const cancelTaskId = milestoneTaskId + '-cancel';
    await lockMilestoneEscrow(coordinatorKeypair, cancelTaskId, [
      { milestoneId: 'm1', agentAddress: agent1, amountXLM: 1.5 },
      { milestoneId: 'm2', agentAddress: agent2, amountXLM: 1.5 },
    ]);

    mockTransactionsCall.mockResolvedValue({
      records: [
        {
          memo_type: 'text',
          memo: cancelTaskId,
          envelope_xdr: (() => {
            const dummyAccount = new Account(coordinatorKeypair.publicKey(), '99');
            const tx = new TransactionBuilder(dummyAccount, {
              fee: '100',
              networkPassphrase: Networks.TESTNET,
            })
              .addOperation(
                Operation.createClaimableBalance({
                  asset: Asset.native(),
                  amount: '3.0000000',
                  claimants: [
                    new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
                  ],
                })
              )
              .addMemo(Memo.text(cancelTaskId))
              .setTimeout(180)
              .build();
            tx.sign(coordinatorKeypair);
            return tx.toEnvelope().toXDR('base64');
          })(),
        },
      ],
    });

    const refundHash = await cancelMilestoneEscrow(coordinatorKeypair, cancelTaskId);
    expect(typeof refundHash).toBe('string');
    // Milestone store entry should be cleared
    expect(getMilestoneStatus(cancelTaskId)).toEqual([]);
  });
});