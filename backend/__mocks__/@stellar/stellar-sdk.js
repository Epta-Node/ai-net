// Manual mock for @stellar/stellar-sdk (wired up via moduleNameMapper in
// jest.config.js, so every unit-test import resolves here).
//
// Keypair is backed by *real* Ed25519 keys derived from a seed string, because
// the agent-ownership routes (#557, #558) verify signatures in production code
// and a test that passes against a stubbed `verify()` proves nothing. Seed →
// public-key material is deterministic, so a test can create a keypair for a
// secret, hand the resulting `G…` account id to the server, and have the
// server's own `Keypair.fromPublicKey()` verify the signature for real.

const crypto = require("crypto");

const mockTx = {
  sign: jest.fn(),
  getClaimableBalanceId: jest.fn().mockReturnValue("balance-id-abc"),
};

/** Real ed25519 keypairs, indexed by the account id string that identifies them. */
const keypairsByPublicKey = new Map();

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Ed25519 PKCS#8 header; the 32-byte seed is appended verbatim. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** Render 32 bytes as a Stellar-shaped account id: `G` + 55 base32 characters. */
function toAccountId(bytes) {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let accountId = "G";
  for (let i = 0; i < 55; i++) {
    accountId += BASE32_ALPHABET[Number(value % 32n)];
    value /= 32n;
  }
  return accountId;
}

function deriveEd25519(seedString) {
  const seed = crypto.createHash("sha256").update(seedString, "utf8").digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    privateKey,
    publicKey: crypto.createPublicKey(privateKey),
    accountId: toAccountId(seed),
  };
}

/**
 * Resolve (or mint) the keypair behind `identifier`.
 *
 * `fromSecret(secret)` and `fromPublicKey(accountId)` must land on the *same*
 * key, so an id is first looked up verbatim and only derived when unknown: a
 * secret resolves to the account id it produces, which is then indexed under
 * that id. An account id nobody has signed with yet derives its own key, which
 * is what makes "signed by the wrong key" fail verification rather than throw.
 */
function resolveKeypair(identifier) {
  const known = keypairsByPublicKey.get(identifier);
  if (known) return known;

  const derived = deriveEd25519(identifier);
  keypairsByPublicKey.set(derived.accountId, derived);
  return derived;
}

function makeKeypair(identifier) {
  const resolved = resolveKeypair(identifier);
  const accountId = resolved.accountId;

  return {
    publicKey: () => accountId,
    secret: () => accountId,
    sign: (data) => crypto.sign(null, Buffer.from(data), resolved.privateKey),
    verify: (data, signature) => {
      try {
        return crypto.verify(
          null,
          Buffer.from(data),
          resolved.publicKey,
          Buffer.from(signature),
        );
      } catch {
        return false;
      }
    },
  };
}

const Keypair = {
  fromSecret: jest.fn((secret) => makeKeypair(secret)),
  fromPublicKey: jest.fn((publicKey) => makeKeypair(publicKey)),
  random: jest.fn(() => makeKeypair(crypto.randomBytes(16).toString("hex"))),
};

const Server = jest.fn().mockImplementation(() => ({
  loadAccount: jest
    .fn()
    .mockResolvedValue({ id: "GCOORDINATOR", sequence: "1" }),
  submitTransaction: jest.fn().mockResolvedValue({ hash: "txhash-001" }),
  claimableBalances: jest.fn().mockReturnValue({
    claimableBalance: jest.fn().mockReturnValue({
      call: jest
        .fn()
        .mockResolvedValue({
          id: "cb-1",
          amount: "1.0000000",
          asset: "native",
          sponsor: "GCOORDINATOR",
          claimants: [{ destination: "GAGENT" }],
        }),
    }),
    forAsset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records: [] }),
  }),
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

const Claimant = Object.assign(jest.fn().mockReturnValue({}), {
  predicateUnconditional: jest.fn().mockReturnValue({}),
});

const BASE_FEE = "100";
const Networks = { TESTNET: "Test SDF Network ; September 2015" };

module.exports = {
  Keypair,
  Server,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
  BASE_FEE,
  Networks,
};
