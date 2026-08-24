#![no_std]

//! # Agent Bidding Contract
//!
//! On-chain sealed-bid auction for AI agent tasks. Agents compete for work by
//! submitting **sealed bids** (commitments) during a configurable bidding
//! period. After the period closes, bidders reveal their plaintext prices and
//! terms. The contract verifies each commitment and selects a winner via a
//! weighted-score algorithm (60 % price, 40 % reputation). The creator then
//! awards the contract, which creates an escrow for the winning price and
//! refunds the bonds of every losing bidder.
//!
//! ## Flow
//!
//! 1. **`create_auction`** — creator initialises the auction with duration,
//!    reserve price, and required bond. Phase = `Bidding`.
//! 2. **`submit_bid`** — agents submit sealed commitments during the bidding
//!    window. Each bid locks the required bond and records a self-declared
//!    reputation score.
//! 3. **`reveal_bid`** — after the deadline, each bidder reveals their
//!    plaintext `(price, terms, salt)`. The contract verifies the SHA-256
//!    commitment.
//! 4. **`reveal_bids`** — anyone calls this after the deadline to finalise the
//!    reveal phase. The contract normalises price and reputation across all
//!    revealed bids, computes composite scores, and selects the winner.
//!    Phase → `Reveal`.
//! 5. **`award_contract`** — the creator (or anyone, after winner is
//!    determined) creates the escrow entry for the winning price and marks
//!    every bidder's bond as refunded. Phase → `Awarded`.
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
//! Tie-break: highest score wins. If scores are equal, the lowest-price bid
//! wins. If prices are also equal, the earliest submission by order in the
//! bidders list wins.
//!
//! ## Commitment Hash
//!
//! ```text
//! commitment = SHA-256(bidder_xdr || i128_price_xdr || terms_xdr || salt_xdr)
//! ```
//!
//! Each field is serialised to its Stellar XDR wire format. Off-chain tooling
//! must produce commitments using this exact encoding.

mod errors;
mod types;

pub use errors::Error;
pub use types::{
    Auction, AuctionConfig, AuctionCreatedEvent, AuctionPhase, BidRevealedEvent, BidSubmittedEvent,
    BidsRevealedEvent, ContractAwardedEvent, DataKey, Escrow, SealedBid,
    DEFAULT_BIDDING_DURATION_SECS, MAX_REPUTATION, PRICE_WEIGHT, REPUTATION_WEIGHT, SCORE_SCALE,
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

/// Recompute the commitment hash from plaintext fields.
///
/// The preimage layout matches the off-chain construction:
/// `bidder_xdr || price_xdr || terms_xdr || salt_xdr`.
fn compute_commitment(
    env: &Env,
    bidder: &Address,
    price: i128,
    terms: &String,
    salt: &BytesN<32>,
) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.append(&bidder.to_xdr(env));
    preimage.append(&price.to_xdr(env));
    preimage.append(&terms.clone().to_xdr(env));
    preimage.append(&salt.to_xdr(env));
    env.crypto().sha256(&preimage).into()
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentBiddingContract;

#[contractimpl]
impl AgentBiddingContract {
    // ── Creation ─────────────────────────────────────────────────────────

    /// Initialise a new auction for `task_id`.
    ///
    /// The `creator` must authorise the call. If `duration_secs` is `0`,
    /// [`DEFAULT_BIDDING_DURATION_SECS`] (1 hour) is used. The task must not
    /// already have an auction. Emits `(bidding, created)`.
    pub fn create_auction(
        env: Env,
        creator: Address,
        task_id: Symbol,
        duration_secs: u64,
        reserve_price: i128,
        bond: i128,
    ) -> Result<(), Error> {
        creator.require_auth();

        let auct_key = DataKey::Auction(task_id.clone());
        if env.storage().persistent().has(&auct_key) {
            return Err(Error::AlreadyExists);
        }

        if bond <= 0 {
            return Err(Error::InvalidBond);
        }
        if reserve_price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let dur = if duration_secs == 0 {
            DEFAULT_BIDDING_DURATION_SECS
        } else {
            duration_secs
        };

        let now = env.ledger().timestamp();
        let deadline = now.saturating_add(dur);

        let auction = Auction {
            task_id: task_id.clone(),
            creator: creator.clone(),
            config: AuctionConfig {
                duration_secs: dur,
                reserve_price,
                bond,
            },
            created_at: now,
            deadline,
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
                duration_secs: dur,
                deadline,
                reserve_price,
                bond,
            },
        );

        Ok(())
    }

    // ── Submit Sealed Bid ─────────────────────────────────────────────────

    /// Submit a sealed bid during the bidding period.
    ///
    /// * `bidder` — must authorise this call.
    /// * `commitment` — SHA-256 of `(bidder, price, terms, salt)` encoded in XDR.
    /// * `bond` — must equal the auction's required bond.
    /// * `reputation` — self-declared score in `[0, 100]`.
    ///
    /// Emits `(bidding, bid_submitted)`.
    pub fn submit_bid(
        env: Env,
        task_id: Symbol,
        bidder: Address,
        commitment: BytesN<32>,
        bond: i128,
        reputation: u32,
    ) -> Result<(), Error> {
        bidder.require_auth();

        let auct_key = DataKey::Auction(task_id.clone());
        let auction: Auction = env
            .storage()
            .persistent()
            .get(&auct_key)
            .ok_or(Error::NotFound)?;

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
            commitment: commitment.clone(),
            bond,
            reputation,
            revealed: false,
            refunded: false,
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

    /// Reveal a previously sealed bid after the bidding period has ended.
    ///
    /// The caller provides the plaintext `(price_stroops, terms, salt)`. The
    /// contract recomputes the commitment hash and compares it to the stored
    /// commitment. A mismatch returns [`Error::InvalidCommitment`].
    ///
    /// * `price_stroops` — must be positive and at least the reserve price.
    /// * `terms` — arbitrary bid terms (may be empty).
    /// * `salt` — 32-byte blinding factor used to hide the bid preimage.
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

        let auct_key = DataKey::Auction(task_id.clone());
        let auction: Auction = env
            .storage()
            .persistent()
            .get(&auct_key)
            .ok_or(Error::NotFound)?;

        if auction.phase != AuctionPhase::Bidding {
            return Err(Error::NotInBiddingPhase);
        }

        let now = env.ledger().timestamp();
        if now < auction.deadline {
            return Err(Error::BiddingPeriodActive);
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

        // Verify commitment.
        let recomputed = compute_commitment(&env, &bidder, price_stroops, &terms, &salt);
        if recomputed != sealed.commitment {
            return Err(Error::InvalidCommitment);
        }

        if price_stroops <= 0 || price_stroops < auction.config.reserve_price {
            return Err(Error::InvalidPrice);
        }

        sealed.revealed = true;
        sealed.price_stroops = price_stroops;
        sealed.terms = terms.clone();
        env.storage().persistent().set(&bid_key, &sealed);
        extend_ttl_for_key(&env, &bid_key);

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
    /// Can be called by anyone after the bidding deadline. Iterates over all
    /// revealed bids, normalises price and reputation across them, computes
    /// the weighted composite score for each, and stores the winning bidder's
    /// address. Non-revealed bids do **not** enter the scoring and cannot win.
    ///
    /// Requires at least one revealed bid. Phase transitions to `Reveal`.
    /// Emits `(bidding, bids_rvld)`.
    pub fn reveal_bids(env: Env, task_id: Symbol) -> Result<(), Error> {
        let auct_key = DataKey::Auction(task_id.clone());
        let mut auction: Auction = env
            .storage()
            .persistent()
            .get(&auct_key)
            .ok_or(Error::NotFound)?;

        if auction.phase != AuctionPhase::Bidding {
            return Err(Error::NotInBiddingPhase);
        }

        let now = env.ledger().timestamp();
        if now < auction.deadline {
            return Err(Error::BiddingPeriodActive);
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

        for i in 0..bidders.len() {
            let bidder = bidders.get(i).unwrap();
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

        // Phase 2: compute scores.
        let price_range = max_price - min_price;
        let rep_range = (max_rep - min_rep) as i128;

        // Collect scored bids index-mapped back to the bidders list.
        let mut best_score: i128 = -1;
        let mut best_price: i128 = i128::MAX;
        let mut winner: Option<Address> = None;

        for i in 0..revealed.len() {
            let bid = revealed.get(i).unwrap();

            let price_score: i128 = if price_range == 0 {
                SCORE_SCALE
            } else {
                SCORE_SCALE * (max_price - bid.price_stroops) / price_range
            };

            let rep_score: i128 = if rep_range == 0 {
                SCORE_SCALE
            } else {
                SCORE_SCALE * (bid.reputation - min_rep) as i128 / rep_range
            };

            let score = (PRICE_WEIGHT * price_score + REPUTATION_WEIGHT * rep_score) / 100;

            // Update the stored bid with its score.
            let bid_key = DataKey::Bid(task_id.clone(), bid.bidder.clone());
            let mut stored: SealedBid = env.storage().persistent().get(&bid_key).unwrap();
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
        env.storage().persistent().set(&auct_key, &auction);
        extend_ttl_for_key(&env, &auct_key);

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
    /// Creates an escrow entry locking the winning price for the winning
    /// agent. Every bidder's bond is marked as refunded (the bond is an
    /// anti-spam deposit returned to everyone once the auction concludes —
    /// it is separate from the escrow amount).
    ///
    /// Phase transitions to `Awarded`. Emits `(bidding, cntrct_aw)`.
    pub fn award_contract(env: Env, task_id: Symbol) -> Result<(), Error> {
        let auct_key = DataKey::Auction(task_id.clone());
        let mut auction: Auction = env
            .storage()
            .persistent()
            .get(&auct_key)
            .ok_or(Error::NotFound)?;

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

        // Refund every bidder's bond (winner included).
        let bidders_key = DataKey::Bidders(task_id.clone());
        let bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&bidders_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut refunded_count: u32 = 0;
        let mut ttl_keys: Vec<DataKey> = Vec::new(&env);
        for i in 0..bidders.len() {
            let b = bidders.get(i).unwrap();
            let bk = DataKey::Bid(task_id.clone(), b);
            if let Some(mut bid) = env.storage().persistent().get::<_, SealedBid>(&bk) {
                if !bid.refunded {
                    bid.refunded = true;
                    env.storage().persistent().set(&bk, &bid);
                    ttl_keys.push_back(bk);
                    refunded_count += 1;
                }
            }
        }
        extend_ttl_batch(&env, &ttl_keys);

        auction.phase = AuctionPhase::Awarded;
        auction.escrow_created = true;
        env.storage().persistent().set(&auct_key, &auction);
        extend_ttl_for_key(&env, &auct_key);

        env.events().publish(
            (symbol_short!("bidding"), symbol_short!("cntrct_aw")),
            ContractAwardedEvent {
                task_id,
                winner,
                escrow_amount,
                refunded_bidders: refunded_count,
            },
        );

        Ok(())
    }

    // ── View Functions ─────────────────────────────────────────────────────

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
        let bidders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Bidders(task_id))
            .unwrap_or_else(|| Vec::new(&env));
        bidders.len()
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

    /// Creates a fresh in-memory test environment with the contract registered.
    fn setup() -> (Env, AgentBiddingContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(AgentBiddingContract, ());
        let client = AgentBiddingContractClient::new(&env, &id);
        (env, client)
    }

    /// Helper: create a test auction with default config.
    fn create_test_auction(
        _env: &Env,
        client: &AgentBiddingContractClient<'static>,
        creator: &Address,
        task_id: &Symbol,
        duration_secs: u64,
    ) {
        client.create_auction(
            creator,
            task_id,
            &duration_secs,
            &1_000_000, // reserve price: 0.1 XLM in stroops
            &500_000,   // bond: 0.05 XLM
        );
    }

    /// Compute a commitment hash compatible with `compute_commitment` in the contract.
    fn test_commitment(
        env: &Env,
        bidder: &Address,
        price: i128,
        terms: &String,
        salt: &BytesN<32>,
    ) -> BytesN<32> {
        let mut preimage = Bytes::new(env);
        preimage.append(&bidder.to_xdr(env));
        preimage.append(&price.to_xdr(env));
        preimage.append(&terms.clone().to_xdr(env));
        preimage.append(&salt.to_xdr(env));
        env.crypto().sha256(&preimage).into()
    }

    // ── create_auction ───────────────────────────────────────────────────────

    #[test]
    fn create_auction_stores_record() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "task_1");

        client.create_auction(
            &creator, &task_id, &0, // 0 → default duration
            &1_000_000, &500_000,
        );

        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.creator, creator);
        assert_eq!(auction.phase, AuctionPhase::Bidding);
        assert!(!auction.escrow_created);
        assert_eq!(auction.config.duration_secs, DEFAULT_BIDDING_DURATION_SECS);
        assert_eq!(
            auction.deadline,
            auction.created_at + DEFAULT_BIDDING_DURATION_SECS
        );
    }

    #[test]
    fn create_auction_duplicate_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "dup");

        client.create_auction(&creator, &task_id, &0, &1_000_000, &500_000);
        let err = client.try_create_auction(&creator, &task_id, &0, &1_000_000, &500_000);
        assert!(err.is_err());
        assert_eq!(err.err(), Some(Ok(Error::AlreadyExists)));
    }

    #[test]
    fn create_auction_emits_event() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "events");

        client.create_auction(&creator, &task_id, &0, &1_000_000, &500_000);

        let all_events = env.events().all();
        assert!(!all_events.is_empty(), "expected at least one event");
    }

    // ── submit_bid ───────────────────────────────────────────────────────────

    #[test]
    fn submit_bid_succeeds() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bid_test");

        create_test_auction(&env, &client, &creator, &task_id, 3_600);

        let salt = BytesN::<32>::from_array(&env, &[1u8; 32]);
        let price: i128 = 5_000_000;
        let terms = String::from_str(&env, "Deliver in 3 days");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &85);

        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert_eq!(bid.bidder, bidder);
        assert_eq!(bid.commitment, commitment);
        assert_eq!(bid.bond, 500_000);
        assert_eq!(bid.reputation, 85);
        assert!(!bid.revealed);
        assert_eq!(client.get_bidder_count(&task_id), 1);
    }

    #[test]
    fn submit_bid_emits_event() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bid_event");

        create_test_auction(&env, &client, &creator, &task_id, 3_600);

        let salt = BytesN::<32>::from_array(&env, &[2u8; 32]);
        let price: i128 = 3_000_000;
        let terms = String::from_str(&env, "Fast track");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        // Clear events from create_auction by draining.
        let _ = env.events().all();

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &90);

        let events = env.events().all();
        assert_eq!(events.len(), 1, "expected exactly one BidSubmitted event");
    }

    #[test]
    fn submit_bid_after_deadline_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "late");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Advance ledger past the deadline.
        let auction = client.get_auction(&task_id).unwrap();
        env.ledger().set_timestamp(auction.deadline + 1);

        let salt = BytesN::<32>::from_array(&env, &[3u8; 32]);
        let price: i128 = 2_000_000;
        let terms = String::from_str(&env, "Late bid");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &500_000, &50);
        assert_eq!(err.err(), Some(Ok(Error::BiddingPeriodEnded)));
    }

    #[test]
    fn submit_bid_invalid_reputation_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bad_rep");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[4u8; 32]);
        let price: i128 = 2_000_000;
        let terms = String::from_str(&env, "Bad rep");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &500_000, &101);
        assert_eq!(err.err(), Some(Ok(Error::InvalidReputation)));
    }

    #[test]
    fn submit_bid_wrong_bond_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bad_bond");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[5u8; 32]);
        let commitment =
            test_commitment(&env, &bidder, 1_000_000, &String::from_str(&env, ""), &salt);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &1, &50);
        assert_eq!(err.err(), Some(Ok(Error::InvalidBond)));
    }

    #[test]
    fn submit_bid_duplicate_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "dup_bid");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[6u8; 32]);
        let price: i128 = 2_000_000;
        let terms = String::from_str(&env, "First");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &80);

        let err = client.try_submit_bid(&task_id, &bidder, &commitment, &500_000, &80);
        assert_eq!(err.err(), Some(Ok(Error::BidAlreadyExists)));
    }

    // ── reveal_bid ───────────────────────────────────────────────────────────

    #[test]
    fn reveal_bid_verifies_commitment() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "reveal_ok");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[7u8; 32]);
        let price: i128 = 4_000_000;
        let terms = String::from_str(&env, "Best offer");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &70);

        // Advance past deadline.
        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &bidder, &price, &terms, &salt);

        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert!(bid.revealed);
        assert_eq!(bid.price_stroops, price);
        assert_eq!(bid.terms, terms);
    }

    #[test]
    fn reveal_bid_wrong_commitment_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "bad_rev");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[8u8; 32]);
        let price: i128 = 4_000_000;
        let terms = String::from_str(&env, "Real");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &70);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        // Try to reveal with a different price.
        let err = client.try_reveal_bid(&task_id, &bidder, &(price + 1), &terms, &salt);
        assert_eq!(err.err(), Some(Ok(Error::InvalidCommitment)));
    }

    #[test]
    fn reveal_bid_before_deadline_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "early_rev");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[9u8; 32]);
        let price: i128 = 5_000_000;
        let terms = String::from_str(&env, "Early");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &60);

        // Do NOT advance ledger — still within deadline.
        let err = client.try_reveal_bid(&task_id, &bidder, &price, &terms, &salt);
        assert_eq!(err.err(), Some(Ok(Error::BiddingPeriodActive)));
    }

    #[test]
    fn reveal_bid_twice_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let bidder = Address::generate(&env);
        let task_id = Symbol::new(&env, "twice_rev");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let salt = BytesN::<32>::from_array(&env, &[10u8; 32]);
        let price: i128 = 3_000_000;
        let terms = String::from_str(&env, "Twice");
        let commitment = test_commitment(&env, &bidder, price, &terms, &salt);

        client.submit_bid(&task_id, &bidder, &commitment, &500_000, &80);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &bidder, &price, &terms, &salt);

        let err = client.try_reveal_bid(&task_id, &bidder, &price, &terms, &salt);
        assert_eq!(err.err(), Some(Ok(Error::BidAlreadyRevealed)));
    }

    // ── reveal_bids (winner selection) ───────────────────────────────────────

    #[test]
    fn reveal_bids_selects_cheapest_when_reputation_equal() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "score_test");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Bidder A: cheaper, same reputation.
        let a = Address::generate(&env);
        let salt_a = BytesN::<32>::from_array(&env, &[11u8; 32]);
        let price_a: i128 = 2_000_000;
        let terms_a = String::from_str(&env, "Cheap");
        let comm_a = test_commitment(&env, &a, price_a, &terms_a, &salt_a);
        client.submit_bid(&task_id, &a, &comm_a, &500_000, &80);

        // Bidder B: more expensive, same reputation.
        let b = Address::generate(&env);
        let salt_b = BytesN::<32>::from_array(&env, &[12u8; 32]);
        let price_b: i128 = 5_000_000;
        let terms_b = String::from_str(&env, "Expensive");
        let comm_b = test_commitment(&env, &b, price_b, &terms_b, &salt_b);
        client.submit_bid(&task_id, &b, &comm_b, &500_000, &80);

        // Advance past deadline and reveal.
        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &a, &price_a, &terms_a, &salt_a);
        client.reveal_bid(&task_id, &b, &price_b, &terms_b, &salt_b);

        client.reveal_bids(&task_id);

        let winner = client.get_winner(&task_id).unwrap();
        assert_eq!(winner, a, "cheaper bidder A should win at equal reputation");

        // Verify scores are stored.
        let bid_a = client.get_bid(&task_id, &a).unwrap();
        let bid_b = client.get_bid(&task_id, &b).unwrap();
        assert!(
            bid_a.score > bid_b.score,
            "A should have higher score than B"
        );
    }

    #[test]
    fn reveal_bids_selects_high_reputation_on_price_tie() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "score_best");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Bidder X: same price but higher reputation — higher rep wins.
        let x = Address::generate(&env);
        let salt_x = BytesN::<32>::from_array(&env, &[13u8; 32]);
        let price_x: i128 = 5_000_000;
        let terms_x = String::from_str(&env, "Premium");
        let comm_x = test_commitment(&env, &x, price_x, &terms_x, &salt_x);
        client.submit_bid(&task_id, &x, &comm_x, &500_000, &100);

        // Bidder Y: same price, low reputation.
        let y = Address::generate(&env);
        let salt_y = BytesN::<32>::from_array(&env, &[14u8; 32]);
        let price_y: i128 = 5_000_000;
        let terms_y = String::from_str(&env, "Bargain");
        let comm_y = test_commitment(&env, &y, price_y, &terms_y, &salt_y);
        client.submit_bid(&task_id, &y, &comm_y, &500_000, &10);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &x, &price_x, &terms_x, &salt_x);
        client.reveal_bid(&task_id, &y, &price_y, &terms_y, &salt_y);

        client.reveal_bids(&task_id);

        let winner = client.get_winner(&task_id).unwrap();
        // At 60/40 weighting, when prices are identical the higher reputation wins.
        assert_eq!(
            winner, x,
            "on price tie, higher-reputation bidder X should win"
        );
    }

    #[test]
    fn reveal_bids_no_revealed_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "no_rev");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        // No bid was submitted at all.
        let err = client.try_reveal_bids(&task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotEnoughBids)));
    }

    #[test]
    fn reveal_bids_before_deadline_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "early_rb");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let err = client.try_reveal_bids(&task_id);
        assert_eq!(err.err(), Some(Ok(Error::BiddingPeriodActive)));
    }

    #[test]
    fn reveal_bids_emits_event() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "rb_event");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let bidder = Address::generate(&env);
        let salt = BytesN::<32>::from_array(&env, &[15u8; 32]);
        let price: i128 = 3_000_000;
        let terms = String::from_str(&env, "Solo");
        let comm = test_commitment(&env, &bidder, price, &terms, &salt);
        client.submit_bid(&task_id, &bidder, &comm, &500_000, &75);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
        client.reveal_bid(&task_id, &bidder, &price, &terms, &salt);

        let _ = env.events().all(); // drain

        client.reveal_bids(&task_id);

        let events = env.events().all();
        assert_eq!(events.len(), 1, "expected exactly one BidsRevealed event");
    }

    // ── award_contract ───────────────────────────────────────────────────────

    #[test]
    fn award_contract_creates_escrow_and_refunds() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "award_ok");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let bidder = Address::generate(&env);
        let salt = BytesN::<32>::from_array(&env, &[16u8; 32]);
        let price: i128 = 4_000_000;
        let terms = String::from_str(&env, "Winner");
        let comm = test_commitment(&env, &bidder, price, &terms, &salt);
        client.submit_bid(&task_id, &bidder, &comm, &500_000, &50);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
        client.reveal_bid(&task_id, &bidder, &price, &terms, &salt);
        client.reveal_bids(&task_id);

        client.award_contract(&task_id);

        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.phase, AuctionPhase::Awarded);
        assert!(auction.escrow_created);

        // Escrow created.
        let escrow = client.get_escrow(&task_id).unwrap();
        assert_eq!(escrow.agent, bidder);
        assert_eq!(escrow.amount, price); // winning price locked

        // Bond refunded.
        let bid = client.get_bid(&task_id, &bidder).unwrap();
        assert!(bid.refunded);
    }

    #[test]
    fn award_contract_refunds_all_losing_bidders() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "refund_all");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Winner: cheap.
        let winner = Address::generate(&env);
        let salt_w = BytesN::<32>::from_array(&env, &[17u8; 32]);
        let price_w: i128 = 1_000_000;
        let terms_w = String::from_str(&env, "Win");
        let comm_w = test_commitment(&env, &winner, price_w, &terms_w, &salt_w);
        client.submit_bid(&task_id, &winner, &comm_w, &500_000, &80);

        // Loser: expensive.
        let loser = Address::generate(&env);
        let salt_l = BytesN::<32>::from_array(&env, &[18u8; 32]);
        let price_l: i128 = 10_000_000;
        let terms_l = String::from_str(&env, "Lose");
        let comm_l = test_commitment(&env, &loser, price_l, &terms_l, &salt_l);
        client.submit_bid(&task_id, &loser, &comm_l, &500_000, &80);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &winner, &price_w, &terms_w, &salt_w);
        client.reveal_bid(&task_id, &loser, &price_l, &terms_l, &salt_l);
        client.reveal_bids(&task_id);

        client.award_contract(&task_id);

        let winner_bid = client.get_bid(&task_id, &winner).unwrap();
        assert!(winner_bid.refunded, "winner's bond should be refunded");

        let loser_bid = client.get_bid(&task_id, &loser).unwrap();
        assert!(loser_bid.refunded, "loser's bond should be refunded");
    }

    #[test]
    fn award_contract_before_reveal_bids_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "pre_award");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let bidder = Address::generate(&env);
        let salt = BytesN::<32>::from_array(&env, &[19u8; 32]);
        let price: i128 = 3_000_000;
        let terms = String::from_str(&env, "Wait");
        let comm = test_commitment(&env, &bidder, price, &terms, &salt);
        client.submit_bid(&task_id, &bidder, &comm, &500_000, &50);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        // Not yet revealed_bids → phase is still Bidding.
        let err = client.try_award_contract(&task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotInRevealPhase)));
    }

    #[test]
    fn award_contract_twice_fails() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "twice_award");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let bidder = Address::generate(&env);
        let salt = BytesN::<32>::from_array(&env, &[20u8; 32]);
        let price: i128 = 5_000_000;
        let terms = String::from_str(&env, "Solo");
        let comm = test_commitment(&env, &bidder, price, &terms, &salt);
        client.submit_bid(&task_id, &bidder, &comm, &500_000, &80);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
        client.reveal_bid(&task_id, &bidder, &price, &terms, &salt);
        client.reveal_bids(&task_id);
        client.award_contract(&task_id);

        // After award, phase is Awarded — not Reveal, so NotInRevealPhase fires before
        // the escrow-created check.
        let err = client.try_award_contract(&task_id);
        assert_eq!(err.err(), Some(Ok(Error::NotInRevealPhase)));
    }

    // ── Full end-to-end flow ─────────────────────────────────────────────────

    #[test]
    fn full_sealed_bid_reveal_award_flow() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "e2e");

        // 1. Create auction.
        client.create_auction(&creator, &task_id, &3600, &1_000_000, &500_000);
        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.phase, AuctionPhase::Bidding);

        // 2. Three bidders submit sealed bids.
        let (bidder1, price1, rep1) = (Address::generate(&env), 2_000_000i128, 60u32);
        let (bidder2, price2, rep2) = (Address::generate(&env), 3_000_000i128, 90u32);
        let (bidder3, price3, rep3) = (Address::generate(&env), 5_000_000i128, 50u32);

        let salt = |b: u8| BytesN::<32>::from_array(&env, &[b; 32]);
        let terms = |s: &str| String::from_str(&env, s);

        let comm1 = test_commitment(&env, &bidder1, price1, &terms("Offer 1"), &salt(21));
        let comm2 = test_commitment(&env, &bidder2, price2, &terms("Offer 2"), &salt(22));
        let comm3 = test_commitment(&env, &bidder3, price3, &terms("Offer 3"), &salt(23));

        client.submit_bid(&task_id, &bidder1, &comm1, &500_000, &rep1);
        client.submit_bid(&task_id, &bidder2, &comm2, &500_000, &rep2);
        client.submit_bid(&task_id, &bidder3, &comm3, &500_000, &rep3);

        assert_eq!(client.get_bidder_count(&task_id), 3);

        // Sealed — no prices visible.
        let sealed = client.get_bid(&task_id, &bidder1).unwrap();
        assert!(!sealed.revealed);
        assert_eq!(sealed.price_stroops, 0);

        // 3. Advance past deadline, reveal all.
        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &bidder1, &price1, &terms("Offer 1"), &salt(21));
        client.reveal_bid(&task_id, &bidder2, &price2, &terms("Offer 2"), &salt(22));
        client.reveal_bid(&task_id, &bidder3, &price3, &terms("Offer 3"), &salt(23));

        // Verify revealed.
        assert!(client.get_bid(&task_id, &bidder1).unwrap().revealed);
        assert_eq!(
            client.get_bid(&task_id, &bidder2).unwrap().price_stroops,
            price2
        );

        // 4. Finalise reveals → winner selected.
        client.reveal_bids(&task_id);

        let winner = client.get_winner(&task_id).unwrap();
        // bidder2 has highest reputation (90) at moderate price (3M).
        // bidder1: 2M, rep 60 → cheaper but lower rep. bidder3: 5M, rep 50.
        // At 60/40, bidder2 should win (rep advantage outweighs price delta).
        assert_eq!(
            winner, bidder2,
            "bidder2 with best composite score should win"
        );

        let auction = client.get_auction(&task_id).unwrap();
        assert_eq!(auction.phase, AuctionPhase::Reveal);

        // 5. Award contract.
        client.award_contract(&task_id);

        let final_auction = client.get_auction(&task_id).unwrap();
        assert_eq!(final_auction.phase, AuctionPhase::Awarded);
        assert!(final_auction.escrow_created);

        let escrow = client.get_escrow(&task_id).unwrap();
        assert_eq!(escrow.agent, bidder2);
        assert_eq!(escrow.amount, price2);

        // All bonds refunded.
        for b in [&bidder1, &bidder2, &bidder3] {
            let bid = client.get_bid(&task_id, b).unwrap();
            assert!(bid.refunded, "bidder's bond should be refunded");
        }
    }

    #[test]
    fn winner_selection_price_preference_on_tie() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "tie");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        // Two bidders with identical reputation — cheaper wins.
        let cheap = Address::generate(&env);
        let ex = Address::generate(&env);

        let s1 = BytesN::<32>::from_array(&env, &[31u8; 32]);
        let s2 = BytesN::<32>::from_array(&env, &[32u8; 32]);
        let t = String::from_str(&env, "X");

        let c1 = test_commitment(&env, &cheap, 2_000_000, &t, &s1);
        let c2 = test_commitment(&env, &ex, 10_000_000, &t, &s2);

        client.submit_bid(&task_id, &cheap, &c1, &500_000, &80);
        client.submit_bid(&task_id, &ex, &c2, &500_000, &80);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        client.reveal_bid(&task_id, &cheap, &2_000_000, &t, &s1);
        client.reveal_bid(&task_id, &ex, &10_000_000, &t, &s2);
        client.reveal_bids(&task_id);

        assert_eq!(client.get_winner(&task_id).unwrap(), cheap);
    }

    #[test]
    fn non_revealed_bidder_cannot_win() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let task_id = Symbol::new(&env, "no_show");

        create_test_auction(&env, &client, &creator, &task_id, 3600);

        let rev = Address::generate(&env);
        let noshow = Address::generate(&env);

        let s_r = BytesN::<32>::from_array(&env, &[41u8; 32]);
        let s_n = BytesN::<32>::from_array(&env, &[42u8; 32]);
        let t = String::from_str(&env, "Terms");

        let c_r = test_commitment(&env, &rev, 5_000_000, &t, &s_r);
        let c_n = test_commitment(&env, &noshow, 1_000, &t, &s_n);

        client.submit_bid(&task_id, &rev, &c_r, &500_000, &50);
        client.submit_bid(&task_id, &noshow, &c_n, &500_000, &90);

        env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

        // Only `rev` reveals.
        client.reveal_bid(&task_id, &rev, &5_000_000, &t, &s_r);
        client.reveal_bids(&task_id);

        assert_eq!(
            client.get_winner(&task_id).unwrap(),
            rev,
            "only revealed bidder can win"
        );
    }
}
