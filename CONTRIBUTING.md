# 🤝 Contributing to ai-net

Thank you for contributing to **ai-net**! We are building a decentralized autonomous agent network on the **Stellar blockchain** powered by **Venice AI**.

This handbook establishes our **Software Development Life Cycle (SDLC)**, branch naming rules, conventional commit standards, PR review checklists, testing guidelines, and commit hygiene expectations.

---

## Table of Contents

1. [Code of Conduct & Philosophy](#1-code-of-conduct--philosophy)
2. [Branch Naming Conventions](#2-branch-naming-conventions)
3. [Conventional Commits Specification](#3-conventional-commits-specification)
4. [Pull Request (PR) Workflow & Expectations](#4-pull-request-pr-workflow--expectations)
5. [Testing & Quality Verification](#5-testing--quality-verification)
6. [Review Checklist](#6-review-checklist)
7. [Agent & Contributor Guidelines (`AGENTS.md`)](#7-agent--contributor-guidelines)

---

## 1. Code of Conduct & Philosophy

- **High Quality over Quantity**: Every line of code should be tested, documented, and production-ready.
- **Safety on Stellar**: Smart contracts manage value. We adhere to defensive programming, minimal state footprint, and strict authorization patterns.
- **Deterministic & Modular**: AI Agent coordination workflows should be reproducible, idempotent, and resilient to LLM timeouts.

---

## 2. Branch Naming Conventions

All branches must follow standardized prefixes with an optional issue number:

| Type | Prefix Format | Example | Purpose |
|---|---|---|---|
| **Features** | `feat/<short-name>-<issue>` | `feat/paginated-registry-339` | New smart contract or backend feature |
| **Bug Fixes** | `fix/<short-name>-<issue>` | `fix/cursor-nonce-recovery-241` | Bug or edge-case resolution |
| **Documentation** | `docs/<topic>-<issue>` | `docs/node-operators-guide-342` | New or updated documentation |
| **Performance** | `perf/<optimization>-<issue>` | `perf/storage-compaction-335` | Gas optimization or caching improvements |
| **Refactoring** | `refactor/<name>` | `refactor/venice-client-pool` | Code restructuring without behavior changes |
| **Testing** | `test/<suite>-<issue>` | `test/e2e-escrow-flow-180` | Adding or fixing test suites |

```bash
# Example branch creation:
git checkout -b feat/agent-escrow-release-123 upstream/main
```

---

## 3. Conventional Commits Specification

Every commit message and PR title must adhere to [Conventional Commits 1.0.0](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description in present tense> (#<issue>)

[optional body explaining rationale, architectural decisions, and trade-offs]

[optional footer: Resolves #<issue>]
```

### Allowed Types

- `feat`: A new feature for users, agents, or smart contracts.
- `fix`: A bug fix.
- `docs`: Documentation only changes.
- `test`: Adding missing tests or correcting existing tests.
- `perf`: A code change that improves gas efficiency or execution speed.
- `refactor`: A code change that neither fixes a bug nor adds a feature.
- `chore`: Maintenance tasks, dependency bumps, or toolchain updates.
- `ci`: Changes to CI/CD workflows and automation scripts.

### Common Scopes
- `contracts`: Soroban smart contracts (`agent-registry`, `payment-escrow`, `error-resolver`, etc.).
- `backend`: Node.js/TypeScript coordinator, API routes, and database models.
- `frontend`: Next.js web application and dashboard.
- `sdk`: Client libraries.

### Commit Examples
- `feat(contracts): add paginated agent listing with cursor (#339)`
- `fix(backend): resolve nonce desynchronization on concurrent escrow releases (#214)`
- `docs: publish comprehensive user-facing node operators guide (#342)`

---

## 4. Pull Request (PR) Workflow & Expectations

### Step-by-Step Flow

1. **Fork & Branch**: Fork `Epta-Node/ai-net` to your GitHub account and cut a branch from `upstream/main`.
2. **Implement & Test Locally**: Ensure all tests, lints, and format checks pass.
3. **Commit Cleanly**: Use conventional commit messages. Avoid messy WIP commits.
4. **Open Pull Request**:
   - Title must follow Conventional Commits.
   - Use our `.github/pull_request_template.md`.
   - Link the relevant issue (e.g. `Resolves #346`).
5. **CI Automation**: All GitHub Actions workflows (`backend`, `contracts`, `contracts-lint`) must be green.

### Review Expectations & SLOs
- Maintainers aim to review active PRs within **24–48 hours**.
- Authors are expected to address review feedback within **3 business days**.

---

## 5. Testing & Quality Verification

### 5.1 Unified Quality Gate (Single Command)

We enforce a single comprehensive quality gate across all PRs. Run this single command before pushing:

```bash
npm run gate
# or
npm run check:quality
```

This single command automatically executes:
1. **Formatting check** (`prettier --check`)
2. **Linting** (`eslint` across backend and frontend)
3. **Type-checking** (`tsc --noEmit` across root, backend, and frontend)
4. **Test coverage thresholds** (Jest ≥75% coverage on backend, Vitest ≥70% coverage on frontend)

#### Individual Quality Sub-Commands
```bash
npm run format:check   # Prettier format check across all files
npm run format:fix     # Automatically fix formatting issues
npm run lint           # Run ESLint across backend and frontend
npm run typecheck      # Run tsc --noEmit across backend and frontend
npm run test:coverage  # Run test suites with coverage thresholds
```

### 5.2 Backend (Node.js & TypeScript)
```bash
cd backend
npm ci
npm run lint           # ESLint check
npm run typecheck      # TypeScript type check (tsc --noEmit)
npm test               # Unit test suite
npm run test:coverage  # Jest coverage with thresholds
```

### 5.3 Frontend (React & Vite)
```bash
cd frontend
npm ci
npm run lint           # ESLint check
npm run typecheck      # TypeScript type check (tsc --noEmit)
npm test               # Vitest unit test suite
npm run test:coverage  # Vitest coverage with thresholds
npm run build          # Production bundle compilation
```

### 5.4 Smart Contracts (Rust & Soroban)
```bash
cd smart-contracts
cargo fmt --all -- --check          # Formatting check
cargo clippy --all-targets -- -D warnings  # Clippy linter
cargo test                          # Contract unit tests
cargo build --target wasm32v1-none --release # Optimized Wasm build
```

---

## 6. Review Checklist

Before marking a PR as ready for review:

### For Authors
- [ ] PR title follows Conventional Commits format.
- [ ] Code builds without warnings (`cargo check`, `npm run build`).
- [ ] Unit test coverage covers happy paths, edge cases, and error boundaries.
- [ ] No secrets, keys, or `.env` files are tracked.
- [ ] Documentation updated if API or contract interfaces changed.

### For Reviewers
- [ ] Architecture aligns with system design and existing layers.
- [ ] Storage and gas costs on Soroban are bounded and minimized.
- [ ] Database queries are parameterized and indexed.
- [ ] Error messages are informative and do not leak internal credentials.

---

## 7. Agent & Contributor Guidelines

For AI coding agents and automated contributors, refer to [AGENTS.md](AGENTS.md) for strict architectural rules, toolchain conventions, and repository standards.
