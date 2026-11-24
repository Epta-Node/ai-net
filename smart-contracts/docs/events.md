# Agent Registry Contract Events

This document details the Soroban events emitted by the `agent-registry` smart contract. These events enable off-chain indexers and user interfaces to track registrations, status transitions, pricing changes, and agent removals in real-time.

## Event Topics

All event topic symbols are lowercase `snake_case`. Payload fields follow the
shared order identity → business values → timestamp; IDs use addresses or
strings, amounts use `i128`, and timestamps use `u64`. Contract-specific
payload extensions should carry a `meta` object with `version`, `contract`, and
`ledger_timestamp`. Run `npm run events:check` from the repository root to
reject non-conforming topic names in CI.

All registry events share the first topic (`registry`) to group registry-related operations. The second topic indicates the specific operation type.

---

### 1. Agent Registered

Emitted when a new agent is successfully registered on-chain.

- **Topic 1**: `Symbol::new(env, "registry")` (Short symbol: `registry`)
- **Topic 2**: `Symbol::new(env, "registered")`
- **Data (Structure)**: `AgentRegistered`
  ```rust
  pub struct AgentRegistered {
      pub agent_id: Symbol,       // Unique ID of the agent
      pub agent_type: Symbol,     // Agent capability (e.g., 'research', 'risk')
      pub owner: Address,         // Stellar account owner address
      pub timestamp: u64,         // Unix timestamp of registration ledger
  }
  ```

---

### 2. Agent Status Changed

Emitted when an agent owner modifies their agent's active status (e.g. going online or offline).

- **Topic 1**: `Symbol::new(env, "registry")` (Short symbol: `registry`)
- **Topic 2**: `Symbol::new(env, "status_chg")`
- **Data (Structure)**: `AgentStatusChanged`
  ```rust
  pub struct AgentStatusChanged {
      pub agent_id: Symbol,       // Unique ID of the agent
      pub old_status: Symbol,     // Previous status (defaults to 'offline')
      pub new_status: Symbol,     // Updated status (e.g., 'online')
  }
  ```

---

### 3. Agent Price Updated

Emitted when an agent owner changes their service price.

- **Topic 1**: `Symbol::new(env, "registry")` (Short symbol: `registry`)
- **Topic 2**: `Symbol::new(env, "price_upd")` (Short symbol: `price_upd`)
- **Data (Tuple)**: `(agent_id: Symbol, new_price: i128)`

---

### 4. Agent Removed

Emitted when an agent is deregistered and removed from the contract index.

- **Topic 1**: `Symbol::new(env, "registry")` (Short symbol: `registry`)
- **Topic 2**: `Symbol::new(env, "removed")`
- **Data (Structure)**: `AgentRemoved`
  ```rust
  pub struct AgentRemoved {
      pub agent_id: Symbol,       // Unique ID of the removed agent
  }
  ```

---

## Admin Changed Events

Emitted when contract administration rights are transferred via `set_admin`.

### Event Topics & Payloads

- **Data (Structure)**: `AdminChangedEvent`
  ```rust
  pub struct AdminChangedEvent {
      pub old_admin: Address,     // Address of outgoing admin
      pub new_admin: Address,     // Address of incoming admin
  }
  ```

| Contract             | Topic 1                        | Topic 2                         | Payload             |
| -------------------- | ------------------------------ | ------------------------------- | ------------------- |
| `oracle_manager`     | `Symbol::new(env, "mgr")`      | `Symbol::new(env, "adm_chng")`  | `AdminChangedEvent` |
| `price_oracle`       | `Symbol::new(env, "oracle")`   | `Symbol::new(env, "adm_chng")`  | `AdminChangedEvent` |
| `agent_marketplace`  | `Symbol::new(env, "market")`   | `Symbol::new(env, "adm_chng")`  | `AdminChangedEvent` |
| `dispute_resolution` | `Symbol::new(env, "dispute")`  | `Symbol::new(env, "adm_chng")`  | `AdminChangedEvent` |
| `agent_registry`     | `Symbol::new(env, "registry")` | `Symbol::new(env, "adm_chngd")` | `AdminChangedEvent` |

## Token-Backed Escrow Events (agent_marketplace, agent_bidding)

Both contracts now move real tokens through a configured Stellar Asset
Contract (`set_payment_asset(asset, decimals)`). Every amount below is the
number of **asset units actually transferred** by `token::Client::transfer`
in the same invocation; nothing is recorded or emitted without the matching
transfer. Listing/bid prices remain stroop-denominated (7 decimals) and are
converted with `stroops_to_units` — for a 7-decimal asset (native XLM SAC,
USDC on Stellar) units and stroops are identical.

### agent_marketplace

| Topics                    | Payload                                                                | Transfer                                         |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `("market", "asset_set")` | `(asset: Address, decimals: u32)`                                      | none                                             |
| `("market", "svc_book")`  | `ServiceBookedEvent { booking_id, listing_id, client, escrow_amount }` | `client → contract` of `escrow_amount`           |
| `("market", "svc_comp")`  | `ServiceCompletedEvent { booking_id, payment_released }`               | `contract → listing owner` of `payment_released` |
| `("market", "svc_canc")`  | `ServiceCancelledEvent { booking_id, refund_amount }`                  | `contract → client` of `refund_amount`           |
| `("market", "queued")`    | `(action_id: u32, eta: u64)`                                           | none                                             |
| `("market", "executed")`  | `action_id: u32`                                                       | none                                             |
| `("market", "cancelled")` | `action_id: u32`                                                       | none                                             |

Admin actions that lift the pause (`Unpause`) or change the payment asset
(`SetPaymentAsset`) go through a timelock: `queue_action` emits `queued` with
the `eta` (ledger timestamp, `now + TIMELOCK_DELAY` = 86 400 s),
`execute_action` reverts with `TimelockNotElapsed` before the `eta`, and
`cancel_action` drops a queued action. `pause` stays immediate as an
emergency stop.

`book_agent` now takes an `asset: Address` argument; it must equal the
configured asset or the call fails with `AssetMismatch` (14).

### agent_bidding

| Topics                                                  | Payload                                             | Transfer                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `("bidding", "asset_set")`                              | `(asset: Address, decimals: u32)`                   | none                                                                                                                   |
| `("bidding", "created")`                                | `AuctionCreatedEvent { .., max_price, .. }`         | `creator → contract` of `max_price` (locked budget)                                                                    |
| `("bidding", "bond_dep")`                               | `BondDeposited { amount_stroops, .. }`              | `bidder → contract` of the bond                                                                                        |
| `("bidding", "bond_slsh")`                              | `BondSlashed { penalty_stroops, .. }`               | `contract → creator` of the forfeited bond                                                                             |
| `("bidding", "cntrct_aw")`                              | `ContractAwardedEvent { escrow_amount, .. }`        | revealed bonds `contract → bidder`; `max_price − escrow_amount` `contract → creator`; `escrow_amount` stays in custody |
| `("bidding", "aborted")`                                | `AuctionAbortedEvent`                               | every bond `contract → bidder`; full budget `contract → creator`                                                       |
| `("bidding", "ref_claim")` / `("bidding", "refnd_clm")` | `RefundClaimedEvent { bond, .. }`                   | `contract → bidder` of `bond`                                                                                          |
| `("bidding", "esc_rel")`                                | `EscrowSettledEvent { task_id, recipient, amount }` | `contract → winning agent` (`release_escrow`, creator auth)                                                            |
| `("bidding", "esc_ref")`                                | `EscrowSettledEvent { task_id, recipient, amount }` | `contract → creator` (`refund_escrow`, admin auth)                                                                     |

Each transfer additionally produces the standard SAC `transfer` event emitted
by the token contract itself, which indexers can use to cross-check.
