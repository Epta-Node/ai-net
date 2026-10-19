# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for ai-net.

ADRs document the context, decision, and consequences of significant architectural choices. They provide a historical record that helps new contributors understand _why_ the system is designed the way it is.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](./ADR-001-stellar-soroban-payments.md) | Use Stellar/Soroban for payments | Accepted |
| [ADR-002](./ADR-002-venice-ai-inference.md) | Use Venice AI for LLM inference | Accepted |
| [ADR-003](./ADR-003-sqlite-local-persistence.md) | SQLite over PostgreSQL for local persistence | Accepted |
| [ADR-004](./ADR-004-dag-task-decomposition.md) | DAG-based task decomposition | Accepted |
| [ADR-005](./ADR-005-sse-over-websockets.md) | Server-Sent Events over WebSockets | Accepted |
| [ADR-006](./ADR-006-typescript-rust-dual-language.md) | TypeScript + Rust dual-language codebase | Accepted |

## Template

New ADRs should follow this template:

```markdown
# ADR-NNN: Title

**Status:** Accepted | Superseded by ADR-XXX | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** (GitHub handles)

## Context
Problem statement and constraints.

## Decision
What was decided.

## Consequences
What becomes easier or harder as a result of this decision.
```

ADRs are numbered sequentially. Once accepted, an ADR is never deleted; if a
decision is reversed it is marked `Superseded by ADR-XXX`.
