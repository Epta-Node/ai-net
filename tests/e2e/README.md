# End-to-End (E2E) Integration Testing Framework

This directory contains the full-stack End-to-End integration test suite for `ai-net`, verifying seamless interaction between:
- **Backend API & DB** (Node.js/Express + SQLite)
- **Coordinator Engine** (DAG decomposition & agent assignment)
- **Smart Contracts** (`AgentRegistryContract` & `error-resolver` Soroban contracts)
- **Stellar Network** (Local Standalone / Testnet Soroban RPC)

---

## Directory Structure

```
tests/e2e/
├── docker-compose.test.yml         # Local Stellar node + backend container orchestration
├── jest.config.js                  # E2E Jest configuration
├── setup.ts                        # Global test setup (deploy contracts, reset state)
├── teardown.ts                     # Global test cleanup
├── helpers.ts                      # Shared test helpers & Soroban contract emulator
├── scenario-a-registration.test.ts # Scenario A: Agent Registration Flow
├── scenario-b-task-lifecycle.test.ts# Scenario B: Task Assignment, Execution, & Error Recording
└── scenario-c-agent-removal.test.ts # Scenario C: Agent Removal Cascades & Error Cleanup
```

---

## Test Scenarios

### Scenario A: Agent Registration Flow
- Deploys contracts to local/simulated Stellar network.
- Starts backend with contract configuration.
- Executes `POST /api/agents/register` with agent details.
- Verifies agent registration in Soroban on-chain storage.
- Verifies agent persistence in backend SQLite database and availability via `GET /api/agents`.

### Scenario B: Task Lifecycle & Error Recording
- Registers 2 specialist agents on-chain and in DB (`research` and `coding`).
- Creates a multi-stage task via `POST /api/tasks`.
- Verifies coordinator assigns DAG sub-tasks to matching registered agents.
- Tracks execution and simulates an agent execution error.
- Verifies error details are stored in the on-chain `error-resolver` smart contract.

### Scenario C: Agent Removal Cascades
- Registers an ephemeral agent on-chain and records errors in `error-resolver`.
- Issues `DELETE /api/agents/:id` request with challenge signature.
- Verifies agent is deleted from backend database.
- Verifies agent deregistration on-chain.
- Verifies cascading cleanup of agent error entries from the `error-resolver` contract.

---

## Running Tests Locally

### Quick Start
Run all E2E integration tests:
```bash
npm run test:e2e
```

Run E2E integration tests with coverage report:
```bash
npm run test:e2e:coverage
```

### Running with Docker Compose (Local Stellar Standalone Node)
To spin up a local Stellar standalone validator alongside the backend:
```bash
docker-compose -f tests/e2e/docker-compose.test.yml up --build
```

---

## Writing New E2E Tests

1. Create a new test file in `tests/e2e/` named `scenario-x-feature.test.ts`.
2. Import `createTestApp`, `onChainContracts`, and `createE2ETestKeypair` from `./helpers`.
3. Setup `beforeAll` / `afterAll` hooks to manage backend server lifecycle.
4. Interact with the backend API via `supertest` and verify state on `onChainContracts`.
