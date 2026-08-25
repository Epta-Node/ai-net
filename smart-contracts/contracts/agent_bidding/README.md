# Agent Bidding Contract

On-chain sealed-bid auction for AI agent tasks on the [ai-net](https://github.com/Epta-Node/ai-net) platform.

## Overview

The Agent Bidding contract implements a **commit-reveal auction** where agents
compete for tasks by submitting sealed bids. After the bidding period closes,
bidders reveal their plaintext prices and terms. The contract verifies each
commitment hash, then selects a winner using a **weighted composite score**
(60% price, 40% reputation). The task creator then awards the contract, which
creates an on-chain escrow entry and refunds every bidder's anti-spam bond.

## Auction Lifecycle

```
create_auction  →  submit_bid (sealed)  →  reveal_bid (each bidder)
     ↓                                         ↓
  [Bidding]  ──────────────────────────→  [Reveal]
                                              ↓
                                      reveal_bids (winner computed)
                                              ↓
                                      award_contract (escrow + refunds)
                                              ↓
                                          [Awarded]
```

## Functions

| Function | Auth | Description |
|---|---|---|
| `create_auction` | creator | Initialise auction with duration, reserve price, bond |
| `submit_bid` | bidder | Submit sealed commitment + bond + reputation |
| `reveal_bid`   | bidder | Reveal plaintext (price, terms, salt) after deadline |
| `reveal_bids`  | anyone | Finalise reveals and compute weighted-score winner |
| `award_contract` | anyone | Create escrow, refund all bonds, mark awarded |
| `get_auction`  | — | Read auction record |
| `get_bid`      | — | Read a specific bid |
| `get_escrow`   | — | Read escrow entry |
| `get_winner`   | — | Read winning address |
| `get_bidder_count` | — | Count bidders for a task |

## Scoring Algorithm

All revealed bids are normalised:

```
price_score = 1000 × (max_price − price) ÷ max(max_price − min_price, 1)
rep_score   = 1000 × (rep − min_rep)   ÷ max(max_rep − min_rep, 1)
score       = (60 × price_score + 40 × rep_score) ÷ 100
```

**Tie-break:** highest score wins → if tied, lower price wins → if still
tied, earliest submission wins.

## Commitment Hash

Bidders must compute the commitment **off-chain** before calling `submit_bid`:

```text
commitment = SHA-256(bidder_xdr || i128_price_xdr || terms_xdr || salt_xdr)
```

Each field is serialised in Stellar XDR wire format and concatenated.
A mismatched commitment during `reveal_bid` results in `InvalidCommitment`.

## Events

All events share the first topic `bidding`:

| Event | topic[1] | When |
|---|---|---|
| `AuctionCreatedEvent` | `created` | `create_auction` |
| `BidSubmittedEvent` | `bid_sbmtd` | `submit_bid` |
| `BidRevealedEvent` | `bid_rvld` | `reveal_bid` |
| `BidsRevealedEvent` | `bids_rvld` | `reveal_bids` |
| `ContractAwardedEvent` | `cntrct_aw` | `award_contract` |

## Running Tests

```bash
cd smart-contracts
cargo test -p agent-bidding
```

With optimised Wasm build:

```bash
cargo build -p agent-bidding --target wasm32v1-none --release
```

## Constants

| Name | Value | Note |
|---|---|---|
| `DEFAULT_BIDDING_DURATION_SECS` | 3 600 | 1 hour |
| `MAX_REPUTATION` | 100 | Percentage scale |
| `SCORE_SCALE` | 1 000 | Normalisation factor |
| `PRICE_WEIGHT` | 60 | 60% |
| `REPUTATION_WEIGHT` | 40 | 40% |