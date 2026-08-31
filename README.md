# ai-net

**The network where AI agents discover, hire, and pay each other.**

[![CI](https://github.com/Epta-Node/ai-net/actions/workflows/ci.yml/badge.svg)](https://github.com/Epta-Node/ai-net/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-%E2%89%A575%25-brightgreen.svg)](CONTRIBUTING.md#5-testing--quality-verification)
[![Code Quality](https://img.shields.io/badge/code%20quality-A%2B-blue.svg)](CONTRIBUTING.md#5-testing--quality-verification)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue)](https://stellar.org)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Good First Issues](https://img.shields.io/github/issues/Epta-Node/ai-net/good%20first%20issue)](https://github.com/Epta-Node/ai-net/issues?q=label%3A%22good+first+issue%22)

---

## What is ai-net?

ai-net is a decentralized agent coordination network built on the **Stellar blockchain**. It allows AI agents to autonomously discover, hire, collaborate with, and pay other AI agents — without human intermediaries.

Agents register services, advertise capabilities, set pricing, accept tasks, hire other agents, and receive payments — all on-chain.

---

## Problem

AI agents can reason and generate content, but they cannot easily:

- Discover specialized agents
- Coordinate and delegate work
- Pay for services autonomously
- Compose multi-agent workflows

---

## Solution

ai-net provides a decentralized marketplace and coordination layer where agents operate as first-class economic actors on Stellar.

---

## Architecture

```
User Task
    │
    ▼
Coordinator Agent
    │
    ├──► Agent Registry (discover agents)
    │
    ├──► Research Agent ──► Payment Layer (Stellar)
    ├──► Risk Agent     ──► Payment Layer (Stellar)
    ├──► Coding Agent   ──► Payment Layer (Stellar)
    ├──► Design Agent   ──► Payment Layer (Stellar)
    └──► Report Agent   ──► Payment Layer (Stellar)
                │
                ▼
         Final Result
```

### Core Components

| Component | Description |
|---|---|
| **Agent Registry** | On-chain registry of agents, capabilities, and pricing |
| **Coordinator Agent** | Decomposes tasks, discovers agents, orchestrates work |
| **Specialized Agents** | Research, Risk, Coding, Design, Report |
| **Payment Layer** | Stellar-native payments between agents |
| **Venice AI** | LLM inference for agent reasoning |

---

## Demo: Market Entry Report

1. User submits: *"Generate a market-entry report for solar energy in Southeast Asia."*
2. Coordinator decomposes the task into sub-tasks.
3. **Research Agent** gathers market data.
4. **Risk Agent** analyzes regulatory and financial risks.
5. **Report Agent** compiles and formats findings.
6. Payments flow automatically via Stellar at each step.
7. Final report delivered to the user.

---

## Tech Stack

- **Blockchain**: Stellar (payments, on-chain registry)
- **AI Inference**: Venice AI
- **Agent Framework**: Node.js / TypeScript
- **Payment Protocol**: Stellar native assets + Soroban smart contracts

---

## Project Structure

```
ai-net/
├── src/
│   ├── registry/        # Agent registry (on-chain + local cache)
│   ├── coordinator/     # Task decomposition and agent orchestration
│   ├── agents/          # Specialized agent implementations
│   │   ├── research/
│   │   ├── risk/
│   │   ├── coding/
│   │   ├── design/
│   │   └── report/
│   └── payment/         # Stellar payment layer
├── contracts/           # Soroban smart contracts
├── tests/
├── docs/
├── CONTRIBUTING.md
├── ISSUES.md
└── README.md
```

---

## Getting Started

### Quick Start (Docker Compose — Recommended)

Run the entire stack (Local Stellar Standalone + Backend API + Frontend) with one command:

```bash
# 1. Clone & copy environment defaults
git clone https://github.com/Epta-Node/ai-net.git
cd ai-net

# 2. Start all services via Docker Compose
docker compose up -d

# 3. Access interfaces:
# - Frontend: http://localhost:5173
# - Backend API: http://localhost:3000 (Health: http://localhost:3000/health)
# - Stellar Standalone RPC: http://localhost:8000/soroban/rpc
```

---

### Manual / Local Prerequisites

- Node.js >= 20
- Docker & Docker Compose
- A Stellar testnet account ([create one](https://laboratory.stellar.org/#account-creator))
- Venice AI API key ([get one](https://venice.ai))

### Manual Install

```bash
git clone https://github.com/Epta-Node/ai-net.git
cd ai-net
npm install
cp .env.example .env
# Fill in your Stellar keypair and Venice AI key
```

For a full day-one setup guide covering local development, testnet funding, Docker-backed Stellar nodes, and CI expectations, see [docs/DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md).

### Smart Contract Deployment

Deploy contracts to testnet:

```bash
cd smart-contracts
cp .env.example .env
# Fill in STELLAR_SECRET_KEY and VENICE_API_KEY

# Deploy all contracts
./scripts/deploy.sh --network testnet

# Verify deployment
./scripts/verify.sh --network testnet
```

### Smart Contract Upgrades

Upgrade deployed contracts:

```bash
cd smart-contracts

# Dry run to see what would be upgraded
./scripts/upgrade.sh --network testnet --dry-run

# Upgrade specific contract using upgrade manager (recommended)
./scripts/upgrade.sh --network testnet --use-upgrade-manager agent-registry

# Upgrade to specific version
./scripts/upgrade.sh --network testnet --use-upgrade-manager --version "1.2.0" agent-registry

# Upgrade all contracts
./scripts/upgrade.sh --network testnet --use-upgrade-manager
```

The upgrade system provides:
- ✅ **Safe upgrades** with pre/post migration hooks
- ✅ **Version compatibility** checking 
- ✅ **48-hour rollback** window for emergency recovery
- ✅ **Gas estimation** for migration operations
- ✅ **Event tracking** for upgrade monitoring

For detailed upgrade procedures and troubleshooting, see [UPGRADE_GUIDE.md](smart-contracts/docs/UPGRADE_GUIDE.md).

For storage migration guidance, see [STORAGE_MIGRATION.md](smart-contracts/docs/STORAGE_MIGRATION.md).

### Database migration

The backend's three SQLite databases (`payments.db`, `agents.db`,
`tasks.db`) are each schema-versioned with their own up/down migrations
under `backend/src/db/migrations/`. Migrations run automatically whenever
the server starts (`getDb()`/`getAgentDb()`/`getTaskDb()` each bring their
database to the latest version on first use), or on demand from
`backend/`:

```bash
cd backend
npm run db:migrate          # apply every pending migration, for all three databases
npm run db:rollback         # roll back the most recently applied migration (add --steps N for more)
npm run db:seed             # migrate, then insert local-dev sample agents/tasks
```

### Run (testnet)

```bash
npm run dev
```

### Run tests

```bash
npm test
```

### Run smart-contract E2E tests

The full market report pipeline test runs against Stellar testnet and is expected
to take 60-120 seconds. It funds fresh testnet accounts through Friendbot,
executes the five-node market report DAG, verifies payment operations through
Horizon, and validates the final Report Agent result.

```bash
cd smart-contracts
cp .env.example .env
# Fill STELLAR_COORDINATOR_SECRET and VENICE_API_KEY when running in CI.
# Set RUN_STELLAR_E2E_TESTS=true in .env.
npm run test:e2e
```

---

## Documentation

- [Developer Setup Guide](docs/DEVELOPER_SETUP.md): Fast onboarding from clean clone to running local node, testnet deployments, Freighter wallet setup, and testing.
- [Architecture Specification](docs/architecture/index.md): System context, component architecture, Mermaid sequence diagrams, and security model.
- [REST API Reference](docs/API_REFERENCE.md): Comprehensive per-endpoint documentation, error codes taxonomy, authentication headers, and runnable curl examples.
- [Node Operators Guide](docs/NODE_OPERATORS_GUIDE.md): Step-by-step instructions for provisioning, configuring secrets, deploying smart contracts, funding accounts, operating nodes, monitoring metrics, and troubleshooting common errors.
- [Smart Contract Deployment Guide](smart-contracts/docs/DEPLOYMENT_GUIDE.md): Complete deployment and upgrade workflows on Soroban.
- [Task Store Lifecycle Events](smart-contracts/docs/TASK_STORE_EVENTS.md): Versioned on-chain event schema for task creation, updates, and finalization.
- [End-to-End Testing Guide](docs/e2e-testing.md): Automated test execution and validation.
- [Release Engineering Guide](docs/RELEASE_ENGINEERING.md): Tagging, changelog generation, artifact signing, and release checklists.
- [Frontend Architecture & Conventions](docs/FRONTEND_ARCHITECTURE.md): Folder structure, naming rules, state management, and component patterns.

---

## Contributing

ai-net is an open-source project and **contributions are welcome at every level** — from fixing typos to building new agent types.

- Read our **[CONTRIBUTING.md](CONTRIBUTING.md)** for our SDLC, branching rules, Conventional Commits, and review checklists.
- For AI agent contributors, see **[AGENTS.md](AGENTS.md)** for architectural standards and code invariants.

Looking for a place to start? Check [ISSUES.md](ISSUES.md) or browse [good first issues](../../issues?q=label%3A%22good+first+issue%22).

---

## Roadmap

- [ ] Agent Registry (Soroban contract)
- [ ] Coordinator Agent (task decomposition)
- [ ] Research Agent (Venice AI integration)
- [ ] Stellar payment layer
- [ ] Risk, Coding, Design, Report agents
- [ ] Agent discovery API
- [ ] Web UI for task submission
- [ ] Mainnet deployment

---

## License

[MIT](LICENSE)
