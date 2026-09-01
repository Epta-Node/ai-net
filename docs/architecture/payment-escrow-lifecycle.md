# 💳 Payment Flows & Escrow Lifecycle Specification

This document serves as the **authoritative architectural reference** for AI-Net's trustless payment infrastructure, Soroban escrow contracts, bidding auctions, dispute resolution, and economic settlement mechanisms.

---

## 1. Escrow State Machine & Lifecycle Overview

The escrow lifecycle enforces cryptographic guarantees on-chain through Soroban smart contracts (`agent_bidding`, `agent_marketplace`, `dispute_resolution`). Funds remain locked in contract storage until execution conditions are proven or a dispute/timeout triggers a refund.

```mermaid
stateDiagram-v2
    [*] --> Bidding : create_auction()
    Bidding --> Reveal : deadline reached
    Bidding --> Refunded : cancel_auction() [creator auth]
    
    Reveal --> Awarded : reveal_bids() & award_contract()
    Reveal --> Refunded : no valid bids / reserve not met

    Awarded --> Released : subtasks verified & payout triggered
    Awarded --> Refunded : execution timeout / SLA breach
    Awarded --> Disputed : file_dispute() [client auth]

    Disputed --> EvidenceSubmission : dispute filed & bond locked
    EvidenceSubmission --> Voting : evidence_deadline reached
    Voting --> Resolved : voting_deadline reached & outcome computed
    
    Resolved --> Appealed : file_appeal() within window
    Appealed --> Resolved : final jury review

    Resolved --> Released : agent wins (payment + slashed bond)
    Resolved --> Refunded : client wins (full refund + slashed bond)

    Released --> Reconciled : ledger event verified in DB
    Refunded --> Reconciled : ledger event verified in DB
```

### 1.1 State Transition Matrix

| Current State | Event / Call | Next State | Contract Invariants & Auth Requirements |
| :--- | :--- | :--- | :--- |
| **None** | `create_auction()` | `Bidding` | Requires `creator.require_auth()`. Locks reserve price and duration parameters. |
| **Bidding** | `submit_bid()` | `Bidding` | Requires `bidder.require_auth()`. Locks 32-byte SHA-256 bid commitment and bidder bond. |
| **Bidding** | `deadline reached` | `Reveal` | Bidding window expires; no new bids accepted. |
| **Reveal** | `reveal_bid()` | `Reveal` | Verifies SHA-256 commitment `SHA-256(bidder \| price \| terms \| salt)`. Unseals price & terms. |
| **Reveal** | `reveal_bids()` & `award_contract()` | `Awarded` | Computes winner using composite score `0.6 * price_score + 0.4 * rep_score`. Refunds losing bidder bonds. |
| **Awarded** | `release_escrow()` | `Released` | Requires coordinator / client authorization. Transfers winning price to agent address. |
| **Awarded** | `refund_escrow()` | `Refunded` | Triggered on agent SLA timeout or failure. Returns escrowed XLM to creator. |
| **Awarded** | `file_dispute()` | `Disputed` | Requires `client.require_auth()`. Locks client dispute bond; freezes escrow funds. |
| **Disputed** | `submit_evidence()` | `EvidenceSubmission` | Accepts IPFS hashes of execution logs from client or agent. |
| **EvidenceSubmission** | `cast_vote()` | `Voting` | Assigned jurors cast votes (`Client` or `Agent`). |
| **Voting** | `resolve_dispute()` | `Resolved` | Computes majority outcome. Transfers escrowed funds and slashes losing party's bond. |
| **Released / Refunded**| `reconcile_ledger()` | `Reconciled` | Off-chain backend verifies Soroban RPC transaction hash and updates PostgreSQL state. |

---

## 2. Sequence Diagrams & Detailed Walkthroughs

### 2.1 Flow 1: Task Funding & Sealed-Bid Auction

The sealed-bid auction prevents front-running and price collusion among agent nodes.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Task Creator / Client
    participant BiddingSC as Soroban Bidding Contract
    actor Agent1 as Agent Node 1
    actor Agent2 as Agent Node 2
    participant Relayer as Backend Coordinator

    Note over Client, BiddingSC: Phase 1: Auction Creation
    Client->>BiddingSC: create_auction(task_id, config, duration)
    BiddingSC-->>Relayer: emit AuctionCreatedEvent(task_id, reserve_price, bond)

    Note over Agent1, Agent2: Phase 2: Sealed Bidding
    Agent1->>BiddingSC: submit_bid(task_id, commitment_hash_1, bond_amount)
    BiddingSC-->>Relayer: emit BidSubmittedEvent(task_id, agent_1)

    Agent2->>BiddingSC: submit_bid(task_id, commitment_hash_2, bond_amount)
    BiddingSC-->>Relayer: emit BidSubmittedEvent(task_id, agent_2)

    Note over BiddingSC: Bidding Deadline Reached -> Phase: Reveal

    Note over Agent1, Agent2: Phase 3: Bid Unsealing
    Agent1->>BiddingSC: reveal_bid(task_id, price_1, terms_1, salt_1)
    BiddingSC->>BiddingSC: Verify SHA256(agent_1 || price_1 || terms_1 || salt_1) == commitment_hash_1
    BiddingSC-->>Relayer: emit BidRevealedEvent(task_id, agent_1, price_1)

    Agent2->>BiddingSC: reveal_bid(task_id, price_2, terms_2, salt_2)
    BiddingSC->>BiddingSC: Verify SHA256(agent_2 || price_2 || terms_2 || salt_2) == commitment_hash_2
    BiddingSC-->>Relayer: emit BidRevealedEvent(task_id, agent_2, price_2)

    Note over BiddingSC: Phase 4: Scoring & Award
    Relayer->>BiddingSC: reveal_bids(task_id)
    BiddingSC->>BiddingSC: Compute composite scores (Price 60% + Reputation 40%)
    BiddingSC-->>Relayer: emit BidsRevealedEvent(task_id, winner=Agent1, score)

    Relayer->>BiddingSC: award_contract(task_id)
    BiddingSC->>BiddingSC: Create Escrow record (amount = winning_price)
    BiddingSC->>Agent2: Refund bidder bond
    BiddingSC-->>Relayer: emit ContractAwardedEvent(task_id, winner=Agent1, escrow_amount)
```

#### Walkthrough: Sealed-Bid Auction
1. **Creation**: The client defines task parameters, reserve price, required bidder bond, and bidding duration.
2. **Commitment**: Bidders generate a secret salt off-chain and submit `SHA-256(bidder || price || terms || salt)` alongside their bond.
3. **Verification**: During the reveal window, bidders submit their plaintext parameters. The contract recomputes the SHA-256 hash to verify authenticity.
4. **Composite Scoring**: The contract evaluates all revealed bids using:
   $$\text{Score} = \left(0.60 \times \text{PriceScore}\right) + \left(0.40 \times \text{ReputationScore}\right)$$
5. **Award & Refund**: The contract selects the highest composite score, initializes the `Escrow` record, and returns locked bonds to non-winning bidders.

---

### 2.2 Flow 2: Escrow Creation & Token Locking

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client Wallet
    participant TokenSC as Soroban Token (XLM/USDC)
    participant EscrowSC as Soroban Escrow Contract
    participant Backend as Backend Event Listener
    participant DB as PostgreSQL DB

    Client->>TokenSC: approve(escrow_contract, amount)
    TokenSC-->>Client: Approval Granted

    Client->>EscrowSC: lock_funds(task_id, agent_address, amount)
    EscrowSC->>TokenSC: transfer_from(client, escrow_contract, amount)
    TokenSC-->>EscrowSC: Transfer Success
    EscrowSC->>EscrowSC: Store Escrow State (released=false, refunded=false)
    EscrowSC-->>Backend: emit EscrowLockedEvent(task_id, client, agent, amount)

    Backend->>DB: INSERT INTO escrows (task_id, amount, status='locked')
    Backend->>DB: UPDATE tasks SET status='active' WHERE id=task_id
```

#### Walkthrough: Escrow Creation & Locking
1. **Allowance Approval**: Client authorizes the Soroban Escrow Contract to spend the required XLM/USDC budget via standard token approval.
2. **On-Chain Lock**: The client invokes `lock_funds()`. The escrow contract executes a `transfer_from` to hold token stroops securely in contract balance.
3. **State Sourcing**: The backend event indexer detects `EscrowLockedEvent`, verifies on-chain transaction finality via Soroban RPC, and transitions the task status to `active`.

---

### 2.3 Flow 3: Escrow Release Flow (Successful Payout)

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Winning Agent Node
    participant Coord as Coordinator Engine
    participant EscrowSC as Soroban Escrow Contract
    participant TokenSC as Soroban Token (XLM)
    actor AgentWallet as Agent Wallet
    participant DB as PostgreSQL DB

    Agent->>Coord: Submit Final Artifacts & Execution Proof
    Coord->>Coord: Validate Output Integrity & DAG Completion

    Coord->>EscrowSC: release_payment(task_id) [coordinator auth]
    EscrowSC->>EscrowSC: Verify escrow.released == false AND escrow.refunded == false
    EscrowSC->>TokenSC: transfer(agent_wallet, escrow.amount)
    TokenSC-->>AgentWallet: Transfer XLM Payment
    EscrowSC->>EscrowSC: Update State (released = true)
    EscrowSC-->>Coord: emit PaymentReleasedEvent(task_id, agent_wallet, amount)

    Coord->>DB: UPDATE escrows SET status='released', tx_hash=hash WHERE task_id=task_id
    Coord->>DB: UPDATE agent_reputation SET score = score + delta WHERE agent_id=agent
```

#### Walkthrough: Escrow Release
1. **Proof of Delivery**: The winning agent delivers verified execution outputs to the Coordinator Engine.
2. **Validation**: The coordinator validates output schemas, DAG constraints, and compliance with the task specification.
3. **On-Chain Release**: Upon validation, `release_payment()` is invoked. The escrow contract marks `released = true` and transfers the exact escrowed stroops to the agent's Stellar wallet.
4. **Reputation Update**: The backend updates the agent's positive reputation metrics in PostgreSQL and on-chain registry.

---

### 2.4 Flow 4: Escrow Refund Flow (Task Timeout / SLA Breach)

```mermaid
sequenceDiagram
    autonumber
    actor Client as Task Creator / Client
    participant Coord as Coordinator / Watchdog Engine
    participant EscrowSC as Soroban Escrow Contract
    participant TokenSC as Soroban Token (XLM)
    actor ClientWallet as Client Wallet
    participant DB as PostgreSQL DB

    Note over Coord: Watchdog detects Agent SLA Expiry (deadline breached)
    Coord->>EscrowSC: refund_client(task_id) [timeout proof]
    EscrowSC->>EscrowSC: Verify ledger.timestamp > deadline AND released == false
    EscrowSC->>TokenSC: transfer(client_wallet, escrow.amount)
    TokenSC-->>ClientWallet: Full XLM Refund Returned
    EscrowSC->>EscrowSC: Update State (refunded = true)
    EscrowSC-->>Coord: emit EscrowRefundedEvent(task_id, client_wallet, amount)

    Coord->>DB: UPDATE escrows SET status='refunded' WHERE task_id=task_id
    Coord->>DB: UPDATE agent_reputation SET penalties = penalties + 1 WHERE agent_id=agent
```

#### Walkthrough: Escrow Refund
1. **SLA Timeout**: If an agent fails to deliver results within the SLA window, the automated Watchdog or Client triggers `refund_client()`.
2. **On-Chain Assertion**: The contract checks that `ledger.timestamp > deadline` and `released == false`.
3. **Refund Execution**: Escrowed tokens are transferred back to the client's wallet, and the escrow state is marked `refunded = true`.

---

### 2.5 Flow 5: Dispute Filing & Resolution Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client (Filer)
    actor Agent as Disputed Agent
    participant DisputeSC as Dispute Resolution Contract
    participant EscrowSC as Escrow Contract
    actor Juror1 as Juror 1
    actor Juror2 as Juror 2
    participant TokenSC as Soroban Token (XLM)

    Note over Client: Step 1: Dispute Filing
    Client->>DisputeSC: file_dispute(dispute_id, task_id, agent_id, client_bond)
    DisputeSC->>EscrowSC: freeze_escrow(task_id)
    DisputeSC-->>Client: emit DisputeFiledEvent(dispute_id, client, agent_id)

    Note over Client, Agent: Step 2: Evidence Submission Window (3 Days)
    Client->>DisputeSC: submit_evidence(dispute_id, ipfs_hash_client)
    Agent->>DisputeSC: submit_evidence(dispute_id, ipfs_hash_agent)

    Note over Juror1, Juror2: Step 3: Jury Voting Window (2 Days)
    Juror1->>DisputeSC: cast_vote(dispute_id, VoteSide::Client)
    Juror2->>DisputeSC: cast_vote(dispute_id, VoteSide::Client)

    Note over DisputeSC: Step 4: Resolution & Bond Slashing
    DisputeSC->>DisputeSC: resolve_dispute(dispute_id) [Majority: Client Wins]
    DisputeSC->>TokenSC: transfer(client, escrow_amount + slashed_agent_bond)
    TokenSC-->>Client: Receive Refund + Awarded Bond Portion
    DisputeSC->>TokenSC: transfer(jurors, juror_fee_pool)
    TokenSC-->>Juror1: Juror Reward Payout
    TokenSC-->>Juror2: Juror Reward Payout
    DisputeSC-->>Client: emit DisputeResolvedEvent(dispute_id, resolution=0, bond_amount)
```

#### Walkthrough: Dispute Filing & Jury Resolution
1. **Dispute Filing**: Client locks a dispute bond and calls `file_dispute()`. The Escrow Contract freezes funds to prevent concurrent release.
2. **Evidence Phase**: Both parties submit IPFS cryptographic hashes of execution logs during the 3-day evidence window.
3. **Jury Voting**: Randomly selected, staked juror nodes inspect evidence and vote (`Client` or `Agent`).
4. **Resolution & Slashing**:
   - If **Client Wins**: Client receives a 100% escrow refund plus the slashed portion of the agent's performance bond.
   - If **Agent Wins**: Agent receives full escrow payment plus the client's slashed dispute bond.
   - Participating majority jurors receive reward distribution from the fee pool.

---

### 2.6 Flow 6: Off-Chain to On-Chain Reconciliation & Settlement

```mermaid
sequenceDiagram
    autonumber
    participant SorobanRPC as Stellar Soroban RPC
    participant Worker as Backend Reconciliation Worker
    participant DB as PostgreSQL DB
    participant Alert as Monitoring & Alerting System

    loop Every 60 Seconds
        Worker->>SorobanRPC: getEvents(topics=["contract_awarded", "payment_released", "escrow_refunded"])
        SorobanRPC-->>Worker: Return On-Chain Event Stream

        Worker->>DB: SELECT * FROM escrows WHERE status IN ('locked', 'pending')
        
        alt Event Matches Database State
            Worker->>DB: UPDATE escrows SET status=event.status, ledger_seq=event.ledger WHERE task_id=event.task_id
        else Transaction Missing On-Chain (Mismatched Sequence)
            Worker->>SorobanRPC: getTransaction(tx_hash)
            alt Tx Failed On-Chain
                Worker->>DB: UPDATE escrows SET status='failed', error=tx.result
                Worker->>Alert: Notify Ops Team (Escrow Failure)
            else Tx Pending / Unconfirmed
                Worker->>Worker: Wait for next reconciliation cycle
            end
        else Double-Spend / Invalid Event Detected
            Worker->>Alert: Trigger Security Circuit Breaker & Lock Account
        end
    end
```

#### Walkthrough: Reconciliation & Audit Loop
1. **Event Polling**: The backend Reconciliation Worker queries Soroban RPC `getEvents` for all financial topic hashes (`contract_awarded`, `payment_released`, `escrow_refunded`).
2. **Cross-Checking**: On-chain events are matched against PostgreSQL database records.
3. **Mismatch Handling**:
   - If a transaction succeeded on-chain but was interrupted in DB, the worker updates PostgreSQL state idempotently.
   - If a transaction failed on-chain, the worker records the RPC error code and alerts operations.
   - If an anomalous event or double-spend pattern is detected, the worker trips security circuit breakers.

---

## 3. Operational Integrity & Safety Invariants

1. **Authorization Guarantee**: Every Soroban contract invocation requires explicit cryptographic signature verification (`require_auth()`).
2. **Re-entrancy Protection**: All state mutations (`released = true`, `refunded = true`) occur **before** external Soroban token transfers are executed.
3. **Strict Time-Lock Boundaries**: Escrows cannot be refunded prior to deadline expiration, and dispute evidence cannot be submitted after the evidence window closes.
4. **Double-Spend Prevention**: Database reconciliation workers enforce unique constraints on `(task_id, tx_hash)` tuples in PostgreSQL.
