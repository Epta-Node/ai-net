//! # Bid and Auction Types
//!
//! Core data structures for the Agent Capability Marketplace bidding contract.
//! Includes auction configuration, sealed bids, escrow records, storage keys,
//! and all event payloads emitted during the auction lifecycle.
//!
//! ## Auction Lifecycle
//!
//! ```text
//! create_auction  →  submit_bid (sealed)  →  reveal_bid (each bidder)
//!       ↓                                             ↓
//!    [Bidding]  ─────────────────────────────────→  [Reveal]
//!                                                    ↓
//!                                            reveal_bids (winner computed)
//!                                                    ↓
//!                                            award_contract (escrow + refunds)
//!                                                    ↓
//!                                                [Awarded]
//! ```
//!
//! ## Event Catalogue
//!
//! | Function          | topic[1]              | Data                                |
//! |-------------------|-----------------------|-------------------------------------|
//! | `create_auction`  | `created`             | `AuctionCreatedEvent`               |
//! | `submit_bid`      | `bid_submitted`       | `BidSubmittedEvent`                 |
//! | `reveal_bid`      | `bid_revealed`        | `BidRevealedEvent`                  |
//! | `reveal_bids`     | `bids_revealed`       | `BidsRevealedEvent`                 |
//! | `award_contract`  | `contract_awarded`    | `ContractAwardedEvent`              |

use soroban_sdk::{contracttype, Address, BytesN, String, Symbol};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Default bidding period duration in ledger-seconds (1 hour).
pub const DEFAULT_BIDDING_DURATION_SECS: u64 = 3_600;

/// Maximum allowed reputation score (percentage scale).
pub const MAX_REPUTATION: u32 = 100;

/// Score scale factor for normalised sub-scores.
/// Each sub-score (price, reputation) is normalised to `[0, SCORE_SCALE]`.
pub const SCORE_SCALE: i128 = 1_000;

/// Weightings for the composite score (must sum to 100).
pub const PRICE_WEIGHT: i128 = 60;
pub const REPUTATION_WEIGHT: i128 = 40;

// ─── Auction Lifecycle ───────────────────────────────────────────────────────

/// Phases an auction moves through.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AuctionPhase {
    /// Collecting sealed bids. The creator may cancel during this phase.
    Bidding = 0,
    /// Bidding period has ended; bids can be revealed and the winner computed.
    Reveal = 1,
    /// Winner selected, escrow created, bonds refunded. Terminal state.
    Awarded = 2,
}

/// Creator-supplied configuration for an auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionConfig {
    /// Duration of the bidding period in ledger-seconds (default: 1 h).
    pub duration_secs: u64,
    /// Minimum accepted price in stroops (reserve price).
    pub reserve_price: i128,
    /// Required bond in stroops that each bidder must lock.
    pub bond: i128,
}

/// On-chain auction record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Auction {
    /// User-defined task identifier (e.g. a UUID).
    pub task_id: Symbol,
    /// Address that created and funds the auction.
    pub creator: Address,
    /// Config set at creation time (immutable after creation).
    pub config: AuctionConfig,
    /// Ledger timestamp when the auction was created.
    pub created_at: u64,
    /// Ledger timestamp after which the bidding period ends.
    pub deadline: u64,
    /// Current phase of the auction.
    pub phase: AuctionPhase,
    /// Whether the escrow has been created for the winner.
    pub escrow_created: bool,
}

// ─── Bids ────────────────────────────────────────────────────────────────────

/// A sealed bid stored on-chain during the bidding phase.
///
/// The `commitment` is an opaque 32-byte hash that commits the bidder to a
/// specific `(price, terms, salt)` triple. The commitment is computed off-chain
/// as:
///
/// ```text
/// commitment = SHA-256(bidder_xdr || price_xdr || terms_xdr || salt_xdr)
/// ```
///
/// where each field is serialised to its Stellar XDR wire format before
/// concatenation. On `reveal_bid` the contract recomputes the hash from the
/// submitted plaintext fields and compares it to `commitment`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedBid {
    /// Who placed this bid.
    pub bidder: Address,
    /// SHA-256 commitment of (bidder, price, terms, salt).
    pub commitment: BytesN<32>,
    /// Bond locked by the bidder (matches the auction's required bond).
    pub bond: i128,
    /// Self-reported reputation score in [0, 100].
    pub reputation: u32,
    /// Whether the bidder has revealed their plaintext bid.
    pub revealed: bool,
    /// Whether the bidder's bond has been refunded (set during award).
    pub refunded: bool,
    /// Revealed price in stroops (0 while sealed).
    pub price_stroops: i128,
    /// Revealed terms (empty string while sealed).
    pub terms: String,
    /// Computed weighted score after `reveal_bids` (0 before scoring).
    pub score: i128,
}

// ─── Escrow ──────────────────────────────────────────────────────────────────

/// On-chain escrow entry created when a contract is awarded.
///
/// The escrow locks the winning price amount. Actual XLM locking requires a
/// separate escrow contract or Soroban token transfer; this struct models the
/// escrow *state* on-chain so indexers and off-chain relayers can track it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub task_id: Symbol,
    /// The winning agent who will receive payment upon delivery.
    pub agent: Address,
    /// Locked amount in stroops (= winning price).
    pub amount: i128,
    /// The task creator who funds the escrow.
    pub creator: Address,
    /// Whether funds have been released to the agent.
    pub released: bool,
    /// Whether funds have been refunded to the creator (e.g. on task failure).
    pub refunded: bool,
}

// ─── Storage Keys ────────────────────────────────────────────────────────────

/// Persistent storage keys scoped by auction task and bidder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Stores the root [`Auction`] record for a task.
    Auction(Symbol),
    /// Stores a single [`SealedBid`] for a given (task, bidder) pair.
    Bid(Symbol, Address),
    /// Ordered list of bidder addresses for a task (submission order).
    Bidders(Symbol),
    /// Stores the winning bidder's address after `reveal_bids`.
    Winner(Symbol),
    /// Stores the [`Escrow`] record for a task after `award_contract`.
    Escrow(Symbol),
}

// ─── Event Payloads ──────────────────────────────────────────────────────────

/// Emitted when `create_auction` successfully initialises a new auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionCreatedEvent {
    pub task_id: Symbol,
    pub creator: Address,
    pub duration_secs: u64,
    pub deadline: u64,
    pub reserve_price: i128,
    pub bond: i128,
}

/// Emitted when `submit_bid` records a new sealed bid.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidSubmittedEvent {
    pub task_id: Symbol,
    pub bidder: Address,
    pub bond: i128,
    pub reputation: u32,
}

/// Emitted when `reveal_bid` successfully verifies and unseals a bid.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidRevealedEvent {
    pub task_id: Symbol,
    pub bidder: Address,
    pub price_stroops: i128,
}

/// Emitted when `reveal_bids` computes the winner from all revealed bids.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidsRevealedEvent {
    pub task_id: Symbol,
    /// How many bids were revealed (and thus considered for scoring).
    pub revealed_count: u32,
    /// The winning bidder's address.
    pub winner: Address,
    /// Winner's composite score (0–1000).
    pub winning_score: i128,
    /// Winner's bid price in stroops.
    pub winning_price: i128,
}

/// Emitted when `award_contract` creates the escrow and refunds bonds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractAwardedEvent {
    pub task_id: Symbol,
    pub winner: Address,
    /// Amount locked in escrow (= winning price).
    pub escrow_amount: i128,
    /// Total number of bidders whose bonds were refunded.
    pub refunded_bidders: u32,
}
