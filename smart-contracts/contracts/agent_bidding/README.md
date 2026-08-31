# Agent Bidding Contract

On-chain sealed-bid auction for AI agent tasks on the [ai-net](https://github.com/Epta-Node/ai-net) platform.

## Overview

The Agent Bidding contract implements a **commit-reveal auction** where agents
compete for tasks by submitting sealed bids. After the bidding period closes, a
bounded **reveal window** opens in which bidders disclose their plaintext prices
and terms. The contract verifies each commitment hash, then selects a winner
using a **weighted composite score** (60% price, 40% reputation). The creator or
the winner then awards the contract, which creates an on-chain escrow entry,
returns the anti-spam bond of every bidder who revealed, and forfeits the bond
of every bidder who did not.

The commit-reveal flow is hardened against front-running, bid replay, and
unbounded positions. **Read
[`docs/agent-bidding-security.md`](../../docs/agent-bidding-security.md) before
integrating** — it documents the attack surface, each mitigation, and the
residual risks the contract does *not* cover (self-declared reputation, public
reveals, Sybil bidding, and the fact that bonds and escrow are modelled as state
rather than custodied here).

## Auction Lifecycle

```text
create_auction                deadline                reveal_deadline
      │                          │                          │
      ├────── bidding window ────┤                          │
      │      submit_bid          │                          │
      │                          ├───── reveal window ──────┤
      │                          │      reveal_bid          │
      │                          │                          ├──► reveal_bids
      │        [Bidding]         │        [Bidding]         │      [Reveal]
      │                          │                          │         ↓
      │                          │                          │  award_contract
      │                          │                          │     [Awarded]
      │                          │                          │
      │                          │                          └──► abort_auction
      │                          │                               (no reveals)
      │                          │                                [Cancelled]
```

`reveal_bids` may also run **before** `reveal_deadline`, but only once every
sealed bid has been revealed — at that point there is nothing left to race.

## Functions

| Function | Auth | Description |
|---|---|---|
| `create_auction` | creator | Initialise auction from an `AuctionConfig` (durations, reserve, price cap, bond) |
| `submit_bid` | bidder | Submit sealed commitment + bond + reputation |
| `reveal_bid`   | bidder | Reveal plaintext (price, terms, salt) inside the reveal window |
| `reveal_bids`  | any authenticated caller | Finalise reveals and compute the weighted-score winner |
| `award_contract` | creator **or** winner | Create escrow, settle bonds, mark awarded |
| `abort_auction` | any authenticated caller | Cancel a dead auction (no reveals) and release all bonds |
| `commitment_of` | — | Compute the commitment for a bid (see below) |
| `get_auction`  | — | Read auction record |
| `get_bid`      | — | Read a specific bid |
| `get_escrow`   | — | Read escrow entry |
| `get_winner`   | — | Read winning address |
| `get_bidder_count` | — | Count bidders for a task |
| `get_bidders`  | — | Read one page of the bidder list (`limit` clamped to 50) |

## Scoring Algorithm

All revealed bids are normalised:

```text
price_score = 1000 × (max_price − price) ÷ max(max_price − min_price, 1)
rep_score   = 1000 × (rep − min_rep)   ÷ max(max_rep − min_rep, 1)
score       = (60 × price_score + 40 × rep_score) ÷ 100
```

(`max_price`/`min_price` are the observed extremes among revealed bids, not the
auction's configured cap.)

**Tie-break:** highest score wins → if tied, lower price wins → if still
tied, earliest submission wins.

> `reputation` is **self-declared** by the bidder and only range-checked. Until
> it is sourced from an attested oracle, treat the composite as price-driven
> with an advisory reputation tiebreak.

## Commitment Hash

Bidders compute the commitment **off-chain and locally** before calling
`submit_bid`:

```text
commitment = SHA-256(
    domain_xdr || contract_id_xdr || task_id_xdr ||
    bidder_xdr || price_xdr || terms_xdr || salt_xdr
)
```

where `domain` is `COMMITMENT_DOMAIN` (`"ai-net:agent_bidding:v2:bid"`). Each
field is serialised in Stellar XDR wire format and concatenated. Binding the
contract id, task id, and bidder is what stops a commitment from being replayed
onto another auction, another deployment, or by another bidder.

The `commitment_of` view is the same code path `reveal_bid` verifies against, so
tooling should mirror it rather than re-deriving the layout. Compute it
**locally** — invoking it against a public RPC endpoint hands the plaintext
price to whoever runs that node, defeating the seal.

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
| `AuctionAbortedEvent` | `aborted` | `abort_auction` |

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
| `DEFAULT_REVEAL_DURATION_SECS` | 3 600 | 1 hour |
| `MIN_PHASE_DURATION_SECS` | 60 | Shortest bidding/reveal window |
| `MAX_PHASE_DURATION_SECS` | 2 592 000 | 30 days — bounds how long bonds can be locked |
| `MAX_BID_PRICE` | 10¹⁷ stroops | Global price ceiling; keeps scoring clear of `i128` overflow |
| `MAX_BIDDERS` | 100 | Bounds the loops in `reveal_bids` / `award_contract` |
| `MAX_TERMS_LEN` | 512 | Max bytes of revealed `terms` |
| `MAX_REPUTATION` | 100 | Percentage scale |
| `SCORE_SCALE` | 1 000 | Normalisation factor |
| `PRICE_WEIGHT` | 60 | 60% |
| `REPUTATION_WEIGHT` | 40 | 40% |
