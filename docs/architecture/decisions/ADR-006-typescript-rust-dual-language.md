# ADR-006: TypeScript + Rust Dual-Language Codebase

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** @Epta-Node/core

## Context

ai-net spans two distinct execution environments:
1. **Application layer** — backend API server, coordinator logic, frontend UI.
2. **Smart-contract layer** — on-chain Soroban contracts for agent registry,
   task storage, escrow, arbiter, and payment routing.

The application layer requires a high-productivity language with a rich
ecosystem for HTTP, SQLite, and AI APIs. The smart-contract layer requires
a language that compiles to WebAssembly (WASM) with deterministic execution
and no garbage collector.

## Decision

Use **TypeScript** for the application layer (`backend/`, `frontend/`,
`tests/`) and **Rust** for the smart-contract layer (`smart-contracts/`).

**TypeScript** for the application layer because:
- Largest ecosystem for HTTP servers (Express/Fastify), SQLite, and the
  OpenAI-compatible SDK.
- Static typing catches integration errors at compile time without runtime
  overhead.
- Frontend (React) and backend share type definitions, reducing duplication.
- Most web developers already know JavaScript/TypeScript, lowering the
  contribution barrier.

**Rust** for smart contracts because:
- Soroban's official SDK (`soroban-sdk`) is Rust-only.
- Rust compiles to WASM with a minimal runtime — no GC pauses, predictable
  execution costs.
- Rust's ownership model prevents common smart-contract bugs (reentrancy,
  integer overflow) at compile time.
- `cargo test` + `soroban-sdk`'s mock environment gives deterministic,
  fast unit tests without a live blockchain.

Full Go/Python/other alternatives were rejected because they either lack a
Soroban SDK, have a larger WASM binary footprint, or would fragment the
contribution community.

## Consequences

**Positive:**
- Each language is best-in-class for its layer; no compromise on tooling.
- Rust contracts provide strong safety guarantees for funds-handling code.
- TypeScript and Rust share the Stellar SDK concepts (keypairs, transactions)
  via their respective SDKs, keeping mental model alignment.

**Negative / trade-offs:**
- Contributors need two language toolchains (Node.js + Rust) for full-stack
  work; the `DEVELOPER_SETUP.md` documents both.
- Contract ABI changes require coordinated updates in both the Rust contract
  and the TypeScript client bindings (`backend/src/stellar/contracts/`).
- CI must maintain both `npm` caches and `cargo` caches, adding pipeline
  complexity (addressed in ADR-851 / `.github/workflows/ci.yml`).
