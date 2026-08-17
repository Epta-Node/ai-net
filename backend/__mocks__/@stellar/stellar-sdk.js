// Automatic manual mock for @stellar/stellar-sdk
// Used when jest.mock('@stellar/stellar-sdk') is called in tests

const mockTx = {
  sign: jest.fn(),
  getClaimableBalanceId: jest.fn().mockReturnValue("balance-id-abc"),
};

const Keypair = {
  fromSecret: jest.fn().mockReturnValue({
    publicKey: () => "GCOORDINATOR",
    sign: jest.fn(),
  }),
  random: jest.fn().mockReturnValue({ publicKey: () => "GRANDOM", sign: jest.fn() }),
};

const Server = jest.fn().mockImplementation(() => ({
  loadAccount: jest.fn().mockResolvedValue({ id: "GCOORDINATOR", sequence: "1" }),
  submitTransaction: jest.fn().mockResolvedValue({ hash: "txhash-001" }),
}));

const Horizon = { Server };

const TransactionBuilder = jest.fn().mockImplementation(() => ({
  addOperation: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn().mockReturnValue(mockTx),
}));

const Operation = {
  createClaimableBalance: jest.fn().mockReturnValue({}),
  claimClaimableBalance: jest.fn().mockReturnValue({}),
};

const Asset = { native: jest.fn().mockReturnValue({}) };

const Claimant = Object.assign(
  jest.fn().mockReturnValue({}),
  { predicateUnconditional: jest.fn().mockReturnValue({}) }
);

const BASE_FEE = "100";
const Networks = { TESTNET: "Test SDF Network ; September 2015" };

module.exports = { Keypair, Server, Horizon, TransactionBuilder, Operation, Asset, Claimant, BASE_FEE, Networks };
