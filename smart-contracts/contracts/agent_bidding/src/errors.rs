//! # Bidding Error Codes
//!
//! Contract-level errors returned by the Agent Capability Marketplace bidding
//! contract. All variants map to a stable `u32` status code, so off-chain
//! callers can branch on the numeric code without coupling to a specific SDK
//! build.
//!
//! The code range used here (`1..=17`) is local to this contract. Codes are
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
    /// The bid price must be positive and at least the reserve price.
    InvalidPrice = 13,
    /// The locked bond does not match the auction's required bond.
    InvalidBond = 14,
    /// The auction has already been awarded a winner.
    AlreadyAwarded = 15,
    /// `award_contract` was called before a winner was determined.
    WinnerNotDetermined = 16,
    /// The escrow for this auction has already been created.
    EscrowAlreadyCreated = 17,
}
