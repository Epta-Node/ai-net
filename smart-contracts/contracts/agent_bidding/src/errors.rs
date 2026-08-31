//! # Bidding Error Codes
//!
//! Contract-level errors returned by the Agent Capability Marketplace bidding
//! contract. All variants map to a stable `u32` status code, so off-chain
//! callers can branch on the numeric code without coupling to a specific SDK
//! build.
//!
//! The code range used here (`1..=26`) is local to this contract. Codes are
//! chosen to read naturally in logs while remaining stable across releases:
//! **never renumber an existing variant** once the contract is deployed.

use soroban_sdk::contracterror;

/// Errors surfaced by the `agent-bidding` contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The referenced auction, bid, or escrow does not exist.
    NotFound = 1,
    /// The caller did not authorize the operation (missing signature).
    Unauthorized = 2,
    /// The entity being created already exists (e.g. duplicate auction or bid).
    AlreadyExists = 3,
    /// The auction is not in the `Bidding` phase, so this operation is invalid.
    NotInBiddingPhase = 4,
    /// Reveals are only allowed after the bidding period has ended.
    BiddingPeriodActive = 5,
    /// Bids are only accepted while the bidding period is still open.
    BiddingPeriodEnded = 6,
    /// The revealed bid does not match its sealed commitment.
    InvalidCommitment = 7,
    /// A bid for this bidder already exists on the auction.
    BidAlreadyExists = 8,
    /// The bidder has already revealed their sealed bid.
    BidAlreadyRevealed = 9,
    /// The auction is not in the `Reveal` phase, so this operation is invalid.
    NotInRevealPhase = 10,
    /// There are no eligible revealed bids to select a winner from.
    NotEnoughBids = 11,
    /// Reputation score is out of the accepted `[0, 100]` range.
    InvalidReputation = 12,
    /// The bid price must be positive and within `[reserve_price, max_price]`.
    InvalidPrice = 13,
    /// The locked bond does not match the auction's required bond.
    InvalidBond = 14,
    /// The auction has already been awarded a winner.
    AlreadyAwarded = 15,
    /// `award_contract` was called before a winner was determined.
    WinnerNotDetermined = 16,
    /// The escrow for this auction has already been created.
    EscrowAlreadyCreated = 17,

    // ── Added by the front-running / commit-reveal hardening pass (#350) ────
    /// The reveal window has closed; this bid can no longer be revealed.
    RevealPeriodEnded = 18,
    /// The reveal window is still open, so the winner cannot be finalised yet.
    RevealPeriodActive = 19,
    /// The auction already holds [`MAX_BIDDERS`] sealed bids.
    ///
    /// [`MAX_BIDDERS`]: crate::MAX_BIDDERS
    AuctionFull = 20,
    /// A phase duration is outside `[MIN_PHASE_DURATION_SECS, MAX_PHASE_DURATION_SECS]`.
    InvalidDuration = 21,
    /// The revealed `terms` string exceeds [`MAX_TERMS_LEN`] bytes.
    ///
    /// [`MAX_TERMS_LEN`]: crate::MAX_TERMS_LEN
    TermsTooLong = 22,
    /// The auction's price bounds are inconsistent (e.g. `max_price < reserve_price`).
    InvalidPriceRange = 23,
    /// The auction has reached a terminal phase and accepts no further calls.
    AuctionClosed = 24,
    /// `abort_auction` was called on an auction that still has a valid reveal.
    AuctionNotAbortable = 25,
    /// An arithmetic operation overflowed while scoring bids.
    ArithmeticOverflow = 26,
}
