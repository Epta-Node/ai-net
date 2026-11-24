# Contributing to ai-net

Thank you for your interest in contributing to ai-net! This document covers everything you need to get started.

---

## Ways to Contribute

- Fix bugs or improve documentation
- Build a new specialized agent type
- Improve the Soroban smart contracts
- Write tests
- Open or triage issues

All contributions are welcome regardless of experience level.

---

## Drips Wave

ai-net participates in [Drips Wave](https://www.drips.network) organized by the Stellar Development Foundation. Issues tagged `wave` or `good first issue` are eligible for rewards funded by the Wave pool — free for contributors, free for maintainers.

→ [Browse Wave issues](../../issues?q=label%3Awave)

---

## Getting Started

### 1. Fork and clone

```bash
git clone https://github.com/YOUR_ORG/ai-net.git
cd ai-net
npm install
cp .env.example .env
```

### 2. Set up your environment

The Rust integration suite in step 3 needs only the Rust toolchain. For application flows that use Stellar signing and live Venice inference, configure the corresponding package environment.

```
STELLAR_SECRET_KEY=your_testnet_secret_key
VENICE_API_KEY=your_venice_api_key
STELLAR_NETWORK=testnet
```

Get a free Stellar testnet account at [laboratory.stellar.org](https://laboratory.stellar.org/#account-creator).  
Get a Venice AI key at [venice.ai](https://venice.ai).

### 3. Run tests

From the repository root, select the contract workspace and run the cross-contract flows on the local Soroban host. This suite uses Rust and Cargo and requires no wallet or API key.

```bash
cd smart-contracts
cargo test --locked -p integration-tests
```

For the live Testnet market report or contract deployment farm, use the commands, environment variables, runtime budgets, and CI job names in the [smart contract E2E guide](../docs/e2e-testing.md#smart-contract-integration-tests).

---

## Workflow

1. Check [ISSUES.md](ISSUES.md) or the [issue tracker](../../issues) for something to work on.
2. Comment on the issue to let others know you're working on it.
3. Create a branch: `git checkout -b feat/your-feature`
4. Make your changes and add tests where relevant.
5. Run `npm test` — all tests must pass.
6. Open a pull request against `main`.

---

## Pull Request Guidelines

- Keep PRs focused. One feature or fix per PR.
- Include a short description of what changed and why.
- Reference the related issue: `Closes #123`.
- Add or update tests for any changed behavior.

---

## Code Style

- TypeScript with strict mode enabled.
- `npm run lint` must pass before submitting.
- Prefer explicit types over `any`.

---

## Questions?

Open a [discussion](../../discussions) or comment on a relevant issue.
