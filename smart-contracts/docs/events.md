# Agent Registry Contract Events

This document details the Soroban events emitted by the `agent-registry` smart contract. These events enable off-chain indexers and user interfaces to track registrations, status transitions, pricing changes, and agent removals in real-time.

## Event Topics

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
