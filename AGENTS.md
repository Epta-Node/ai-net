# 🤖 AGENTS.md — Contributor & Agent Guidelines

This document specifies repository instructions and conventions for developers and autonomous AI coding agents working on **ai-net**.

---

## 1. Architectural Principles

1. **Stellar-Native Invariants**:
   - Every on-chain mutation must perform strict authorization (`require_auth()`).
   - Store state in `Instance` storage for singleton configurations, or `Persistent`/`Temporary` for TTL-managed entity records.
   - Bounded gas and storage footprint: avoid unbounded vectors in contract storage; enforce pagination cursors on collections.
2. **Backend & Coordinator Invariants**:
   - Use asynchronous execution with idempotent task state tracking in PostgreSQL.
   - Enforce rate-limits, daily quotas per wallet, and prompt character boundaries before invoking Venice AI.
   - Wrap upstream LLM interactions in circuit breakers and exponential backoff.
3. **Frontend Invariants**:
   - Responsive, token-driven modern design.
   - Proper skeleton loading states and graceful error boundaries.
   - Follow [Frontend Architecture & Conventions](docs/FRONTEND_ARCHITECTURE.md) for folder structure, naming, and component patterns.

---

## 2. Commit & PR Hygiene for Agents

- Always use Conventional Commits (e.g. `feat(scope): description (#issue)`).
- Include detailed issue closing references in PR description (`Resolves #<issue-id>`).
- Preserve comments, existing architecture, and clean git histories.
- Never write hardcoded credentials, testnet private keys, or API tokens into source files.

---

## 3. Verification Commands

Before proposing code changes:

```bash
# 1. Smart Contracts
cd smart-contracts && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

# 2. Backend
cd backend && npm run lint && npm test

# 3. Frontend
cd frontend && npm run lint && npm run build
```
