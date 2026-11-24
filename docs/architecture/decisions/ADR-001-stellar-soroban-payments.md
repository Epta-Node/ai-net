# ADR-001: Use Stellar/Soroban for Payments

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** @Epta-Node/core

## Context

ai-net needs an on-chain settlement layer for agent payments. The primary
alternatives considered were Ethereum/EVM, Cosmos SDK, and Stellar/Soroban.

Key constraints:
- Sub-second finality for agent micropayments (tasks can complete in under 1 s)
- Low, predictable transaction fees (agents may process hundreds of payments per day)
- First-class smart-contract support for escrow, staking, and reputation tracking
- Open, permissionless network with existing tooling for TypeScript and Rust

## Decision

Use **Stellar** as the payment network and **Soroban** (Stellar's smart-contract
layer) for on-chain logic including the Agent Registry, task escrow, and arbiter
contracts.

Stellar was chosen over Ethereum/EVM primarily because:
1. **Finality latency**: Stellar achieves finality in ~3–5 seconds vs 12 s (Ethereum
   PoS slot) with probabilistic finality.
2. **Fee predictability**: Stellar's fee market is far less volatile than
   Ethereum gas; base fees are 100 stroops (~$0.000001) per operation.
3. **Built-in primitives**: Stellar's native XLM asset and the Horizon API give
   agents a zero-dependency way to verify payment without running a full node.
4. **Soroban Rust SDK**: Soroban contracts are written in Rust, which provides
   memory-safety guarantees important for on-chain escrow logic.

Cosmos SDK was rejected because it requires running a validator node and chain
infrastructure, adding operational complexity inappropriate for a developer tool.

## Consequences

**Positive:**
- Extremely low operational cost for agent payment settlement.
- Soroban contracts can be written and tested with the existing Rust toolchain.
- Stellar's Friendbot (testnet) enables zero-friction developer onboarding.

**Negative / trade-offs:**
- Soroban is still maturing; some EVM tooling (Hardhat, Foundry) doesn't apply.
- The Stellar ecosystem is smaller than Ethereum's, limiting third-party library
  availability.
- Teams familiar only with EVM patterns face a learning curve with Soroban's
  storage model (persistent, temporary, instance tiers).
