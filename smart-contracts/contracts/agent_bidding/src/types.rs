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
//!    [Bidding]  ──── bid deadline ────→  [Bidding, reveal window open]
//!                                                     ↓
//!                                       reveal deadline (or all revealed)
//!                                                     ↓
//!                                            reveal_bids (winner computed)
//!                                                     ↓
//!                                                 [Reveal]
//!                                                     ↓
//!                                            award_contract (escrow + refunds)
//!                                                     ↓
//!                                                 [Awarded]
//! ```
//!
//! An auction that attracts no valid reveal before the reveal deadline is a
//! dead auction: `abort_auction` moves it to [`AuctionPhase::Cancelled`] and
//! releases every bond, so bonds are never locked forever. See
//! `docs/agent-bidding-security.md` for the full threat model.
//!
//! ## Event Catalogue
//!
//! | Function          | topic[1]              | Data                                |
//! |-------------------|-----------------------|-------------------------------------|
//! | `create_auction`  | `created`             | `AuctionCreatedEvent`               |
//! | `submit_bid`      | `bid_sbmtd`           | `BidSubmittedEvent`                 |
//! | `reveal_bid`      | `bid_rvld`            | `BidRevealedEvent`                  |
//! | `reveal_bids`     | `bids_rvld`           | `BidsRevealedEvent`                 |
//! | `award_contract`  | `cntrct_aw`           | `ContractAwardedEvent`              |
//! | `abort_auction`   | `aborted`             | `AuctionAbortedEvent`               |

use soroban_sdk::{contracttype, Address, BytesN, String, Symbol};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Default bidding period duration in ledger-seconds (1 hour).
pub const DEFAULT_BIDDING_DURATION_SECS: u64 = 3_600;

/// Default reveal window duration in ledger-seconds (1 hour).
///
/// The reveal window opens when the bidding deadline passes and closes at
/// `deadline + reveal_duration_secs`. Bounding the window is what makes the
/// auction finalisable: without it, `reveal_bids` could be front-run the
/// instant bidding closed (see `docs/agent-bidding-security.md`, A-1).
pub const DEFAULT_REVEAL_DURATION_SECS: u64 = 3_600;

/// Upper bound on any single auction phase, in ledger-seconds (30 days).
///
/// Caps how far into the future a creator can push a deadline, which bounds
/// how long bonds can be locked by a single call.
pub const MAX_PHASE_DURATION_SECS: u64 = 30 * 24 * 60 * 60;

/// Lower bound on any single auction phase, in ledger-seconds (1 minute).
///
/// A sub-minute window is not reliably reachable by honest bidders across
/// ledger close times, so it would function as a censorship tool.
pub const MIN_PHASE_DURATION_SECS: u64 = 60;

/// Maximum allowed reputation score (percentage scale).
pub const MAX_REPUTATION: u32 = 100;

/// Hard ceiling on any bid price, reserve price, or price cap, in stroops.
///
/// 10^17 stroops = 10^10 XLM, comfortably above the total XLM supply while
/// leaving ~10 orders of magnitude of headroom under `i128::MAX` for the
/// `SCORE_SCALE * price` products computed during scoring.
pub const MAX_BID_PRICE: i128 = 100_000_000_000_000_000;

/// Maximum number of sealed bids a single auction will accept.
///
/// `reveal_bids` and `award_contract` iterate the full bidder list, so this
/// cap is what keeps both calls inside a bounded CPU/storage footprint.
pub const MAX_BIDDERS: u32 = 100;

/// Maximum byte length of the free-text `terms` attached to a revealed bid.
pub const MAX_TERMS_LEN: u32 = 512;

/// Score scale factor for normalised sub-scores.
/// Each sub-score (price, reputation) is normalised to `[0, SCORE_SCALE]`.
pub const SCORE_SCALE: i128 = 1_000;

/// Weightings for the composite score (must sum to 100).
pub const PRICE_WEIGHT: i128 = 60;
pub const REPUTATION_WEIGHT: i128 = 40;

/// Domain-separation tag mixed into every bid commitment.
///
/// Binding the contract id, task id, and this tag into the pre-image is what
/// stops a commitment from being replayed into a different auction or a
/// different deployment of this contract (see `docs/agent-bidding-security.md`,
/// A-3).
pub const COMMITMENT_DOMAIN: &str = "ai-net:agent_bidding:v2:bid";

// ─── Auction Lifecycle ───────────────────────────────────────────────────────

/// Phases an auction moves through.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AuctionPhase {
    /// Collecting sealed bids, then collecting reveals.
    Bidding = 0,
    /// Winner selected from the revealed bids; awaiting `award_contract`.
    Reveal = 1,
    /// Winner selected, escrow created, bonds settled. Terminal state.
    Awarded = 2,
    /// Auction died without a valid reveal; every bond released. Terminal.
    Cancelled = 3,
}

/// Creator-supplied configuration for an auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionConfig {
    /// Duration of the bidding period in ledger-seconds (default: 1 h).
    pub duration_secs: u64,
    /// Duration of the reveal window in ledger-seconds (default: 1 h).
    pub reveal_duration_secs: u64,
    /// Minimum accepted price in stroops (reserve price).
    pub reserve_price: i128,
    /// Maximum accepted price in stroops (position-size cap).
    ///
    /// A reveal above this price is rejected, so a single bidder cannot commit
    /// the creator to an unbounded position. Always `>= reserve_price`.
    pub max_price: i128,
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
    /// Ledger timestamp after which the bidding period ends and reveals open.
    pub deadline: u64,
    /// Ledger timestamp after which reveals are refused and the winner can be
    /// computed. Always `> deadline`.
    pub reveal_deadline: u64,
    /// How many sealed bids have been submitted (bounded by [`MAX_BIDDERS`]).
    pub bid_count: u32,
    /// How many of those bids have been revealed.
    pub revealed_count: u32,
    /// Current phase of the auction.
    pub phase: AuctionPhase,
    /// Whether the escrow has been created for the winner.
    pub escrow_created: bool,
}

// ─── Bids ────────────────────────────────────────────────────────────────────

/// A sealed bid stored on-chain during the bidding phase.
///
/// The `commitment` is an opaque 32-byte hash that commits the bidder to a
/// specific `(price, terms, salt)` triple *for one specific auction on one
/// specific contract*. The commitment is computed off-chain as:
///
/// ```text
/// commitment = SHA-256(
///     COMMITMENT_DOMAIN_xdr || contract_id_xdr || task_id_xdr ||
///     bidder_xdr || price_xdr || terms_xdr || salt_xdr
/// )
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
    /// SHA-256 commitment, domain-separated by contract id and task id.
    pub commitment: BytesN<32>,
    /// Bond locked by the bidder (matches the auction's required bond).
    pub bond: i128,
    /// Self-reported reputation score in [0, 100].
    pub reputation: u32,
    /// Whether the bidder has revealed their plaintext bid.
    pub revealed: bool,
    /// Whether the bidder's bond has been released back to them.
    pub refunded: bool,
    /// Whether the bidder's bond has been forfeited for failing to reveal.
    ///
    /// Mutually exclusive with `refunded`. Forfeiting the bond of a bidder who
    /// commits and then stays silent is what prices the free option described
    /// in `docs/agent-bidding-security.md`, A-2.
    pub forfeited: bool,
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
    pub reveal_duration_secs: u64,
    pub deadline: u64,
    pub reveal_deadline: u64,
    pub reserve_price: i128,
    pub max_price: i128,
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

/// Emitted when `award_contract` creates the escrow and settles bonds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractAwardedEvent {
    pub task_id: Symbol,
    pub winner: Address,
    /// Amount locked in escrow (= winning price).
    pub escrow_amount: i128,
    /// Number of bidders who revealed and got their bond back.
    pub refunded_bidders: u32,
    /// Number of bidders who never revealed and forfeited their bond.
    pub forfeited_bidders: u32,
}

/// Emitted when `abort_auction` cancels an auction that drew no valid reveal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionAbortedEvent {
    pub task_id: Symbol,
    /// Who called `abort_auction`.
    pub caller: Address,
    /// Number of bidders whose bond was released by the abort.
    pub refunded_bidders: u32,
}
