# 🏛️ Timelock Multisig Governance Architecture Specification

This document details the **Governance & Timelock Module** for AI-Net (Issue #386). Single-key administration presents a systemic risk to decentralized multi-agent platforms. This module enforces a multi-signature quorum, deterministic timelock delays, proposal lifecycle state machines, and emergency circuit breakers across all smart contracts.

---

## 1. Governance Architecture Overview

```
                          ┌──────────────────────────┐
                          │   Multisig Signers (N)   │
                          └─────────────┬────────────┘
                                        │
                         1. Propose / Vote (M-of-N)
                                        │
                                        ▼
                          ┌──────────────────────────┐
                          │    Governance Module     │
                          │   (Proposal Registry)    │
                          └─────────────┬────────────┘
                                        │
                                2. Enforce Timelock
                                (e.g. 48h / 34,560 ledgers)
                                        │
                                        ▼
                          ┌──────────────────────────┐
                          │     Timelock Queue       │
                          │  [Ready / Executable]    │
                          └─────────────┬────────────┘
                                        │
                                3. Execute via Router
                                        │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│Agent Registry│        │ Task Store   │        │Upgrade Mgr   │
└──────────────┘        └──────────────┘        └──────────────┘
```

---

## 2. Proposal Lifecycle State Machine

A governance proposal transitions through the following formal states:

```
[Draft / Proposed] ──► [Active Voting] ──► [Defeated] (if quorum fails)
                             │
                      (Quorum Reached)
                             │
                             ▼
                        [Queued] ──► [Timelock Window: Delay T]
                             │
                             ▼
                        [Executable] ──► [Executed]
                             │
                      (Grace Period Expired)
                             │
                             ▼
                         [Expired]
```

### State Definitions:
1. **Proposed**: Signer initiates a proposal with target contract, function name, and serialized arguments.
2. **Active**: Signers submit approvals. Requires $M$ of $N$ signatures where $M \ge \lceil N \times \text{QuorumPercentage} \rceil$.
3. **Queued**: Once quorum is met, proposal enters the timelock queue. Execution is locked until `eta_ledger = current_ledger + min_delay_ledgers`.
4. **Executable**: Timelock delay has elapsed. Any authorized signer can trigger execution within the grace window.
5. **Executed**: Action is dispatched to target contract via the governance dispatcher.
6. **Canceled**: Admin threshold can cancel pending proposals before execution.

---

## 3. Configuration & Parameters

| Parameter | Recommended Testnet | Production Default | Description |
|---|---|---|---|
| **Min Timelock Delay** | `120 ledgers` (~10 min) | `34,560 ledgers` (48 hours) | Minimum wait before queued proposal execution |
| **Max Timelock Delay** | `86,400 ledgers` (~5 days) | `172,800 ledgers` (10 days) | Upper bound on execution delay |
| **Execution Grace Period** | `17,280 ledgers` (~24 hours) | `34,560 ledgers` (48 hours) | Window in which proposal remains executable |
| **Quorum Threshold** | `3-of-5 (60%)` | `4-of-7 (57%)` | Minimum positive votes required to queue |
| **Emergency Threshold** | `4-of-5 (80%)` | `6-of-7 (85%)` | Supermajority required for 0-delay security pauses |

---

## 4. Emergency Circuit Breaker (Fast-Path Override)

In the event of an active exploit:
* A **Supermajority (e.g. 85%)** can trigger immediate emergency pause without timelock delay.
* Emergency actions are strictly limited to:
  * `pause_contract()`
  * `freeze_escrow()`
  * `cancel_pending_proposal()`
* Upgrade and parameter adjustments **CANNOT** bypass the timelock under any circumstance.

---

## 5. Interface Contract Spec (Rust / Soroban)

```rust
pub trait GovernanceTrait {
    /// Submit a new governance proposal
    fn propose(
        env: Env,
        proposer: Address,
        target: Address,
        action: Symbol,
        args: Vec<Val>,
        description_hash: BytesN<32>,
    ) -> u64;

    /// Cast a vote on an active proposal
    fn vote(env: Env, voter: Address, proposal_id: u64, approve: bool);

    /// Queue a proposal that has achieved quorum
    fn queue(env: Env, proposal_id: u64);

    /// Execute a queued proposal whose timelock has elapsed
    fn execute(env: Env, executor: Address, proposal_id: u64);

    /// Cancel a queued proposal
    fn cancel(env: Env, caller: Address, proposal_id: u64);

    /// Emergency fast-path pause (supermajority only)
    fn emergency_pause(env: Env, caller: Address, target: Address);
}
```

---

## 6. Verification Test Scenarios

| Test Case | Scenario | Expected Behavior |
|---|---|---|
| `test_quorum_enforcement` | 2 of 5 signers approve | Proposal remains `Active`, cannot be queued |
| `test_timelock_rejection` | Attempt `execute()` before `eta_ledger` | Fails with `Error::TimelockNotElapsed` |
| `test_timelock_execution` | Execute after `eta_ledger` within grace period | Dispatches call, emits `ProposalExecuted`, state `Executed` |
| `test_grace_period_expiry` | Attempt `execute()` after grace period | Fails with `Error::ProposalExpired` |
| `test_emergency_pause` | 85% supermajority calls emergency pause | Contract paused immediately with `0` timelock delay |
