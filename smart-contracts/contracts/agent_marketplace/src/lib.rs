#![no_std]
#![allow(clippy::too_many_arguments)]

//! # Agent Marketplace Contract
//!
//! On-chain agent marketplace enabling service listing, discovery,
//! booking with escrow, and rating.

mod errors;
pub mod gas;
mod types;

pub use errors::Error;
pub use types::*;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    ServiceListing(Symbol),
    Booking(Symbol),
    AgentRating(Symbol),
    ListingsByCapability(Symbol),
    /// Stellar Asset Contract used for booking payments.
    PaymentAsset,
    /// Decimals of the configured payment asset.
    AssetDecimals,
    /// Number of admin actions ever queued (next action id).
    ActionCount,
    /// Admin action waiting out the timelock.
    QueuedAction(u32),
    /// Agent Registry contract used for eligibility checks (optional).
    AgentRegistry,
    /// Track listings per agent+capability to prevent duplication.
    AgentCapabilityListing(Symbol, Symbol),
    /// Price history for a listing (to track manipulation).
    PriceHistory(Symbol),
}

#[contract]
pub struct AgentMarketplaceContract;

fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::Unauthorized)?;
    admin.require_auth();
    Ok(admin)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

/// Ask the optional agent registry whether `agent_id` is eligible.
///
/// When no registry is configured the check is a no-op, preserving the
/// standalone deployment path. Registry error codes are mapped onto this
/// contract's local error space.
fn verify_agent_eligibility(env: &Env, agent_id: &Symbol) -> Result<(), Error> {
    let registry: Option<Address> = env.storage().instance().get(&DataKey::AgentRegistry);
    let registry_addr = match registry {
        Some(addr) => addr,
        None => return Ok(()),
    };

    use soroban_sdk::{vec, InvokeError, IntoVal, Val};
    let fn_name = Symbol::new(env, "verify_agent_eligible");
    let args = vec![env, agent_id.into_val(env)];

    let res: Result<Result<Val, _>, Result<InvokeError, InvokeError>> =
        env.try_invoke_contract(&registry_addr, &fn_name, args);

    match res {
        Ok(Ok(_)) => Ok(()),
        Err(Ok(InvokeError::Contract(code))) | Err(Err(InvokeError::Contract(code))) => match code {
            1 => Err(Error::AgentNotFound),
            5 => Err(Error::AgentFrozen),
            10 => Err(Error::InsufficientBond),
            39 => Err(Error::AgentDeregistered),
            _ => Err(Error::AgentNotEligible),
        },
        _ => Err(Error::AgentNotEligible),
    }
}

/// Seconds a queued admin action must wait before it can be executed.
pub const TIMELOCK_DELAY: u64 = 86_400;

/// Decimals in which listing prices (`price_stroops`) are denominated.
pub const STROOP_DECIMALS: u32 = 7;

/// Convert a stroop-denominated amount into units of an asset with
/// `decimals` decimals. Fails with [`Error::InvalidAmount`] for negative
/// amounts or when the amount is not exactly representable in the asset.
pub fn stroops_to_units(amount: i128, decimals: u32) -> Result<i128, Error> {
    if amount < 0 {
        return Err(Error::InvalidAmount);
    }
    if decimals >= STROOP_DECIMALS {
        10i128
            .checked_pow(decimals - STROOP_DECIMALS)
            .and_then(|f| amount.checked_mul(f))
            .ok_or(Error::InvalidAmount)
    } else {
        let f = 10i128.pow(STROOP_DECIMALS - decimals);
        if amount % f != 0 {
            return Err(Error::InvalidAmount);
        }
        Ok(amount / f)
    }
}

/// The configured payment token and its decimals, re-checked against the
/// token so a misconfigured asset can never silently mis-scale amounts.
fn payment_token(env: &Env) -> Result<(token::Client<'_>, u32), Error> {
    let asset: Address = env
        .storage()
        .instance()
        .get(&DataKey::PaymentAsset)
        .ok_or(Error::AssetNotConfigured)?;
    let decimals: u32 = env
        .storage()
        .instance()
        .get(&DataKey::AssetDecimals)
        .ok_or(Error::AssetNotConfigured)?;
    let client = token::Client::new(env, &asset);
    if client.decimals() != decimals {
        return Err(Error::AssetMismatch);
    }
    Ok((client, decimals))
}

#[contractimpl]
impl AgentMarketplaceContract {
    /// Initialize the marketplace with an admin.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (symbol_short!("market"), symbol_short!("init")),
            (admin, env.ledger().sequence()),
        );
        Ok(())
    }

    /// Admin: transfer admin rights. Requires authorization from both current and new admin.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        require_not_paused(&env)?;
        let old_admin = require_admin(&env)?;
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("adm_chng")),
            AdminChangedEvent {
                old_admin,
                new_admin,
            },
        );
        Ok(())
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Admin: pause.
    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("market"), symbol_short!("paused")), ());
        Ok(())
    }

    /// Admin: queue a privileged action (unpause or payment-asset change).
    /// It becomes executable after [`TIMELOCK_DELAY`] and can be cancelled
    /// while queued. Pausing stays immediate so it can be used as an
    /// emergency stop. Returns the action id.
    pub fn queue_action(env: Env, action: AdminAction) -> Result<u32, Error> {
        require_admin(&env)?;
        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActionCount)
            .unwrap_or(0);
        let eta = env.ledger().timestamp() + TIMELOCK_DELAY;
        env.storage()
            .instance()
            .set(&DataKey::ActionCount, &(id + 1));
        env.storage()
            .persistent()
            .set(&DataKey::QueuedAction(id), &QueuedAction { action, eta });
        env.events().publish(
            (symbol_short!("market"), symbol_short!("queued")),
            (id, eta),
        );
        Ok(id)
    }

    /// Admin: execute a queued action once its delay has elapsed.
    pub fn execute_action(env: Env, id: u32) -> Result<(), Error> {
        require_admin(&env)?;
        let key = DataKey::QueuedAction(id);
        let queued: QueuedAction = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ActionNotQueued)?;
        if env.ledger().timestamp() < queued.eta {
            return Err(Error::TimelockNotElapsed);
        }
        env.storage().persistent().remove(&key);
        match queued.action {
            AdminAction::Unpause => {
                env.storage().instance().set(&DataKey::Paused, &false);
                env.events()
                    .publish((symbol_short!("market"), symbol_short!("unpaused")), ());
            }
            AdminAction::SetPaymentAsset(asset, decimals) => {
                if token::Client::new(&env, &asset).decimals() != decimals {
                    return Err(Error::AssetMismatch);
                }
                env.storage().instance().set(&DataKey::PaymentAsset, &asset);
                env.storage()
                    .instance()
                    .set(&DataKey::AssetDecimals, &decimals);
                env.events().publish(
                    (symbol_short!("market"), symbol_short!("asset_set")),
                    (asset, decimals),
                );
            }
        }
        env.events()
            .publish((symbol_short!("market"), symbol_short!("executed")), id);
        Ok(())
    }

    /// Admin: cancel a queued action before it is executed.
    pub fn cancel_action(env: Env, id: u32) -> Result<(), Error> {
        require_admin(&env)?;
        let key = DataKey::QueuedAction(id);
        if !env.storage().persistent().has(&key) {
            return Err(Error::ActionNotQueued);
        }
        env.storage().persistent().remove(&key);
        env.events()
            .publish((symbol_short!("market"), symbol_short!("cancelled")), id);
        Ok(())
    }

    /// Returns the configured payment asset, if any.
    pub fn get_payment_asset(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PaymentAsset)
    }

    /// Returns the configured payment asset's decimals, if any.
    pub fn get_asset_decimals(env: Env) -> Option<u32> {
        env.storage().instance().get(&DataKey::AssetDecimals)
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Estimate CPU instructions for listing, searching, or purchasing.
    /// `count` is the number of listings scanned for search or operations.
    pub fn estimate_gas(env: Env, operation: Symbol, count: u32) -> u64 {
        let _ = env;
        gas::estimate(operation, count)
    }

    pub fn estimate(
        env: Env,
        operation: Symbol,
        params: soroban_sdk::Map<Symbol, soroban_sdk::Val>,
    ) -> u64 {
        let _ = env;
        <AgentMarketplaceContract as gas_interface::GasEstimator>::estimate(operation, params)
    }

    /// List a service on the marketplace.
    /// Prevents the same agent from listing the same capability multiple times
    /// (deduplication). Updates must wait MINIMUM_LISTING_DURATION before price changes.
    pub fn list_service(
        env: Env,
        listing_id: Symbol,
        agent_id: Symbol,
        owner: Address,
        capability: Symbol,
        price_stroops: i128,
        max_response_time: u32,
        availability_hours: u32,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        owner.require_auth();
        verify_agent_eligibility(&env, &agent_id)?;

        if price_stroops <= 0 {
            return Err(Error::InvalidPrice);
        }

        let key = DataKey::ServiceListing(listing_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }

        let dedup_key = DataKey::AgentCapabilityListing(agent_id.clone(), capability.clone());
        if let Some(existing_id) = env
            .storage()
            .persistent()
            .get::<_, Symbol>(&dedup_key)
        {
            if let Some(existing) = env
                .storage()
                .persistent()
                .get::<_, ServiceListing>(&DataKey::ServiceListing(existing_id.clone()))
            {
                if existing.active {
                    return Err(Error::AlreadyExists);
                }
            }
        }

        let listing = ServiceListing {
            listing_id: listing_id.clone(),
            agent_id: agent_id.clone(),
            owner: owner.clone(),
            capability: capability.clone(),
            price_stroops,
            max_response_time,
            availability_hours,
            active: true,
        };

        env.storage().persistent().set(&key, &listing);
        env.storage()
            .persistent()
            .set(&dedup_key, &listing_id.clone());

        let price_history_key = DataKey::PriceHistory(listing_id.clone());
        let mut history: Vec<PriceHistoryEntry> = Vec::new(&env);
        history.push_back(PriceHistoryEntry {
            timestamp: env.ledger().timestamp(),
            price_stroops,
        });
        env.storage().persistent().set(&price_history_key, &history);

        let cap_key = DataKey::ListingsByCapability(capability.clone());
        let mut ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));
        ids.push_back(listing_id.clone());
        env.storage().persistent().set(&cap_key, &ids);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_list")),
            ServiceListedEvent {
                listing_id,
                agent_id,
                capability,
                price_stroops,
            },
        );

        Ok(())
    }

    /// Search for services by capability with optional filters.
    pub fn search_services(
        env: Env,
        capability: Symbol,
        max_price: i128,
        max_response_time: u32,
    ) -> Vec<ServiceListing> {
        let cap_key = DataKey::ListingsByCapability(capability);
        let ids: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&cap_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        for id in ids.iter() {
            let key = DataKey::ServiceListing(id);
            if let Some(listing) = env.storage().persistent().get::<_, ServiceListing>(&key) {
                if !listing.active {
                    continue;
                }
                if max_price > 0 && listing.price_stroops > max_price {
                    continue;
                }
                if max_response_time > 0 && listing.max_response_time > max_response_time {
                    continue;
                }
                results.push_back(listing);
            }
        }
        results
    }

    /// Book an agent's service with escrow payment.
    ///
    /// `payment_amount` is in stroops (like `price_stroops`) and is converted
    /// to units of the configured asset, then transferred from `client` into
    /// contract custody. `asset` must equal the configured payment asset,
    /// otherwise [`Error::AssetMismatch`].
    pub fn book_agent(
        env: Env,
        listing_id: Symbol,
        client: Address,
        asset: Address,
        payment_amount: i128,
        booking_id: Symbol,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        client.require_auth();

        let (token, decimals) = payment_token(&env)?;
        if token.address != asset {
            return Err(Error::AssetMismatch);
        }

        let key = DataKey::ServiceListing(listing_id.clone());
        let listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        verify_agent_eligibility(&env, &listing.agent_id)?;

        if !listing.active {
            return Err(Error::ServiceNotAvailable);
        }

        if payment_amount < listing.price_stroops {
            return Err(Error::InsufficientPayment);
        }

        let booking_key = DataKey::Booking(booking_id.clone());
        if env.storage().persistent().has(&booking_key) {
            return Err(Error::AlreadyExists);
        }

        // Pull the payment into escrow before recording it.
        let escrow_amount = stroops_to_units(payment_amount, decimals)?;
        token.transfer(&client, &env.current_contract_address(), &escrow_amount);

        let booking = Booking {
            booking_id: booking_id.clone(),
            listing_id: listing_id.clone(),
            agent_id: listing.agent_id.clone(),
            client: client.clone(),
            escrow_amount,
            created_at: env.ledger().timestamp(),
            completed: false,
            cancelled: false,
            rating: 0,
        };

        let booking_key = DataKey::Booking(booking_id.clone());
        env.storage().persistent().set(&booking_key, &booking);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_book")),
            ServiceBookedEvent {
                booking_id: booking_id.clone(),
                listing_id,
                client,
                escrow_amount,
            },
        );

        Ok(())
    }

    /// Complete a booking and release escrow payment to the agent owner.
    pub fn complete_booking(env: Env, booking_id: Symbol) -> Result<(), Error> {
        require_not_paused(&env)?;

        let booking_key = DataKey::Booking(booking_id.clone());
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .ok_or(Error::BookingNotFound)?;

        if booking.completed {
            return Err(Error::BookingAlreadyCompleted);
        }
        if booking.cancelled {
            return Err(Error::BookingAlreadyCancelled);
        }

        // Only the agent owner can mark as completed
        let listing_key = DataKey::ServiceListing(booking.listing_id.clone());
        let listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&listing_key)
            .ok_or(Error::NotFound)?;

        listing.owner.require_auth();

        booking.completed = true;
        env.storage().persistent().set(&booking_key, &booking);

        let (token, _) = payment_token(&env)?;
        token.transfer(
            &env.current_contract_address(),
            &listing.owner,
            &booking.escrow_amount,
        );

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_comp")),
            ServiceCompletedEvent {
                booking_id,
                payment_released: booking.escrow_amount,
            },
        );

        Ok(())
    }

    /// Cancel a booking and refund the client.
    pub fn cancel_booking(env: Env, booking_id: Symbol) -> Result<(), Error> {
        require_not_paused(&env)?;

        let booking_key = DataKey::Booking(booking_id.clone());
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .ok_or(Error::BookingNotFound)?;

        if booking.completed {
            return Err(Error::BookingAlreadyCompleted);
        }
        if booking.cancelled {
            return Err(Error::BookingAlreadyCancelled);
        }

        booking.client.require_auth();

        booking.cancelled = true;
        env.storage().persistent().set(&booking_key, &booking);

        let (token, _) = payment_token(&env)?;
        token.transfer(
            &env.current_contract_address(),
            &booking.client,
            &booking.escrow_amount,
        );

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_canc")),
            ServiceCancelledEvent {
                booking_id,
                refund_amount: booking.escrow_amount,
            },
        );

        Ok(())
    }

    /// Rate a completed booking (1-5 stars).
    pub fn rate_booking(env: Env, booking_id: Symbol, rating: u32) -> Result<(), Error> {
        require_not_paused(&env)?;

        if !(1..=5).contains(&rating) {
            return Err(Error::InvalidPrice);
        }

        let booking_key = DataKey::Booking(booking_id.clone());
        let mut booking: Booking = env
            .storage()
            .persistent()
            .get(&booking_key)
            .ok_or(Error::BookingNotFound)?;

        if !booking.completed {
            return Err(Error::BookingAlreadyCancelled);
        }
        if booking.rating != 0 {
            return Err(Error::AlreadyExists);
        }

        booking.client.require_auth();

        booking.rating = rating;
        env.storage().persistent().set(&booking_key, &booking);

        // Update agent rating aggregate
        let rating_key = DataKey::AgentRating(booking.agent_id.clone());
        let mut agent_rating: AgentRating =
            env.storage()
                .persistent()
                .get(&rating_key)
                .unwrap_or(AgentRating {
                    agent_id: booking.agent_id.clone(),
                    total_ratings: 0,
                    rating_sum: 0,
                });

        agent_rating.total_ratings += 1;
        agent_rating.rating_sum += rating as u64;
        env.storage().persistent().set(&rating_key, &agent_rating);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("svc_rate")),
            ServiceRatedEvent {
                booking_id,
                agent_id: booking.agent_id,
                rating,
            },
        );

        Ok(())
    }

    /// Get a service listing.
    pub fn get_listing(env: Env, listing_id: Symbol) -> Option<ServiceListing> {
        env.storage()
            .persistent()
            .get(&DataKey::ServiceListing(listing_id))
    }

    /// Get a booking.
    pub fn get_booking(env: Env, booking_id: Symbol) -> Option<Booking> {
        env.storage()
            .persistent()
            .get(&DataKey::Booking(booking_id))
    }

    /// Get aggregate rating for an agent.
    pub fn get_agent_rating(env: Env, agent_id: Symbol) -> AgentRating {
        env.storage()
            .persistent()
            .get(&DataKey::AgentRating(agent_id.clone()))
            .unwrap_or(AgentRating {
                agent_id,
                total_ratings: 0,
                rating_sum: 0,
            })
    }

    /// Update a service listing's price. Must respect minimum listing duration.
    /// Once MINIMUM_LISTING_DURATION has passed, owner can update price.
    pub fn update_listing_price(
        env: Env,
        listing_id: Symbol,
        new_price_stroops: i128,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;

        if new_price_stroops <= 0 {
            return Err(Error::InvalidPrice);
        }

        let key = DataKey::ServiceListing(listing_id.clone());
        let mut listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        listing.owner.require_auth();

        if !listing.active {
            return Err(Error::ServiceNotAvailable);
        }

        let price_history_key = DataKey::PriceHistory(listing_id.clone());
        let mut history: Vec<PriceHistoryEntry> = env
            .storage()
            .persistent()
            .get(&price_history_key)
            .unwrap_or_else(|| Vec::new(&env));

        if let Some(last_entry) = history.last() {
            let now = env.ledger().timestamp();
            if now.saturating_sub(last_entry.timestamp) < MINIMUM_LISTING_DURATION {
                return Err(Error::InvalidPrice);
            }
        }

        history.push_back(PriceHistoryEntry {
            timestamp: env.ledger().timestamp(),
            price_stroops: new_price_stroops,
        });

        listing.price_stroops = new_price_stroops;
        env.storage().persistent().set(&key, &listing);
        env.storage().persistent().set(&price_history_key, &history);

        env.events().publish(
            (symbol_short!("market"), symbol_short!("price_upd")),
            ServiceListedEvent {
                listing_id,
                agent_id: listing.agent_id,
                capability: listing.capability,
                price_stroops: new_price_stroops,
            },
        );

        Ok(())
    }

    /// Get price history for a listing to detect manipulation patterns.
    pub fn get_price_history(env: Env, listing_id: Symbol) -> Vec<PriceHistoryEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::PriceHistory(listing_id))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

impl gas_interface::GasEstimator for AgentMarketplaceContract {
    fn estimate(operation: Symbol, params: soroban_sdk::Map<Symbol, soroban_sdk::Val>) -> u64 {
        gas::estimate(operation, params.len())
    }
}

#[cfg(test)]
mod test;
