# E2E Integration Testing Documentation

This document describes how to execute, extend, and maintain End-to-End (E2E) integration tests covering the Backend, Smart Contracts, Coordinator, and Stellar Network layers.

---

## Overview

The `ai-net` E2E test framework tests cross-cutting workflows end-to-end:
1. **Frontend / API layer**: Route handlers, parameter validation, request authentication.
2. **Backend Engine**: Database queries (SQLite), DAG task decomposition, event streaming.
3. **Coordinator**: Agent discovery and capability-based assignment.
4. **Smart Contracts**: Soroban `AgentRegistryContract` and `error-resolver` contracts.

---

## Running the E2E Suite

### Command Line
```bash
npm run test:e2e
```

### Coverage Generation
```bash
npm run test:e2e:coverage
```

Output is generated under `coverage-e2e/`.

---

## Docker Compose Infrastructure

`tests/e2e/docker-compose.test.yml` provisions:
- `stellar-standalone`: Local Stellar quickstart image with Soroban RPC enabled.
- `ai-net-backend`: Backend container running in test mode connected to the local Soroban node.

To launch standalone services manually:
```bash
docker-compose -f tests/e2e/docker-compose.test.yml up -d
```

---

## Fault Injection Suite (Issue #852)

Eight failure scenarios run in-process against the real app with injected
dispatch/payment seams — no docker, no external network:

| Suite | Scenarios |
|---|---|
| Agent failures | agent crash → job retry → task completes; capability unavailable → terminal failure; malformed agent output → retry, never poisons the pipeline |
| Payment / Horizon | escrow release failure → distinct `payment_failed` status within 30s; Horizon outage → clean termination + full recovery |
| Reconciliation | orphaned-escrow drift detected → remediation exercised → idempotent on re-run |
| Streaming & idempotency | SSE reconnect with `Last-Event-ID` → no duplicate events; same `Idempotency-Key` creates exactly one task |

Run it standalone (it is **excluded** from `npm run test:e2e` so its
job-queue retry backoff never slows the standard suite):

```bash
npm run test:fault
```

---

## Smart contract integration tests

Run the commands in this section from `smart-contracts/`. The root and contract packages both define `test:e2e` and select different suites.

| Suite | What it exercises | Environment and time budget |
| --- | --- | --- |
| Native Rust `integration-tests` | Registry and bidding, marketplace payments, oracle and task storage, dispute lifecycle | Rust and Cargo on the host. The Soroban SDK supplies the ledger, clock, and mock authorization. No runtime environment variables or network services are required. Allow minutes for the first compile and retain `target/` for repeat runs. |
| Jest market report | A five-node task DAG, real testnet payments, and release verification through Horizon | Node.js, npm dependencies, internet access to Friendbot and testnet Horizon. The suite estimates 60–120 seconds and sets a 120-second Jest timeout. |
| Live contract farm | Deploys Wasm and invokes contracts through Stellar RPC | Linux or equivalent Bash tooling, Rust with the Wasm target, Node.js, Stellar CLI, `jq`, `sha256sum`, and a funded testnet signer. Allow time for compilation and multiple ledger closes. Jest allows ten minutes per farm test and CI caps the whole job at 60 minutes. |

### Run on the local Soroban host

```bash
cargo test --locked -p integration-tests
# Run just the registry, bidding, and escrow flow
cargo test --locked -p integration-tests test_flow_registry_to_bidding_and_escrow
```

Cargo downloads the locked dependencies on the first build. Set `CARGO_BUILD_JOBS=1` on a memory-constrained machine. The tests register contracts in a fresh SDK environment and advance the ledger clock themselves. [Rust integration suite](../smart-contracts/tests/integration/src/lib.rs)

### Run the market-report E2E on Testnet

```bash
npm ci
npm run test:e2e
```

The package script sets `RUN_STELLAR_E2E_TESTS=true`. The suite reads `smart-contracts/.env` and preserves existing shell values. By default it generates a coordinator and agent and funds them with Friendbot. Optionally supply a testnet-only `STELLAR_COORDINATOR_SECRET` to reuse a coordinator or `STELLAR_HORIZON_URL` to select a testnet Horizon provider. The report uses a deterministic Venice fallback, so this local run needs no Venice key. [Market-report test](../smart-contracts/tests/e2e/market-report.test.ts)

### Run the live contract farm

Use a funded, disposable Testnet account and supply `STELLAR_SECRET_KEY` through your environment. From a shell with the contract package's npm dependencies installed, build the four artifacts using their workspace package names. The farm accepts prebuilt artifacts through `FARM_SKIP_BUILD`.

```bash
rustup target add wasm32v1-none
cargo build --locked --release --target wasm32v1-none \
  -p agent_registry -p agent-bidding -p error-registry -p task-store
STELLAR_NETWORK=testnet SOROBAN_CLI_BIN=stellar FARM_SKIP_BUILD=true npm run testnet:farm:run
```

The npm command sets `RUN_TESTNET_FARM=true`. Set `STELLAR_RPC_URL` and `STELLAR_HORIZON_URL` to override the testnet endpoints. The script writes deployed contract IDs, gas measurements, and JSON and Markdown reports under `testnet-farm-output/` by default. [Farm script](../smart-contracts/scripts/testnet-farm.sh)

### Contract coverage in CI

The change-filtered `contracts` job runs JavaScript unit tests and Cargo tests for an explicit package list. To exercise the native cross-contract crate, use the `-p integration-tests` command above. On main or manual dispatch the advisory `contracts-integration` job requires both `STELLAR_COORDINATOR_SECRET` and `VENICE_API_KEY` and sets `RUN_INTEGRATION_TESTS`. The market-report suite has its own opt-in flag, so a green integration job alone does not establish that it ran. [CI workflow](../.github/workflows/ci.yml)

The nightly workflow runs at 03:17 UTC, on manual dispatch, and on selected changes to main. It maps the Actions secret `STELLAR_TESTNET_FARM_SECRET` to `STELLAR_SECRET_KEY`, skips deployment when that secret is absent, and publishes the `testnet-farm-report` artifact when configured. [Nightly farm workflow](../.github/workflows/testnet-nightly.yml)

## Backend E2E in CI

The backend smoke and heavy jobs in the CI workflow select scenarios from the root Jest E2E suite. See the separate contract jobs above when checking coverage of a Soroban change. [CI workflow](../.github/workflows/ci.yml)
