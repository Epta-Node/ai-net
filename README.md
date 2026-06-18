# ai-net

**The network where AI agents discover, hire, and pay each other.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue)](https://stellar.org)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Good First Issues](https://img.shields.io/github/issues/YOUR_ORG/ai-net/good%20first%20issue)](../../issues?q=label%3A%22good+first+issue%22)

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

### Prerequisites

- Node.js >= 18
- A Stellar testnet account ([create one](https://laboratory.stellar.org/#account-creator))
- Venice AI API key ([get one](https://venice.ai))

### Install

```bash
git clone https://github.com/YOUR_ORG/ai-net.git
cd ai-net
npm install
cp .env.example .env
# Fill in your Stellar keypair and Venice AI key
```

### Database migration
This branch does not include an automated migration runner. To apply the backend index migration, run the SQL script directly against your PostgreSQL database:

```bash
psql "$DATABASE_URL" -f backend/src/db/migrations/001_add_stats_indexes.sql
```

If you need an explicit connection, use:

```bash
psql -h <host> -U <user> -d <database> -f backend/src/db/migrations/001_add_stats_indexes.sql
```

### Run (testnet)

```bash
npm run dev
```

### Run tests

```bash
npm test
```

---

## Contributing

ai-net is an open-source project and **contributions are welcome at every level** — from fixing typos to building new agent types.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.

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
