# Test Fixtures

Shared deployment fixtures for Soroban smart-contract tests.

## Quick start

```ts
import { deployContracts, restoreSnapshot, type ContractFixtures } from './fixtures';

let fixtures: ContractFixtures;
let snapshot: string;

beforeAll(async () => {
  fixtures = await deployContracts();
  snapshot = await captureSnapshot(fixtures);
});

beforeEach(async () => {
  await restoreSnapshot(fixtures, snapshot);
});

it('uses the agent registry contract', () => {
  const registryId = fixtures.contractIds.agentRegistry;
  // … test logic using the pre-deployed contract
});
```

## Why shared deployment?

Without fixtures, each `beforeEach` deploys contracts from scratch:

```ts
// ❌ Slow — deploys every test
beforeEach(async () => {
  const result = await client.deploy(wasmBytes);
  contractId = result.contractId;
});
```

With shared deployment + snapshots, contracts are deployed once and each
test receives a clean copy of the initial state:

```ts
// ✅ Fast — deploy once, snapshot per test
beforeAll(async () => {
  fixtures = await deployContracts();
  snapshot = await captureSnapshot(fixtures);
});
beforeEach(async () => await restoreSnapshot(fixtures, snapshot));
```

## Available fixtures

| Fixture             | Purpose                                      |
|---------------------|----------------------------------------------|
| `deployContracts()` | Deploy all contracts once, return handles    |
| `captureSnapshot()` | Serialise current contract state             |
| `restoreSnapshot()` | Reset state to a captured snapshot           |

## CI mode

Set `DEPLOYED_CONTRACT_IDS` to a JSON map of pre-deployed contract IDs
to skip local deployment entirely:

```bash
DEPLOYED_CONTRACT_IDS='{"agentRegistry":"CDLZ...","errorResolver":"CA4B..."}' npm test
```

## Test categories

| Command                | Runs                            | Use in CI            |
|------------------------|---------------------------------|----------------------|
| `npm test`             | All tests                       | Full build on `main` |
| `npm run test:unit`    | Unit tests only (fast)          | Every PR             |
| `npm run test:integration` | Integration / E2E tests    | Merges to `main`     |
| `npm run test:e2e`       | Stellar testnet E2E only       | Scheduled / manual   |

## Writing new tests

1. **Unit tests**: mock the contract client (fast, deterministic).
2. **Integration tests**: use the real contract via fixtures, mark with
   `RUN_INTEGRATION_TESTS=true` guard.
3. **E2E tests**: deploy to Stellar testnet, gated behind
   `RUN_STELLAR_E2E_TESTS=true`.
