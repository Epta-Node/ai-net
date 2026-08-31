#![no_std]

//! # Agent Bidding Contract
//!
//! On-chain sealed-bid auction for AI agent tasks. Agents compete for work by
//! submitting **sealed bids** (commitments) during a configurable bidding
//! period. After the period closes, a bounded **reveal window** opens in which
//! bidders disclose their plaintext prices and terms. The contract verifies
//! each commitment and selects a winner via a weighted-score algorithm (60 %
//! price, 40 % reputation). The creator or winner then awards the contract,
//! which creates an escrow for the winning price, returns the bonds of every
//! bidder who revealed, and forfeits the bonds of those who did not.
//!
//! ## Flow
//!
//! 1. **`create_auction`** — creator initialises the auction with a bidding
//!    duration, a reveal duration, reserve price, price cap, and required
//!    bond. Phase = `Bidding`.
//! 2. **`submit_bid`** — agents submit sealed commitments during the bidding
//!    window. Each bid locks the required bond and records a self-declared
//!    reputation score. At most [`MAX_BIDDERS`] bids are accepted.
//! 3. **`reveal_bid`** — between `deadline` and `reveal_deadline`, each bidder
//!    reveals their plaintext `(price, terms, salt)`. The contract recomputes
//!    the domain-separated SHA-256 commitment and compares it.
//! 4. **`reveal_bids`** — finalises the reveal phase. Callable only once the
//!    reveal window has closed **or** every sealed bid has been revealed. The
//!    contract normalises price and reputation across all revealed bids,
//!    computes composite scores, and selects the winner. Phase → `Reveal`.
//! 5. **`award_contract`** — the creator or the winner creates the escrow
//!    entry for the winning price, refunds the bonds of bidders who revealed,
//!    and forfeits the rest. Phase → `Awarded`.
//! 6. **`abort_auction`** — rescue path for an auction that closed its reveal
//!    window with zero reveals. Releases every bond. Phase → `Cancelled`.
//!
//! ## Security model
//!
//! The commit-reveal flow is hardened against front-running, bid replay, and
//! unbounded positions. The full threat model, including what the contract
//! does *not* defend against, lives in
//! [`docs/agent-bidding-security.md`](../../docs/agent-bidding-security.md).
//! The three load-bearing invariants:
//!
//! * **Bounded reveal window.** `reveal_bids` cannot run while the window is
//!   open and bids are still outstanding, so nobody can finalise the auction
//!   the instant bidding closes and win with the only revealed bid.
//! * **Domain-separated commitments.** Every commitment is bound to the
//!   contract id, task id, and bidder, so a commitment observed on one auction
//!   cannot be replayed onto another auction, another deployment, or another
//!   bidder.
//! * **Non-reveal is not free.** A bidder who commits and stays silent
//!   forfeits their bond, which prices the "last look" option that an
//!   unpunished withdrawal would otherwise hand out for nothing.
//!
//! ## Scoring Algorithm
//!
//! Each revealed bid receives a **composite score** in `[0, 1000]`:
//!
//! ```text
//! price_score = 1000 * (max_price - price) / max(max_price - min_price, 1)
//! rep_score    = 1000 * (rep   - min_rep)  / max(max_rep   - min_rep,   1)
//! score        = (60 * price_score + 40 * rep_score) / 100
//! ```
//!
//! (`max_price`/`min_price` here are the observed extremes among revealed
//! bids, not the auction's configured cap.)
//!
//! Tie-break: highest score wins. If scores are equal, the lowest-price bid
//! wins. If prices are also equal, the earliest submission by order in the
//! bidders list wins.
//!
//! ## Commitment Hash
//!
//! ```text
//! commitment = SHA-256(
//!     domain_xdr || contract_id_xdr || task_id_xdr ||
//!     bidder_xdr || price_xdr || terms_xdr || salt_xdr
//! )
//! ```
//!
//! where `domain` is [`COMMITMENT_DOMAIN`]. Each field is serialised to its
//! Stellar XDR wire format. Off-chain tooling must produce commitments using
//! this exact encoding — or simply call the [`AgentBiddingContract::commitment_of`]
//! view, which is the same code path the contract verifies against.

mod errors;
mod types;

pub use errors::Error;
pub use types::{
    Auction, AuctionAbortedEvent, AuctionConfig, AuctionCreatedEvent, AuctionPhase,
    BidRevealedEvent, BidSubmittedEvent, BidsRevealedEvent, ContractAwardedEvent, DataKey, Escrow,
    SealedBid, COMMITMENT_DOMAIN, DEFAULT_BIDDING_DURATION_SECS, DEFAULT_REVEAL_DURATION_SECS,
    MAX_BIDDERS, MAX_BID_PRICE, MAX_PHASE_DURATION_SECS, MAX_REPUTATION, MAX_TERMS_LEN,
    MIN_PHASE_DURATION_SECS, PRICE_WEIGHT, REPUTATION_WEIGHT, SCORE_SCALE,
};

use soroban_sdk::{
    contract, contractimpl, symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env, String, Symbol,
    Vec,
};

// ─── TTL constants (mirrored from agent_registry) ────────────────────────────

/// Threshold (ledgers remaining) below which we extend.
const TTL_THRESHOLD: u32 = 100_000;
/// Target TTL after extension (~31 days at 5s ledgers).
const TTL_EXTEND_TO: u32 = 535_680;

/// Maximum page size accepted by [`AgentBiddingContract::get_bidders`].
const MAX_PAGE_SIZE: u32 = 50;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Extend TTL for a single persistent key, but only when it exists.
fn extend_ttl_for_key(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

/// Extend TTL for every key in the list (batched rent bump).
fn extend_ttl_batch(env: &Env, keys: &Vec<DataKey>) {
    for key in keys.iter() {
        extend_ttl_for_key(env, &key);
    }
}

/// Load an auction or fail with [`Error::NotFound`].
fn load_auction(env: &Env, task_id: &Symbol) -> Result<Auction, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Auction(task_id.clone()))
        .ok_or(Error::NotFound)
}

/// Persist an auction and bump its rent.
fn save_auction(env: &Env, auction: &Auction) {
    let key = DataKey::Auction(auction.task_id.clone());
    env.storage().persistent().set(&key, auction);
    extend_ttl_for_key(env, &key);
}

/// Reject calls against an auction that has reached a terminal phase.
fn require_live(auction: &Auction) -> Result<(), Error> {
    match auction.phase {
        AuctionPhase::Awarded | AuctionPhase::Cancelled => Err(Error::AuctionClosed),
        _ => Ok(()),
    }
}

/// Normalise a caller-supplied phase duration, applying `default` when `0`.
///
/// Rejects anything outside `[MIN_PHASE_DURATION_SECS, MAX_PHASE_DURATION_SECS]`
/// so a creator can neither make a window too short for honest bidders to hit
/// nor lock bonds for an unbounded stretch of time.
fn normalise_duration(secs: u64, default: u64) -> Result<u64, Error> {
    let value = if secs == 0 { default } else { secs };
    if !(MIN_PHASE_DURATION_SECS..=MAX_PHASE_DURATION_SECS).contains(&value) {
        return Err(Error::InvalidDuration);
    }
    Ok(value)
}

/// Recompute the commitment hash from plaintext fields.
///
/// The pre-image is domain-separated by a version tag, the deployed contract
/// id, and the task id, so a commitment is only ever valid for the exact
/// `(deployment, auction, bidder)` triple it was built for.
fn compute_commitment(
    env: &Env,
    task_id: &Symbol,
    bidder: &Address,
    price: i128,
    terms: &String,
    salt: &BytesN<32>,
) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.append(&String::from_str(env, COMMITMENT_DOMAIN).to_xdr(env));
    preimage.append(&env.current_contract_address().to_xdr(env));
    preimage.append(&task_id.clone().to_xdr(env));
    preimage.append(&bidder.to_xdr(env));
    preimage.append(&price.to_xdr(env));
    preimage.append(&terms.clone().to_xdr(env));
    preimage.append(&salt.to_xdr(env));
    env.crypto().sha256(&preimage).into()
}

/// `SCORE_SCALE * numerator / denominator`, saturating nothing and checking
/// every step. Returns [`Error::ArithmeticOverflow`] rather than panicking so
/// a pathological bid set cannot wedge the auction.
fn scaled_ratio(numerator: i128, denominator: i128) -> Result<i128, Error> {
    if denominator == 0 {
        return Ok(SCORE_SCALE);
    }
    SCORE_SCALE
        .checked_mul(numerator)
        .and_then(|scaled| scaled.checked_div(denominator))
        .ok_or(Error::ArithmeticOverflow)
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentBiddingContract;

#[contractimpl]
impl AgentBiddingContract {
    // ── Creation ─────────────────────────────────────────────────────────

    /// Initialise a new auction for `task_id`.
    ///
    /// The `creator` must authorise the call. Zero values in `config` fall back
    /// to defaults: [`DEFAULT_BIDDING_DURATION_SECS`] for `duration_secs`,
    /// [`DEFAULT_REVEAL_DURATION_SECS`] for `reveal_duration_secs`, and
    /// [`MAX_BID_PRICE`] for `max_price`. The task must not already have an
    /// auction. The stored config is the normalised one, so readers never see
    /// a placeholder zero. Emits `(bidding, created)`.
    pub fn create_auction(
        env: Env,
        creator: Address,
        task_id: Symbol,
        config: AuctionConfig,
    ) -> Result<(), Error> {
        creator.require_auth();

        let auct_key = DataKey::Auction(task_id.clone());
        if env.storage().persistent().has(&auct_key) {
            return Err(Error::AlreadyExists);
        }

        if config.bond <= 0 {
            return Err(Error::InvalidBond);
        }
        if config.reserve_price <= 0 || config.reserve_price > MAX_BID_PRICE {
            return Err(Error::InvalidPrice);
        }

        // `0` means "no explicit cap", which still means the global ceiling —
        // an uncapped i128 price would overflow the scoring arithmetic.
        let max_price = if config.max_price == 0 {
            MAX_BID_PRICE
        } else {
            config.max_price
        };
        if max_price < config.reserve_price || max_price > MAX_BID_PRICE {
            return Err(Error::InvalidPriceRange);
        }

        let duration_secs =
            normalise_duration(config.duration_secs, DEFAULT_BIDDING_DURATION_SECS)?;
        let reveal_duration_secs =
            normalise_duration(config.reveal_duration_secs, DEFAULT_REVEAL_DURATION_SECS)?;

        let now = env.ledger().timestamp();
        let deadline = now.saturating_add(duration_secs);
        let reveal_deadline = deadline.saturating_add(reveal_duration_secs);

        let normalised = AuctionConfig {
            duration_secs,
            reveal_duration_secs,
            reserve_price: config.reserve_price,
            max_price,
            bond: config.bond,
        };

        let auction = Auction {
            task_id: task_id.clone(),
            creator: creator.clone(),
            config: normalised,
            created_at: now,
            deadline,
            reveal_deadline,
            bid_count: 0,
            revealed_count: 0,
            phase: AuctionPhase::Bidding,
            escrow_created: false,
        };

        env.storage().persistent().set(&auct_key, &auction);
        extend_ttl_for_key(&env, &auct_key);

        // Initialise empty bidders list.
        let bidders_key = DataKey::Bidders(task_id.clone());
        let empty: Vec<Address> = Vec::new(&env);
        env.storage().persistent().set(&bidders_key, &empty);
        extend_ttl_for_key(&env, &bidders_key);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("created")),
            AuctionCreatedEvent {
                task_id,
                creator,
                duration_secs,
                reveal_duration_secs,
                deadline,
                reveal_deadline,
                reserve_price: config.reserve_price,
                max_price,
                bond: config.bond,
            },
        );

        Ok(())
    }

    // ── Submit Sealed Bid ─────────────────────────────────────────────────

    /// Submit a sealed bid during the bidding period.
    ///
    /// * `bidder` — must authorise this call.
    /// * `commitment` — see [`AgentBiddingContract::commitment_of`].
    /// * `bond` — must equal the auction's required bond.
    /// * `reputation` — self-declared score in `[0, 100]`.
    ///
    /// One bid per bidder per auction; a second attempt is
    /// [`Error::BidAlreadyExists`], which is what makes a commitment binding
    /// (a bidder cannot keep re-committing until they like the field). The
    /// auction accepts at most [`MAX_BIDDERS`] bids so that the loops in
    /// `reveal_bids` and `award_contract` stay bounded.
    ///
    /// Emits `(bidding, bid_sbmtd)`.
    pub fn submit_bid(
        env: Env,
        task_id: Symbol,
        bidder: Address,
        commitment: BytesN<32>,
        bond: i128,
        reputation: u32,
    ) -> Result<(), Error> {
        bidder.require_auth();

        let mut auction = load_auction(&env, &task_id)?;
        require_live(&auction)?;

        if auction.phase != AuctionPhase::Bidding {
            return Err(Error::NotInBiddingPhase);
        }

        let now = env.ledger().timestamp();
        if now >= auction.deadline {
            return Err(Error::BiddingPeriodEnded);
        }

        if bond != auction.config.bond {
            return Err(Error::InvalidBond);
        }
        if reputation > MAX_REPUTATION {
            return Err(Error::InvalidReputation);
        }
        if auction.bid_count >= MAX_BIDDERS {
            return Err(Error::AuctionFull);
        }

        // Zero-commitment is treated as invalid (non-binding).
        if commitment.to_array() == [0u8; 32] {
            return Err(Error::InvalidCommitment);
        }

        let bid_key = DataKey::Bid(task_id.clone(), bidder.clone());
        if env.storage().persistent().has(&bid_key) {
            return Err(Error::BidAlreadyExists);
        }

        let sealed = SealedBid {
            bidder: bidder.clone(),
            commitment,
            bond,
            reputation,
            revealed: false,
            refunded: false,
            forfeited: false,
            price_stroops: 0,
            terms: String::from_str(&env, ""),
            score: 0,
        };
        env.storage().persistent().set(&bid_key, &sealed);
        extend_ttl_for_key(&env, &bid_key);

        // Append to bidders index.
        let bidders_key = DataKey::Bidders(task_id.clone());
        let mut bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&bidders_key)
            .unwrap_or_else(|| Vec::new(&env));
        bidders.push_back(bidder.clone());
        env.storage().persistent().set(&bidders_key, &bidders);
        extend_ttl_for_key(&env, &bidders_key);

        auction.bid_count += 1;
        save_auction(&env, &auction);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("bid_sbmtd")),
            BidSubmittedEvent {
                task_id,
                bidder,
                bond,
                reputation,
            },
        );

        Ok(())
    }

    // ── Reveal Individual Bid ─────────────────────────────────────────────

    /// Reveal a previously sealed bid inside the reveal window.
    ///
    /// The caller provides the plaintext `(price_stroops, terms, salt)`. The
    /// contract recomputes the commitment hash and compares it to the stored
    /// commitment. A mismatch returns [`Error::InvalidCommitment`].
    ///
    /// * Timing — only while `deadline <= now < reveal_deadline`. Too early is
    ///   [`Error::BiddingPeriodActive`]; too late is
    ///   [`Error::RevealPeriodEnded`] and the bond is forfeited at award time.
    /// * `price_stroops` — must lie within `[reserve_price, max_price]`.
    /// * `terms` — arbitrary bid terms, at most [`MAX_TERMS_LEN`] bytes.
    /// * `salt` — 32-byte blinding factor used to hide the bid pre-image.
    ///
    /// Emits `(bidding, bid_rvld)`.
    pub fn reveal_bid(
        env: Env,
        task_id: Symbol,
        bidder: Address,
        price_stroops: i128,
        terms: String,
        salt: BytesN<32>,
    ) -> Result<(), Error> {
        bidder.require_auth();

        let mut auction = load_auction(&env, &task_id)?;
        require_live(&auction)?;

        if auction.phase != AuctionPhase::Bidding {
            return Err(Error::NotInBiddingPhase);
        }

        let now = env.ledger().timestamp();
        if now < auction.deadline {
            return Err(Error::BiddingPeriodActive);
        }
        if now >= auction.reveal_deadline {
            return Err(Error::RevealPeriodEnded);
        }

        let bid_key = DataKey::Bid(task_id.clone(), bidder.clone());
        let mut sealed: SealedBid = env
            .storage()
            .persistent()
            .get(&bid_key)
            .ok_or(Error::NotFound)?;

        if sealed.revealed {
            return Err(Error::BidAlreadyRevealed);
        }

        if terms.len() > MAX_TERMS_LEN {
            return Err(Error::TermsTooLong);
        }

        // Verify commitment before anything else is trusted. The pre-image is
        // bound to this contract and this task, so a commitment lifted from
        // another auction hashes to a different digest and lands here.
        let recomputed = compute_commitment(&env, &task_id, &bidder, price_stroops, &terms, &salt);
        if recomputed != sealed.commitment {
            return Err(Error::InvalidCommitment);
        }

        if price_stroops < auction.config.reserve_price || price_stroops > auction.config.max_price
        {
            return Err(Error::InvalidPrice);
        }

        sealed.revealed = true;
        sealed.price_stroops = price_stroops;
        sealed.terms = terms;
        env.storage().persistent().set(&bid_key, &sealed);
        extend_ttl_for_key(&env, &bid_key);

        auction.revealed_count += 1;
        save_auction(&env, &auction);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("bid_rvld")),
            BidRevealedEvent {
                task_id,
                bidder,
                price_stroops,
            },
        );

        Ok(())
    }

    // ── Finalise Reveals & Select Winner ───────────────────────────────────

    /// Finalise the reveal phase and select the winning bidder.
    ///
    /// Permissionless but authenticated: any `caller` may finalise, because the
    /// outcome is a pure function of on-chain state, but the call still carries
    /// a signature so it is attributable.
    ///
    /// **Timing is the anti-front-running control.** The call is refused with
    /// [`Error::RevealPeriodActive`] while the reveal window is still open and
    /// at least one sealed bid remains unrevealed. Without that gate, an
    /// attacker could reveal their own bid and finalise in the same ledger the
    /// bidding closed, winning uncontested against bidders who had not yet had
    /// a chance to reveal. Once every bid is revealed there is nothing left to
    /// race, so the auction may be finalised early.
    ///
    /// Non-revealed bids do **not** enter the scoring and cannot win. Requires
    /// at least one revealed bid; an auction with none is resolved through
    /// [`AgentBiddingContract::abort_auction`] instead.
    ///
    /// Phase transitions to `Reveal`. Emits `(bidding, bids_rvld)`.
    pub fn reveal_bids(env: Env, caller: Address, task_id: Symbol) -> Result<(), Error> {
        caller.require_auth();

        let mut auction = load_auction(&env, &task_id)?;
        require_live(&auction)?;

        if auction.phase != AuctionPhase::Bidding {
            return Err(Error::NotInBiddingPhase);
        }

        let now = env.ledger().timestamp();
        if now < auction.deadline {
            return Err(Error::BiddingPeriodActive);
        }
        if now < auction.reveal_deadline && auction.revealed_count < auction.bid_count {
            return Err(Error::RevealPeriodActive);
        }

        // Collect all revealed bids.
        let bidders_key = DataKey::Bidders(task_id.clone());
        let bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&bidders_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Phase 1: gather revealed bids and compute min/max.
        let mut revealed: Vec<SealedBid> = Vec::new(&env);
        let mut min_price: i128 = i128::MAX;
        let mut max_price: i128 = 0;
        let mut min_rep: u32 = u32::MAX;
        let mut max_rep: u32 = 0;

        for bidder in bidders.iter() {
            let bid_key = DataKey::Bid(task_id.clone(), bidder);
            if let Some(bid) = env.storage().persistent().get::<_, SealedBid>(&bid_key) {
                if bid.revealed {
                    if bid.price_stroops < min_price {
                        min_price = bid.price_stroops;
                    }
                    if bid.price_stroops > max_price {
                        max_price = bid.price_stroops;
                    }
                    if bid.reputation < min_rep {
                        min_rep = bid.reputation;
                    }
                    if bid.reputation > max_rep {
                        max_rep = bid.reputation;
                    }
                    revealed.push_back(bid);
                }
            }
        }

        if revealed.is_empty() {
            return Err(Error::NotEnoughBids);
        }

        // Phase 2: compute scores. Every price is bounded by `max_price <=
        // MAX_BID_PRICE`, so these ranges cannot overflow, but the arithmetic
        // is checked anyway rather than trusting that invariant to hold
        // through future edits.
        let price_range = max_price
            .checked_sub(min_price)
            .ok_or(Error::ArithmeticOverflow)?;
        let rep_range = (max_rep - min_rep) as i128;

        let mut best_score: i128 = -1;
        let mut best_price: i128 = i128::MAX;
        let mut winner: Option<Address> = None;

        for bid in revealed.iter() {
            let price_delta = max_price
                .checked_sub(bid.price_stroops)
                .ok_or(Error::ArithmeticOverflow)?;
            let price_score = scaled_ratio(price_delta, price_range)?;
            let rep_score = scaled_ratio((bid.reputation - min_rep) as i128, rep_range)?;

            let score = PRICE_WEIGHT
                .checked_mul(price_score)
                .and_then(|weighted| {
                    REPUTATION_WEIGHT
                        .checked_mul(rep_score)
                        .and_then(|r| weighted.checked_add(r))
                })
                .and_then(|total| total.checked_div(100))
                .ok_or(Error::ArithmeticOverflow)?;

            // Update the stored bid with its score.
            let bid_key = DataKey::Bid(task_id.clone(), bid.bidder.clone());
            let mut stored: SealedBid = env
                .storage()
                .persistent()
                .get(&bid_key)
                .ok_or(Error::NotFound)?;
            stored.score = score;
            env.storage().persistent().set(&bid_key, &stored);
            extend_ttl_for_key(&env, &bid_key);

            // Determine winner: higher score, or tie-break by lower price.
            if score > best_score {
                best_score = score;
                best_price = bid.price_stroops;
                winner = Some(bid.bidder.clone());
            } else if score == best_score && bid.price_stroops < best_price {
                // Same score, lower price wins.
                best_price = bid.price_stroops;
                winner = Some(bid.bidder.clone());
            }
            // else: same score, same or higher price → earlier bid wins (already kept).
        }

        let winner_addr = winner.ok_or(Error::NotEnoughBids)?;
        let winning_price = best_price;

        // Store winner.
        let winner_key = DataKey::Winner(task_id.clone());
        env.storage().persistent().set(&winner_key, &winner_addr);
        extend_ttl_for_key(&env, &winner_key);

        // Transition phase.
        auction.phase = AuctionPhase::Reveal;
        save_auction(&env, &auction);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("bids_rvld")),
            BidsRevealedEvent {
                task_id,
                revealed_count: revealed.len(),
                winner: winner_addr,
                winning_score: best_score,
                winning_price,
            },
        );

        Ok(())
    }

    // ── Award Contract ─────────────────────────────────────────────────────

    /// Award the contract to the winner determined by `reveal_bids`.
    ///
    /// `caller` must authorise and must be either the auction creator or the
    /// winning bidder — the two parties the escrow binds. Anyone else gets
    /// [`Error::Unauthorized`].
    ///
    /// Creates an escrow entry locking the winning price for the winning
    /// agent, then settles every bond: bidders who revealed get theirs back,
    /// bidders who never revealed **forfeit** theirs. The bond is an anti-spam
    /// deposit separate from the escrow amount; forfeiting it is what stops a
    /// sealed bid from being a free option to walk away after seeing everyone
    /// else's price.
    ///
    /// Phase transitions to `Awarded`. Emits `(bidding, cntrct_aw)`.
    pub fn award_contract(env: Env, caller: Address, task_id: Symbol) -> Result<(), Error> {
        caller.require_auth();

        let mut auction = load_auction(&env, &task_id)?;

        if auction.phase == AuctionPhase::Awarded {
            return Err(Error::AlreadyAwarded);
        }
        if auction.phase != AuctionPhase::Reveal {
            return Err(Error::NotInRevealPhase);
        }
        if auction.escrow_created {
            return Err(Error::EscrowAlreadyCreated);
        }

        let winner_key = DataKey::Winner(task_id.clone());
        let winner: Address = env
            .storage()
            .persistent()
            .get(&winner_key)
            .ok_or(Error::WinnerNotDetermined)?;

        if caller != auction.creator && caller != winner {
            return Err(Error::Unauthorized);
        }

        // Find the winning bid to get the price.
        let bid_key = DataKey::Bid(task_id.clone(), winner.clone());
        let winning_bid: SealedBid = env
            .storage()
            .persistent()
            .get(&bid_key)
            .ok_or(Error::NotFound)?;

        let escrow_amount = winning_bid.price_stroops;

        // Create escrow entry.
        let escrow_key = DataKey::Escrow(task_id.clone());
        let escrow = Escrow {
            task_id: task_id.clone(),
            agent: winner.clone(),
            amount: escrow_amount,
            creator: auction.creator.clone(),
            released: false,
            refunded: false,
        };
        env.storage().persistent().set(&escrow_key, &escrow);
        extend_ttl_for_key(&env, &escrow_key);

        // Settle every bidder's bond: refund those who revealed, forfeit the rest.
        let bidders_key = DataKey::Bidders(task_id.clone());
        let bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&bidders_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut refunded_count: u32 = 0;
        let mut forfeited_count: u32 = 0;
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for b in bidders.iter() {
            let bk = DataKey::Bid(task_id.clone(), b);
            if let Some(mut bid) = env.storage().persistent().get::<_, SealedBid>(&bk) {
                if bid.refunded || bid.forfeited {
                    continue;
                }
                if bid.revealed {
                    bid.refunded = true;
                    refunded_count += 1;
                } else {
                    bid.forfeited = true;
                    forfeited_count += 1;
                }
                env.storage().persistent().set(&bk, &bid);
                ttl_keys.push_back(bk);
            }
        }
        extend_ttl_batch(&env, &ttl_keys);

        auction.phase = AuctionPhase::Awarded;
        auction.escrow_created = true;
        save_auction(&env, &auction);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("cntrct_aw")),
            ContractAwardedEvent {
                task_id,
                winner,
                escrow_amount,
                refunded_bidders: refunded_count,
                forfeited_bidders: forfeited_count,
            },
        );

        Ok(())
    }

    // ── Abort a dead auction ───────────────────────────────────────────────

    /// Cancel an auction whose reveal window closed without a single reveal,
    /// releasing every bond.
    ///
    /// Without this path, an auction where nobody reveals — because the task
    /// became irrelevant, or every bidder simply walked — would sit in
    /// `Bidding` forever with `reveal_bids` permanently returning
    /// [`Error::NotEnoughBids`], stranding all bonds. Bonds are refunded, not
    /// forfeited: with no winner there is no counterparty the forfeiture would
    /// compensate, so burning them would destroy value without deterring
    /// anything.
    ///
    /// Permissionless but authenticated, so a vanished creator cannot strand
    /// other people's bonds. Emits `(bidding, aborted)`.
    pub fn abort_auction(env: Env, caller: Address, task_id: Symbol) -> Result<(), Error> {
        caller.require_auth();

        let mut auction = load_auction(&env, &task_id)?;
        require_live(&auction)?;

        if auction.phase != AuctionPhase::Bidding {
            return Err(Error::NotInBiddingPhase);
        }

        let now = env.ledger().timestamp();
        if now < auction.reveal_deadline {
            return Err(Error::RevealPeriodActive);
        }
        if auction.revealed_count > 0 {
            // A revealed bid exists, so the auction can and must be finalised
            // through `reveal_bids` rather than thrown away.
            return Err(Error::AuctionNotAbortable);
        }

        let bidders_key = DataKey::Bidders(task_id.clone());
        let bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&bidders_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut refunded_count: u32 = 0;
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for b in bidders.iter() {
            let bk = DataKey::Bid(task_id.clone(), b);
            if let Some(mut bid) = env.storage().persistent().get::<_, SealedBid>(&bk) {
                if bid.refunded || bid.forfeited {
                    continue;
                }
                bid.refunded = true;
                refunded_count += 1;
                env.storage().persistent().set(&bk, &bid);
                ttl_keys.push_back(bk);
            }
        }
        extend_ttl_batch(&env, &ttl_keys);

        auction.phase = AuctionPhase::Cancelled;
        save_auction(&env, &auction);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("aborted")),
            AuctionAbortedEvent {
                task_id,
                caller,
                refunded_bidders: refunded_count,
            },
        );

        Ok(())
    }

    // ── View Functions ─────────────────────────────────────────────────────

    /// Compute the commitment an off-chain bidder must submit for this task.
    ///
    /// Exposed so tooling never has to re-implement the pre-image layout and
    /// silently drift from what `reveal_bid` verifies. Callers should compute
    /// this **locally** when preparing a bid — invoking it against a public RPC
    /// hands the plaintext price to whoever runs that node, which defeats the
    /// seal.
    pub fn commitment_of(
        env: Env,
        task_id: Symbol,
        bidder: Address,
        price_stroops: i128,
        terms: String,
        salt: BytesN<32>,
    ) -> BytesN<32> {
        compute_commitment(&env, &task_id, &bidder, price_stroops, &terms, &salt)
    }

    /// Return the auction record for a task, if it exists.
    pub fn get_auction(env: Env, task_id: Symbol) -> Option<Auction> {
        env.storage().persistent().get(&DataKey::Auction(task_id))
    }

    /// Return the (possibly sealed or revealed) bid for a given bidder.
    pub fn get_bid(env: Env, task_id: Symbol, bidder: Address) -> Option<SealedBid> {
        env.storage()
            .persistent()
            .get(&DataKey::Bid(task_id, bidder))
    }

    /// Return the escrow record for a task, if one has been created.
    pub fn get_escrow(env: Env, task_id: Symbol) -> Option<Escrow> {
        env.storage().persistent().get(&DataKey::Escrow(task_id))
    }

    /// Return the winning bidder's address, if `reveal_bids` has been called.
    pub fn get_winner(env: Env, task_id: Symbol) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Winner(task_id))
    }

    /// Return the number of bidders who submitted bids for this task.
    pub fn get_bidder_count(env: Env, task_id: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get::<_, Auction>(&DataKey::Auction(task_id))
            .map(|auction| auction.bid_count)
            .unwrap_or(0)
    }

    /// Return one page of the bidder list, in submission order.
    ///
    /// `limit` is clamped to [`MAX_PAGE_SIZE`] so a single call can never be
    /// asked to materialise an unbounded vector.
    pub fn get_bidders(env: Env, task_id: Symbol, start: u32, limit: u32) -> Vec<Address> {
        let bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Bidders(task_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut page: Vec<Address> = Vec::new(&env);
        if start >= bidders.len() {
            return page;
        }
        let capped = limit.min(MAX_PAGE_SIZE);
        let end = start.saturating_add(capped).min(bidders.len());
        for i in start..end {
            page.push_back(bidders.get(i).unwrap());
        }
        page
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        Address, Symbol,
    };

    const RESERVE: i128 = 1_000_000; // 0.1 XLM in stroops
    const BOND: i128 = 500_000; // 0.05 XLM
    const BID_SECS: u64 = 3_600;
    const REVEAL_SECS: u64 = 3_600;

    /// Creates a fresh in-memory test environment with the contract registered.
    fn setup() -> (Env, AgentBiddingContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AgentBiddingContract, ());
        let client = AgentBiddingContractClient::new(&env, &id);
        let anyone = Address::generate(&env);
        (env, client, anyone)
    }

    /// Default auction config: 1 h bidding, 1 h reveal, no explicit price cap.
    fn config(env: &Env, duration_secs: u64) -> AuctionConfig {
        let _ = env;
        AuctionConfig {
            duration_secs,
            reveal_duration_secs: REVEAL_SECS,
            reserve_price: RESERVE,
            max_price: 0, // → MAX_BID_PRICE
            bond: BOND,
        }
    }

    /// Helper: create a test auction with default config.
    fn create_test_auction(
        env: &Env,
        client: &AgentBiddingContractClient<'static>,
        creator: &Address,
        task_id: &Symbol,
        duration_secs: u64,
    ) {
        client.create_auction(creator, task_id, &config(env, duration_secs));
    }

    /// Advance the ledger clock into the reveal window of `task_id`.
    fn enter_reveal_window(env: &Env, client: &AgentBiddingContractClient<'static>, task: &Symbol) {
        let auction = client.get_auction(task).unwrap();
        env.ledger().set_timestamp(auction.deadline + 1);
    }

    /// Advance the ledger clock past the reveal deadline of `task_id`.
    fn close_reveal_window(env: &Env, client: &AgentBiddingContractClient<'static>, task: &Symbol) {
        let auction = client.get_auction(task).unwrap();
        env.ledger().set_timestamp(auction.reveal_deadline + 1);
    }

    fn salt(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::<32>::from_array(env, &[byte; 32])
    }

    fn terms(env: &Env, text: &str) -> String {
        String::from_str(env, text)
    }

    // ── create_auction ───────────────────────────────────────────────────────

    #[test]
    fn create_auction_stores_record() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "task_1");

        client.create_auction(
            &creator,
            &task_id,
            &AuctionConfig {
                duration_secs: 0, // → default
                reveal_duration_secs: 0,
                reserve_price: RESERVE,
                max_price: 0,
                bond: BOND,
            },
        );

        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.creator, creator);
        assert_eq!(auction.phase, AuctionPhase::Bidding);
        assert!(!auction.escrow_created);
        assert_eq!(auction.bid_count, 0);
        assert_eq!(auction.revealed_count, 0);
        assert_eq!(auction.config.duration_secs, DEFAULT_BIDDING_DURATION_SECS);
        assert_eq!(
            auction.config.reveal_duration_secs,
            DEFAULT_REVEAL_DURATION_SECS
        );
        // `0` normalises to the global ceiling, never left as a placeholder.
        assert_eq!(auction.config.max_price, MAX_BID_PRICE);
        assert_eq!(
            auction.deadline,
            auction.created_at + DEFAULT_BIDDING_DURATION_SECS
        );
        assert_eq!(
            auction.reveal_deadline,
            auction.deadline + DEFAULT_REVEAL_DURATION_SECS
        );
    }

    #[test]
    fn create_auction_duplicate_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "dup");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);
        let err = client.try_create_auction(&creator, &task_id, &config(&env, BID_SECS));
        assert_eq!(err.err(), Some(Ok(Error::AlreadyExists)));
    }

    #[test]
    fn create_auction_emits_event() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "events");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let all_events = env.events().all();
        assert!(!all_events.is_empty(), "expected at least one event");
    }

    #[test]
    fn create_auction_rejects_out_of_range_durations() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);

        // Too short to be reachable by honest bidders.
        let err = client.try_create_auction(
            &creator,
            &Symbol::new(&env, "short"),
            &AuctionConfig {
                duration_secs: MIN_PHASE_DURATION_SECS - 1,
                reveal_duration_secs: REVEAL_SECS,
                reserve_price: RESERVE,
                max_price: 0,
                bond: BOND,
            },
        );
        assert_eq!(err.err(), Some(Ok(Error::InvalidDuration)));

        // Long enough to lock bonds effectively forever.
        let err = client.try_create_auction(
            &creator,
            &Symbol::new(&env, "long"),
            &AuctionConfig {
                duration_secs: BID_SECS,
                reveal_duration_secs: MAX_PHASE_DURATION_SECS + 1,
                reserve_price: RESERVE,
                max_price: 0,
                bond: BOND,
            },
        );
        assert_eq!(err.err(), Some(Ok(Error::InvalidDuration)));
    }

    #[test]
    fn create_auction_rejects_inverted_price_range() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);

        let err = client.try_create_auction(
            &creator,
            &Symbol::new(&env, "inverted"),
            &AuctionConfig {
                duration_secs: BID_SECS,
                reveal_duration_secs: REVEAL_SECS,
                reserve_price: 5_000_000,
                max_price: 1_000_000, // below the reserve
                bond: BOND,
            },
        );
        assert_eq!(err.err(), Some(Ok(Error::InvalidPriceRange)));
    }

    #[test]
    fn create_auction_rejects_price_above_global_ceiling() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);

        let err = client.try_create_auction(
            &creator,
            &Symbol::new(&env, "huge"),
            &AuctionConfig {
                duration_secs: BID_SECS,
                reveal_duration_secs: REVEAL_SECS,
                reserve_price: MAX_BID_PRICE + 1,
                max_price: 0,
                bond: BOND,
            },
        );
        assert_eq!(err.err(), Some(Ok(Error::InvalidPrice)));
    }

    // ── submit_bid ───────────────────────────────────────────────────────────

    #[test]
    fn submit_bid_succeeds() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bid_test");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 1);
        let price: i128 = 5_000_000;
        let t = terms(&env, "Deliver in 3 days");
        let commitment = client.commitment_of(&task_id, &bidder, &price, &t, &s);

        client.submit_bid(&task_id, &bidder, &commitment, &BOND, &85);

        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert_eq!(bid.bidder, bidder);
        assert_eq!(bid.commitment, commitment);
        assert_eq!(bid.bond, BOND);
        assert_eq!(bid.reputation, 85);
        assert!(!bid.revealed);
        assert!(!bid.forfeited);
        assert_eq!(client.get_bidder_count(&task_id), 1);
        assert_eq!(client.get_auction(&task_id).unwrap().bid_count, 1);
    }

    #[test]
    fn submit_bid_emits_event() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bid_event");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 2);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Fast track");
        let commitment = client.commitment_of(&task_id, &bidder, &price, &t, &s);

        // Clear events from create_auction by draining.
        let _ = env.events().all();

        client.submit_bid(&task_id, &bidder, &commitment, &BOND, &90);

        let events = env.events().all();
        assert_eq!(events.len(), 1, "expected exactly one BidSubmitted event");
    }

    #[test]
    fn submit_bid_after_deadline_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "late");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);
        enter_reveal_window(&env, &client, &task_id);

        let s = salt(&env, 3);
        let t = terms(&env, "Late bid");
        let commitment = client.commitment_of(&task_id, &bidder, &2_000_000, &t, &s);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &BOND, &50);
        assert_eq!(err.err(), Some(Ok(Error::BiddingPeriodEnded)));
    }

    #[test]
    fn submit_bid_invalid_reputation_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bad_rep");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 4);
        let t = terms(&env, "Bad rep");
        let commitment = client.commitment_of(&task_id, &bidder, &2_000_000, &t, &s);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &BOND, &101);
        assert_eq!(err.err(), Some(Ok(Error::InvalidReputation)));
    }

    #[test]
    fn submit_bid_wrong_bond_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bad_bond");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 5);
        let t = terms(&env, "");
        let commitment = client.commitment_of(&task_id, &bidder, &RESERVE, &t, &s);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &1, &50);
        assert_eq!(err.err(), Some(Ok(Error::InvalidBond)));
    }

    /// A bidder gets exactly one commitment per auction — the double-commit
    /// guard that makes a sealed bid binding rather than a draft.
    #[test]
    fn submit_bid_duplicate_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "dup_bid");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 6);
        let t = terms(&env, "First");
        let commitment = client.commitment_of(&task_id, &bidder, &2_000_000, &t, &s);

        client.submit_bid(&task_id, &bidder, &commitment, &BOND, &80);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &BOND, &80);
        assert_eq!(err.err(), Some(Ok(Error::BidAlreadyExists)));
    }

    /// Re-committing with a *different* commitment is refused too, so a bidder
    /// cannot overwrite an unfavourable commitment late in the bidding window.
    #[test]
    fn submit_bid_second_different_commitment_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "recommit");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let first = client.commitment_of(
            &task_id,
            &bidder,
            &9_000_000,
            &terms(&env, "high"),
            &salt(&env, 61),
        );
        let second = client.commitment_of(
            &task_id,
            &bidder,
            &1_500_000,
            &terms(&env, "low"),
            &salt(&env, 62),
        );
        assert_ne!(first, second);

        client.submit_bid(&task_id, &bidder, &first, &BOND, &80);
        let err = client.try_submit_bid(&task_id, &bidder, &second, &BOND, &80);
        assert_eq!(err.err(), Some(Ok(Error::BidAlreadyExists)));

        // The original commitment is the one that stands.
        assert_eq!(client.get_bid(&task_id, &bidder).unwrap().commitment, first);
    }

    #[test]
    fn submit_bid_rejects_zero_commitment() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "zero_c");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let zero = BytesN::<32>::from_array(&env, &[0u8; 32]);
        let err = client.try_submit_bid(&task_id, &bidder, &zero, &BOND, &50);
        assert_eq!(err.err(), Some(Ok(Error::InvalidCommitment)));
    }

    // ── Position-size caps ───────────────────────────────────────────────────

    #[test]
    fn submit_bid_rejects_beyond_max_bidders() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "full");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        for i in 0..MAX_BIDDERS {
            let bidder = Address::generate(&env);
            let c = client.commitment_of(
                &task_id,
                &bidder,
                &2_000_000,
                &terms(&env, "x"),
                &salt(&env, (i % 250) as u8 + 1),
            );
            client.submit_bid(&task_id, &bidder, &c, &BOND, &50);
        }

        assert_eq!(client.get_bidder_count(&task_id), MAX_BIDDERS);

        let overflow_bidder = Address::generate(&env);
        let c = client.commitment_of(
            &task_id,
            &overflow_bidder,
            &2_000_000,
            &terms(&env, "x"),
            &salt(&env, 251),
        );
        let err = client.try_submit_bid(&task_id, &overflow_bidder, &c, &BOND, &50);
        assert_eq!(err.err(), Some(Ok(Error::AuctionFull)));
    }

    #[test]
    fn reveal_bid_rejects_price_above_cap() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "capped");

        client.create_auction(
            &creator,
            &task_id,
            &AuctionConfig {
                duration_secs: BID_SECS,
                reveal_duration_secs: REVEAL_SECS,
                reserve_price: RESERVE,
                max_price: 4_000_000,
                bond: BOND,
            },
        );

        // The commitment itself is well-formed; the *position size* is what
        // gets rejected, and only at reveal time — that is the whole point of
        // a sealed bid.
        let over_cap: i128 = 9_000_000;
        let s = salt(&env, 71);
        let t = terms(&env, "oversized");
        let c = client.commitment_of(&task_id, &bidder, &over_cap, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);

        let err = client.try_reveal_bid(&task_id, &bidder, &over_cap, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::InvalidPrice)));
    }

    #[test]
    fn reveal_bid_rejects_price_below_reserve() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "under");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let under: i128 = RESERVE - 1;
        let s = salt(&env, 72);
        let t = terms(&env, "cheap");
        let c = client.commitment_of(&task_id, &bidder, &under, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);

        let err = client.try_reveal_bid(&task_id, &bidder, &under, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::InvalidPrice)));
    }

    #[test]
    fn reveal_bid_rejects_oversized_terms() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "big_terms");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        // 520 bytes > MAX_TERMS_LEN (512).
        let long = "x".repeat((MAX_TERMS_LEN + 8) as usize);
        let long_terms = String::from_str(&env, &long);
        let s = salt(&env, 73);
        let price: i128 = 2_000_000;
        let c = client.commitment_of(&task_id, &bidder, &price, &long_terms, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);

        let err = client.try_reveal_bid(&task_id, &bidder, &price, &long_terms, &s);
        assert_eq!(err.err(), Some(Ok(Error::TermsTooLong)));
    }

    // ── reveal_bid ───────────────────────────────────────────────────────────

    #[test]
    fn reveal_bid_verifies_commitment() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "reveal_ok");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 7);
        let price: i128 = 4_000_000;
        let t = terms(&env, "Best offer");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);

        client.submit_bid(&task_id, &bidder, &c, &BOND, &70);
        enter_reveal_window(&env, &client, &task_id);

        client.reveal_bid(&task_id, &bidder, &price, &t, &s);

        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert!(bid.revealed);
        assert_eq!(bid.price_stroops, price);
        assert_eq!(bid.terms, t);
        assert_eq!(client.get_auction(&task_id).unwrap().revealed_count, 1);
    }

    #[test]
    fn reveal_bid_wrong_commitment_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bad_rev");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 8);
        let t = terms(&env, "Original");
        let c = client.commitment_of(&task_id, &bidder, &4_000_000, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &70);

        enter_reveal_window(&env, &client, &task_id);

        // Reveal a different (cheaper) price than was committed.
        let err = client.try_reveal_bid(&task_id, &bidder, &1_000_000, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::InvalidCommitment)));
    }

    #[test]
    fn reveal_bid_before_deadline_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "early_rev");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 9);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Early");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &60);

        let err = client.try_reveal_bid(&task_id, &bidder, &price, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::BiddingPeriodActive)));
    }

    #[test]
    fn reveal_bid_twice_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "double_rev");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 10);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Once");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &60);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);

        let err = client.try_reveal_bid(&task_id, &bidder, &price, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::BidAlreadyRevealed)));

        // The replayed reveal must not double-count toward the reveal tally,
        // which the `reveal_bids` early-finalisation gate depends on.
        assert_eq!(client.get_auction(&task_id).unwrap().revealed_count, 1);
    }

    // ── Late reveal ──────────────────────────────────────────────────────────

    #[test]
    fn reveal_bid_after_reveal_deadline_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "late_rev");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 81);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Too slow");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &60);

        close_reveal_window(&env, &client, &task_id);

        let err = client.try_reveal_bid(&task_id, &bidder, &price, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::RevealPeriodEnded)));
        assert!(!client.get_bid(&task_id, &bidder).unwrap().revealed);
    }

    #[test]
    fn late_reveal_cannot_displace_an_already_selected_winner() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "no_displace");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let punctual = Address::generate(&env);
        let tardy = Address::generate(&env);

        let s_p = salt(&env, 82);
        let s_t = salt(&env, 83);
        let t = terms(&env, "T");

        // The tardy bidder has a strictly better bid — cheaper and higher
        // reputation — so only the timing rule can keep them from winning.
        let c_p = client.commitment_of(&task_id, &punctual, &8_000_000, &t, &s_p);
        let c_t = client.commitment_of(&task_id, &tardy, &1_500_000, &t, &s_t);
        client.submit_bid(&task_id, &punctual, &c_p, &BOND, &40);
        client.submit_bid(&task_id, &tardy, &c_t, &BOND, &99);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &punctual, &8_000_000, &t, &s_p);

        close_reveal_window(&env, &client, &task_id);
        client.reveal_bids(&anyone, &task_id);
        assert_eq!(client.get_winner(&task_id).unwrap(), punctual);

        // The tardy bidder now tries to reveal and re-run selection.
        let err = client.try_reveal_bid(&task_id, &tardy, &1_500_000, &t, &s_t);
        assert_eq!(err.err(), Some(Ok(Error::NotInBiddingPhase)));

        let err = client.try_reveal_bids(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotInBiddingPhase)));
        assert_eq!(client.get_winner(&task_id).unwrap(), punctual);
    }

    // ── Replay guards ────────────────────────────────────────────────────────

    /// A commitment is bound to its auction: lifting one from task A and
    /// submitting it to task B leaves it unrevealable.
    #[test]
    fn commitment_cannot_be_replayed_across_auctions() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_a = Symbol::new(&env, "task_a");
        let task_b = Symbol::new(&env, "task_b");

        create_test_auction(&env, &client, &creator, &task_a, BID_SECS);
        create_test_auction(&env, &client, &creator, &task_b, BID_SECS);

        let s = salt(&env, 91);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Same bid");

        let c_a = client.commitment_of(&task_a, &bidder, &price, &t, &s);
        let c_b = client.commitment_of(&task_b, &bidder, &price, &t, &s);
        assert_ne!(
            c_a, c_b,
            "identical plaintext must commit differently per auction"
        );

        // Replay A's commitment onto auction B.
        client.submit_bid(&task_b, &bidder, &c_a, &BOND, &50);

        enter_reveal_window(&env, &client, &task_b);
        let err = client.try_reveal_bid(&task_b, &bidder, &price, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::InvalidCommitment)));
    }

    /// A commitment is bound to its bidder: copying a rival's commitment off
    /// the ledger yields a bid the copier can never open.
    #[test]
    fn commitment_cannot_be_replayed_by_another_bidder() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let honest = Address::generate(&env);
        let copycat = Address::generate(&env);
        let task_id = Symbol::new(&env, "copycat");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 92);
        let price: i128 = 2_500_000;
        let t = terms(&env, "Mine");
        let c = client.commitment_of(&task_id, &honest, &price, &t, &s);

        client.submit_bid(&task_id, &honest, &c, &BOND, &70);
        // The copycat submits the exact bytes they observed on-chain.
        client.submit_bid(&task_id, &copycat, &c, &BOND, &70);

        enter_reveal_window(&env, &client, &task_id);

        client.reveal_bid(&task_id, &honest, &price, &t, &s);

        // Even knowing the full plaintext, the copycat's commitment does not
        // verify, because their own address is part of the pre-image.
        let err = client.try_reveal_bid(&task_id, &copycat, &price, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::InvalidCommitment)));
    }

    /// A revealed bid cannot be re-revealed at a different price after the
    /// winner has been computed.
    #[test]
    fn revealed_bid_cannot_be_reopened_at_a_new_price() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "reopen");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 93);
        let price: i128 = 4_000_000;
        let t = terms(&env, "Fixed");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);
        client.reveal_bids(&anyone, &task_id);

        let err = client.try_reveal_bid(&task_id, &bidder, &1_000_000, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::NotInBiddingPhase)));
        assert_eq!(
            client.get_bid(&task_id, &bidder).unwrap().price_stroops,
            price
        );
    }

    // ── Front-running the finalisation ───────────────────────────────────────

    /// The core front-running defence: an attacker who reveals the moment
    /// bidding closes cannot immediately finalise and win uncontested.
    #[test]
    fn reveal_bids_cannot_be_front_run_while_reveals_are_outstanding() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let attacker = Address::generate(&env);
        let victim = Address::generate(&env);
        let task_id = Symbol::new(&env, "frontrun");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s_a = salt(&env, 101);
        let s_v = salt(&env, 102);
        let t = terms(&env, "T");

        // The attacker's bid is far worse; only racing the finalisation could
        // ever make it win.
        let c_a = client.commitment_of(&task_id, &attacker, &9_000_000, &t, &s_a);
        let c_v = client.commitment_of(&task_id, &victim, &1_200_000, &t, &s_v);
        client.submit_bid(&task_id, &attacker, &c_a, &BOND, &10);
        client.submit_bid(&task_id, &victim, &c_v, &BOND, &95);

        enter_reveal_window(&env, &client, &task_id);

        // Attacker reveals first and tries to close the auction on the spot.
        client.reveal_bid(&task_id, &attacker, &9_000_000, &t, &s_a);
        let err = client.try_reveal_bids(&attacker, &task_id);
        assert_eq!(
            err.err(),
            Some(Ok(Error::RevealPeriodActive)),
            "finalising must be refused while a sealed bid is still unrevealed"
        );

        // The victim reveals inside the window and wins.
        client.reveal_bid(&task_id, &victim, &1_200_000, &t, &s_v);
        client.reveal_bids(&attacker, &task_id);
        assert_eq!(client.get_winner(&task_id).unwrap(), victim);
    }

    /// Once nothing is outstanding there is no race left, so the auction may
    /// be finalised before the reveal window elapses.
    #[test]
    fn reveal_bids_finalises_early_when_every_bid_is_revealed() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let task_id = Symbol::new(&env, "all_in");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let t = terms(&env, "T");
        let s_a = salt(&env, 103);
        let s_b = salt(&env, 104);
        let c_a = client.commitment_of(&task_id, &a, &2_000_000, &t, &s_a);
        let c_b = client.commitment_of(&task_id, &b, &3_000_000, &t, &s_b);
        client.submit_bid(&task_id, &a, &c_a, &BOND, &80);
        client.submit_bid(&task_id, &b, &c_b, &BOND, &80);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &a, &2_000_000, &t, &s_a);
        client.reveal_bid(&task_id, &b, &3_000_000, &t, &s_b);

        // Reveal window is still open, but nothing is outstanding.
        let auction = client.get_auction(&task_id).unwrap();
        assert!(env.ledger().timestamp() < auction.reveal_deadline);

        client.reveal_bids(&anyone, &task_id);
        assert_eq!(client.get_winner(&task_id).unwrap(), a);
    }

    // ── reveal_bids ──────────────────────────────────────────────────────────

    #[test]
    fn reveal_bids_selects_cheapest_when_reputation_equal() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "score_test");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let s_a = salt(&env, 11);
        let s_b = salt(&env, 12);
        let price_a: i128 = 2_000_000;
        let price_b: i128 = 5_000_000;
        let terms_a = terms(&env, "Cheap");
        let terms_b = terms(&env, "Expensive");

        let c_a = client.commitment_of(&task_id, &a, &price_a, &terms_a, &s_a);
        let c_b = client.commitment_of(&task_id, &b, &price_b, &terms_b, &s_b);
        client.submit_bid(&task_id, &a, &c_a, &BOND, &80);
        client.submit_bid(&task_id, &b, &c_b, &BOND, &80);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &a, &price_a, &terms_a, &s_a);
        client.reveal_bid(&task_id, &b, &price_b, &terms_b, &s_b);

        client.reveal_bids(&anyone, &task_id);

        assert_eq!(
            client.get_winner(&task_id).unwrap(),
            a,
            "cheaper bidder A should win at equal reputation"
        );

        let bid_a = client.get_bid(&task_id, &a).unwrap();
        let bid_b = client.get_bid(&task_id, &b).unwrap();
        assert!(
            bid_a.score > bid_b.score,
            "A should have higher score than B"
        );
    }

    #[test]
    fn reveal_bids_selects_high_reputation_on_price_tie() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "score_best");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let x = Address::generate(&env);
        let y = Address::generate(&env);
        let price: i128 = 5_000_000;
        let s_x = salt(&env, 13);
        let s_y = salt(&env, 14);
        let t_x = terms(&env, "Premium");
        let t_y = terms(&env, "Bargain");

        let c_x = client.commitment_of(&task_id, &x, &price, &t_x, &s_x);
        let c_y = client.commitment_of(&task_id, &y, &price, &t_y, &s_y);
        client.submit_bid(&task_id, &x, &c_x, &BOND, &100);
        client.submit_bid(&task_id, &y, &c_y, &BOND, &10);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &x, &price, &t_x, &s_x);
        client.reveal_bid(&task_id, &y, &price, &t_y, &s_y);

        client.reveal_bids(&anyone, &task_id);

        // At 60/40 weighting, when prices are identical the higher reputation wins.
        assert_eq!(
            client.get_winner(&task_id).unwrap(),
            x,
            "on price tie, higher-reputation bidder X should win"
        );
    }

    #[test]
    fn reveal_bids_no_revealed_fails() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "no_rev");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);
        close_reveal_window(&env, &client, &task_id);

        // No bid was submitted at all.
        let err = client.try_reveal_bids(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotEnoughBids)));
    }

    #[test]
    fn reveal_bids_before_deadline_fails() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "early_rb");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let err = client.try_reveal_bids(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::BiddingPeriodActive)));
    }

    #[test]
    fn reveal_bids_emits_event() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "rb_event");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let bidder = Address::generate(&env);
        let s = salt(&env, 15);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Solo");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &75);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);

        let _ = env.events().all(); // drain

        client.reveal_bids(&anyone, &task_id);

        let events = env.events().all();
        assert_eq!(events.len(), 1, "expected exactly one BidsRevealed event");
    }

    #[test]
    fn reveal_bids_twice_fails() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "rb_twice");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 16);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Solo");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &75);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);
        client.reveal_bids(&anyone, &task_id);

        let err = client.try_reveal_bids(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotInBiddingPhase)));
    }

    // ── award_contract ───────────────────────────────────────────────────────

    #[test]
    fn award_contract_creates_escrow_and_refunds() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "award_ok");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let bidder = Address::generate(&env);
        let s = salt(&env, 17);
        let price: i128 = 4_000_000;
        let t = terms(&env, "Winner");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);
        client.reveal_bids(&anyone, &task_id);

        client.award_contract(&creator, &task_id);

        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.phase, AuctionPhase::Awarded);
        assert!(auction.escrow_created);

        let escrow = client.get_escrow(&task_id).unwrap();
        assert_eq!(escrow.agent, bidder);
        assert_eq!(escrow.amount, price); // winning price locked

        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert!(bid.refunded);
        assert!(!bid.forfeited);
    }

    #[test]
    fn award_contract_refunds_all_revealed_bidders() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "refund_all");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let winner = Address::generate(&env);
        let loser = Address::generate(&env);
        let price_w: i128 = 1_000_000;
        let price_l: i128 = 10_000_000;
        let s_w = salt(&env, 18);
        let s_l = salt(&env, 19);
        let t_w = terms(&env, "Win");
        let t_l = terms(&env, "Lose");

        let c_w = client.commitment_of(&task_id, &winner, &price_w, &t_w, &s_w);
        let c_l = client.commitment_of(&task_id, &loser, &price_l, &t_l, &s_l);
        client.submit_bid(&task_id, &winner, &c_w, &BOND, &80);
        client.submit_bid(&task_id, &loser, &c_l, &BOND, &80);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &winner, &price_w, &t_w, &s_w);
        client.reveal_bid(&task_id, &loser, &price_l, &t_l, &s_l);
        client.reveal_bids(&anyone, &task_id);

        client.award_contract(&creator, &task_id);

        assert!(
            client.get_bid(&task_id, &winner).unwrap().refunded,
            "winner's bond should be refunded"
        );
        assert!(
            client.get_bid(&task_id, &loser).unwrap().refunded,
            "revealing loser's bond should be refunded"
        );
    }

    /// A bidder who commits and never reveals loses their bond. That price is
    /// what stops a sealed bid from being a free option to walk away.
    #[test]
    fn award_contract_forfeits_bonds_of_non_revealers() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "forfeit");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let honest = Address::generate(&env);
        let ghost = Address::generate(&env);
        let s_h = salt(&env, 111);
        let s_g = salt(&env, 112);
        let t = terms(&env, "T");
        let price_h: i128 = 3_000_000;

        let c_h = client.commitment_of(&task_id, &honest, &price_h, &t, &s_h);
        let c_g = client.commitment_of(&task_id, &ghost, &1_100_000, &t, &s_g);
        client.submit_bid(&task_id, &honest, &c_h, &BOND, &50);
        client.submit_bid(&task_id, &ghost, &c_g, &BOND, &99);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &honest, &price_h, &t, &s_h);

        close_reveal_window(&env, &client, &task_id);
        client.reveal_bids(&anyone, &task_id);
        client.award_contract(&creator, &task_id);

        let honest_bid = client.get_bid(&task_id, &honest).unwrap();
        assert!(honest_bid.refunded);
        assert!(!honest_bid.forfeited);

        let ghost_bid = client.get_bid(&task_id, &ghost).unwrap();
        assert!(
            ghost_bid.forfeited,
            "a bidder who never revealed must forfeit their bond"
        );
        assert!(!ghost_bid.refunded);
    }

    #[test]
    fn award_contract_before_reveal_bids_fails() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "pre_award");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let bidder = Address::generate(&env);
        let s = salt(&env, 20);
        let price: i128 = 3_000_000;
        let t = terms(&env, "Wait");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);

        // Not yet revealed_bids → phase is still Bidding.
        let err = client.try_award_contract(&creator, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotInRevealPhase)));
    }

    #[test]
    fn award_contract_twice_fails() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "twice_award");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let bidder = Address::generate(&env);
        let s = salt(&env, 21);
        let price: i128 = 5_000_000;
        let t = terms(&env, "Solo");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &80);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);
        client.reveal_bids(&anyone, &task_id);
        client.award_contract(&creator, &task_id);

        let err = client.try_award_contract(&creator, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::AlreadyAwarded)));
    }

    #[test]
    fn award_contract_rejects_unrelated_caller() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let stranger = Address::generate(&env);
        let task_id = Symbol::new(&env, "stranger");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let bidder = Address::generate(&env);
        let s = salt(&env, 22);
        let price: i128 = 5_000_000;
        let t = terms(&env, "Solo");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &80);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);
        client.reveal_bids(&anyone, &task_id);

        let err = client.try_award_contract(&stranger, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::Unauthorized)));

        // The winner is the other party allowed to close it out.
        client.award_contract(&bidder, &task_id);
        assert_eq!(
            client.get_auction(&task_id).unwrap().phase,
            AuctionPhase::Awarded
        );
    }

    // ── abort_auction ────────────────────────────────────────────────────────

    #[test]
    fn abort_auction_releases_bonds_when_nobody_reveals() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "dead");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let t = terms(&env, "T");
        let c_a = client.commitment_of(&task_id, &a, &2_000_000, &t, &salt(&env, 121));
        let c_b = client.commitment_of(&task_id, &b, &3_000_000, &t, &salt(&env, 122));
        client.submit_bid(&task_id, &a, &c_a, &BOND, &50);
        client.submit_bid(&task_id, &b, &c_b, &BOND, &50);

        close_reveal_window(&env, &client, &task_id);

        // Without the rescue path this auction is unfinalisable.
        let err = client.try_reveal_bids(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotEnoughBids)));

        client.abort_auction(&anyone, &task_id);

        assert_eq!(
            client.get_auction(&task_id).unwrap().phase,
            AuctionPhase::Cancelled
        );
        for bidder in [&a, &b] {
            let bid = client.get_bid(&task_id, bidder).unwrap();
            assert!(bid.refunded, "abort must release every bond");
            assert!(!bid.forfeited);
        }
    }

    #[test]
    fn abort_auction_rejected_while_reveal_window_open() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "too_early");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);
        enter_reveal_window(&env, &client, &task_id);

        let err = client.try_abort_auction(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::RevealPeriodActive)));
    }

    #[test]
    fn abort_auction_rejected_when_a_bid_was_revealed() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "has_rev");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 123);
        let price: i128 = 2_000_000;
        let t = terms(&env, "T");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);
        close_reveal_window(&env, &client, &task_id);

        let err = client.try_abort_auction(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::AuctionNotAbortable)));
    }

    #[test]
    fn cancelled_auction_accepts_no_further_calls() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "closed");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 124);
        let price: i128 = 2_000_000;
        let t = terms(&env, "T");
        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &50);

        close_reveal_window(&env, &client, &task_id);
        client.abort_auction(&anyone, &task_id);

        let err = client.try_reveal_bid(&task_id, &bidder, &price, &t, &s);
        assert_eq!(err.err(), Some(Ok(Error::AuctionClosed)));

        let err = client.try_reveal_bids(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::AuctionClosed)));

        let err = client.try_abort_auction(&anyone, &task_id);
        assert_eq!(err.err(), Some(Ok(Error::AuctionClosed)));
    }

    // ── Views ────────────────────────────────────────────────────────────────

    #[test]
    fn get_bidders_pages_and_clamps_limit() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "paged");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let mut submitted: std::vec::Vec<Address> = std::vec::Vec::new();
        for i in 0..5u8 {
            let bidder = Address::generate(&env);
            let c = client.commitment_of(
                &task_id,
                &bidder,
                &2_000_000,
                &terms(&env, "x"),
                &salt(&env, 130 + i),
            );
            client.submit_bid(&task_id, &bidder, &c, &BOND, &50);
            submitted.push(bidder);
        }

        let first = client.get_bidders(&task_id, &0, &2);
        assert_eq!(first.len(), 2);
        assert_eq!(first.get(0).unwrap(), submitted[0]);
        assert_eq!(first.get(1).unwrap(), submitted[1]);

        let tail = client.get_bidders(&task_id, &3, &10);
        assert_eq!(tail.len(), 2, "page must stop at the end of the list");

        // An over-large limit is clamped, never honoured verbatim.
        let clamped = client.get_bidders(&task_id, &0, &u32::MAX);
        assert_eq!(clamped.len(), 5);

        // Out-of-range start yields an empty page rather than panicking.
        assert_eq!(client.get_bidders(&task_id, &99, &10).len(), 0);
    }

    #[test]
    fn commitment_of_matches_what_reveal_verifies() {
        let (env, client, _) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "commit_of");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let s = salt(&env, 140);
        let price: i128 = 2_500_000;
        let t = terms(&env, "Published helper");

        let c = client.commitment_of(&task_id, &bidder, &price, &t, &s);
        client.submit_bid(&task_id, &bidder, &c, &BOND, &60);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &bidder, &price, &t, &s);

        assert!(client.get_bid(&task_id, &bidder).unwrap().revealed);
    }

    // ── Full end-to-end flow ─────────────────────────────────────────────────

    #[test]
    fn full_sealed_bid_reveal_award_flow() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "e2e");

        // 1. Create auction.
        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);
        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.phase, AuctionPhase::Bidding);

        // 2. Three bidders submit sealed bids.
        let (bidder1, price1, rep1) = (Address::generate(&env), 2_000_000i128, 60u32);
        let (bidder2, price2, rep2) = (Address::generate(&env), 3_000_000i128, 90u32);
        let (bidder3, price3, rep3) = (Address::generate(&env), 5_000_000i128, 50u32);

        let t1 = terms(&env, "Offer 1");
        let t2 = terms(&env, "Offer 2");
        let t3 = terms(&env, "Offer 3");
        let s1 = salt(&env, 21);
        let s2 = salt(&env, 22);
        let s3 = salt(&env, 23);

        let comm1 = client.commitment_of(&task_id, &bidder1, &price1, &t1, &s1);
        let comm2 = client.commitment_of(&task_id, &bidder2, &price2, &t2, &s2);
        let comm3 = client.commitment_of(&task_id, &bidder3, &price3, &t3, &s3);

        client.submit_bid(&task_id, &bidder1, &comm1, &BOND, &rep1);
        client.submit_bid(&task_id, &bidder2, &comm2, &BOND, &rep2);
        client.submit_bid(&task_id, &bidder3, &comm3, &BOND, &rep3);

        assert_eq!(client.get_bidder_count(&task_id), 3);

        // Sealed — no prices visible.
        let sealed = client.get_bid(&task_id, &bidder1).unwrap();
        assert!(!sealed.revealed);
        assert_eq!(sealed.price_stroops, 0);

        // 3. Advance into the reveal window, reveal all.
        enter_reveal_window(&env, &client, &task_id);

        client.reveal_bid(&task_id, &bidder1, &price1, &t1, &s1);
        client.reveal_bid(&task_id, &bidder2, &price2, &t2, &s2);
        client.reveal_bid(&task_id, &bidder3, &price3, &t3, &s3);

        assert!(client.get_bid(&task_id, &bidder1).unwrap().revealed);
        assert_eq!(
            client.get_bid(&task_id, &bidder2).unwrap().price_stroops,
            price2
        );

        // 4. Finalise reveals → winner selected.
        client.reveal_bids(&anyone, &task_id);

        let winner = client.get_winner(&task_id).unwrap();
        // bidder2 has highest reputation (90) at moderate price (3M).
        // bidder1: 2M, rep 60 → cheaper but lower rep. bidder3: 5M, rep 50.
        // At 60/40, bidder2 should win (rep advantage outweighs price delta).
        assert_eq!(
            winner, bidder2,
            "bidder2 with best composite score should win"
        );

        assert_eq!(
            client.get_auction(&task_id).unwrap().phase,
            AuctionPhase::Reveal
        );

        // 5. Award contract.
        client.award_contract(&creator, &task_id);

        let final_auction = client.get_auction(&task_id).unwrap();
        assert_eq!(final_auction.phase, AuctionPhase::Awarded);
        assert!(final_auction.escrow_created);

        let escrow = client.get_escrow(&task_id).unwrap();
        assert_eq!(escrow.agent, bidder2);
        assert_eq!(escrow.amount, price2);

        // Everyone revealed, so every bond comes back.
        for b in [&bidder1, &bidder2, &bidder3] {
            let bid = client.get_bid(&task_id, b).unwrap();
            assert!(bid.refunded, "bidder's bond should be refunded");
            assert!(!bid.forfeited);
        }
    }

    #[test]
    fn winner_selection_price_preference_on_tie() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "tie");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let cheap = Address::generate(&env);
        let ex = Address::generate(&env);
        let s1 = salt(&env, 31);
        let s2 = salt(&env, 32);
        let t = terms(&env, "X");

        let c1 = client.commitment_of(&task_id, &cheap, &2_000_000, &t, &s1);
        let c2 = client.commitment_of(&task_id, &ex, &10_000_000, &t, &s2);
        client.submit_bid(&task_id, &cheap, &c1, &BOND, &80);
        client.submit_bid(&task_id, &ex, &c2, &BOND, &80);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &cheap, &2_000_000, &t, &s1);
        client.reveal_bid(&task_id, &ex, &10_000_000, &t, &s2);
        client.reveal_bids(&anyone, &task_id);

        assert_eq!(client.get_winner(&task_id).unwrap(), cheap);
    }

    #[test]
    fn non_revealed_bidder_cannot_win() {
        let (env, client, anyone) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "no_show");

        create_test_auction(&env, &client, &creator, &task_id, BID_SECS);

        let rev = Address::generate(&env);
        let noshow = Address::generate(&env);
        let s_r = salt(&env, 41);
        let s_n = salt(&env, 42);
        let t = terms(&env, "Terms");

        let c_r = client.commitment_of(&task_id, &rev, &5_000_000, &t, &s_r);
        let c_n = client.commitment_of(&task_id, &noshow, &RESERVE, &t, &s_n);
        client.submit_bid(&task_id, &rev, &c_r, &BOND, &50);
        client.submit_bid(&task_id, &noshow, &c_n, &BOND, &90);

        enter_reveal_window(&env, &client, &task_id);
        client.reveal_bid(&task_id, &rev, &5_000_000, &t, &s_r);

        // The no-show never reveals, so the auction can only be finalised once
        // the reveal window has closed.
        close_reveal_window(&env, &client, &task_id);
        client.reveal_bids(&anyone, &task_id);

        assert_eq!(
            client.get_winner(&task_id).unwrap(),
            rev,
            "only revealed bidder can win"
        );
    }
}
