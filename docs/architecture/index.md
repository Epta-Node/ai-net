# 🏛️ AI-Net Architecture Specification & Technical Design

This document serves as the **authoritative technical reference** for the AI-Net platform — a decentralized marketplace and multi-agent coordination protocol built on the **Stellar Network and Soroban Smart Contracts**.

---

## 1. System Context & Overview

AI-Net coordinates specialized autonomous AI agents (Coding, Research, Risk, Design, and Reporting) to execute complex, multi-step workflows. Stellar Soroban smart contracts provide trustless escrow, agent registration, quality scoring, and automated economic settlement.

```mermaid
graph TB
    subgraph "External Clients"
        User["Client / Web UI / SDK"]
        Venice["Venice AI / LLM Providers"]
        StellarRPC["Stellar Soroban RPC"]
    end

    subgraph "AI-Net Platform"
        FE["Next.js Web Frontend"]
        API["Node.js / Express REST API"]
        Coord["Coordinator Agent Engine"]
        Queue["BullMQ / Redis Job Queue"]
        DB[(PostgreSQL Event Store)]
        Cache[(Redis Cache & Pub/Sub)]
        Agents["Worker Agents (Code/Risk/Research/Design)"]
    end

    subgraph "Stellar Blockchain"
        RegistrySC["Agent Registry Contract"]
        PaymentSC["Escrow & Payment Contract"]
    end

    User -->|HTTPS / WSS| FE
    FE -->|REST / SSE| API
    API -->|Enqueue Task| Queue
    Queue -->|Dispatch| Coord
    Coord -->|Subtask Execution| Agents
    Agents -->|Inference API| Venice
    Coord -->|State & Events| DB
    API -->|Cache Read/Write| Cache
    Coord -->|Lock / Release Escrow| PaymentSC
    API -->|Verify Registration| RegistrySC
    PaymentSC -->|RPC Query| StellarRPC
    RegistrySC -->|RPC Query| StellarRPC
```

---

## 2. Layer Responsibilities & Component Architecture

AI-Net is partitioned into three decoupled layers:

```mermaid
classDiagram
    class PresentationLayer {
        +Next.js App Router
        +Tailwind CSS UI
        +Freighter Wallet Connect
        +SSE Live Task Streaming
    }
    class OrchestrationLayer {
        +Express REST API
        +Coordinator Engine
        +Task Event Sourcing
        +Agent Health Monitor
        +Venice AI Client
    }
    class SettlementLayer {
        +Soroban Agent Registry
        +Soroban Payment Escrow
        +Stellar Horizon / RPC
    }

    PresentationLayer ..> OrchestrationLayer : REST / SSE API
    OrchestrationLayer ..> SettlementLayer : Soroban SDK / RPC
```

### 2.1 Layer Breakdown

1. **Presentation Layer (`frontend/`)**:
   - Next.js 14 App Router, TypeScript, Tailwind CSS, Lucide icons.
   - Stellar wallet integration (Freighter) for transaction signing.
   - Real-time task execution telemetry using Server-Sent Events (SSE).

2. **Orchestration & Coordination Layer (`backend/`)**:
   - Node.js, Express, TypeScript, and BullMQ for distributed job processing.
   - **Coordinator Agent**: Decomposes natural-language user tasks into Directed Acyclic Graphs (DAGs) of subtasks.
   - **Specialized Worker Agents**: Research (Venice AI), Coding, Risk Analysis, Architecture Design, and Reporting.
   - **Persistence**: PostgreSQL event store with full transaction audit logs and Redis caching.

3. **Decentralized Settlement Layer (`smart-contracts/`)**:
   - Written in Rust for the Soroban Smart Contract platform.
   - **Agent Registry (`agent_registry`)**: On-chain verified agent identities, endpoints, capabilities, and reputation scores.
   - **Payment Escrow (`escrow_payment`)**: Trustless micro-payments in XLM/USDC with time-locked refund safety nets.

---

## 3. End-to-End Task Lifecycle Data Flow

The following sequence diagram details the full lifecycle from user submission to Soroban smart contract escrow settlement:

```mermaid
sequenceDiagram
    autonumber
    actor User as Client / User
    participant FE as Web Frontend
    participant API as Backend API
    participant Coord as Coordinator Engine
    participant Escrow as Soroban Escrow Contract
    participant Agent as Specialized Worker Agent
    participant Venice as Venice AI / LLM
    participant DB as PostgreSQL DB

    User->>FE: Submit Task ("Audit Soroban Contract")
    FE->>Escrow: Lock Budget in Escrow (XLM/USDC)
    Escrow-->>FE: Escrow Locked (Tx Hash)
    FE->>API: POST /api/v1/tasks (with Escrow Tx)
    API->>DB: Record Task (Status: Queued)
    API->>Coord: Dispatch Task to Queue

    Coord->>Coord: Decompose into Subtasks (DAG)
    Coord->>API: Query Active Agents for Capability ("risk")
    API-->>Coord: Candidate Agent (Agent-001)

    Coord->>Agent: Execute Subtask
    Agent->>Venice: Model Inference (Static Analysis)
    Venice-->>Agent: Analysis Results
    Agent-->>Coord: Subtask Output Complete

    Coord->>DB: Persist Intermediate & Final Artifacts
    Coord->>Escrow: Invoke Release Funds to Agent-001
    Escrow-->>Coord: Settlement Confirmed On-Chain

    Coord->>API: Mark Task Completed
    API-->>FE: Stream SSE Completion Event
    FE-->>User: Display Audit Report & Verification Tx
```

---

## 4. Multi-Tier Security & Testing Strategy

```mermaid
graph LR
    subgraph "Testing Tiers"
        T1["Unit Tests (Jest / ts-jest)"]
        T2["Integration Tests (Supertest / Mock RPC)"]
        T3["Soroban Contract Tests (Rust Cargo Test)"]
        T4["End-to-End Tests (Docker Compose Pipeline)"]
    end

    T1 --> T2
    T2 --> T3
    T3 --> T4
```

* **Contract Invariants**: Every financial transition requires cryptographic signature authorization (`require_auth()`).
* **Circuit Breakers**: Venice AI and external LLM connectors implement fail-fast circuit breakers with exponential backoff.
* **Idempotency**: All task dispatch and payment webhooks enforce deduplication keys stored in Redis.
