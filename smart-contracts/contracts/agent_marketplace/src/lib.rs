#![no_std]

//! # Agent Marketplace Contract
//!
//! On-chain agent marketplace enabling service listing, discovery,
//! booking with escrow, and rating.

mod errors;
mod types;

pub use errors::Error;
pub use types::*;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
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

#[contractimpl]
impl AgentMarketplaceContract {
    /// Initialize the marketplace with an admin.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyExists);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Admin: pause or unpause the marketplace.
    pub fn pause(env: Env, paused: bool) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// List a service on the marketplace.
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

        if price_stroops <= 0 {
            return Err(Error::InvalidPrice);
        }

        let key = DataKey::ServiceListing(listing_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
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

        // Index by capability
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
            if let Some(listing) = env
                .storage()
                .persistent()
                .get::<_, ServiceListing>(&key)
            {
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
    pub fn book_agent(
        env: Env,
        listing_id: Symbol,
        client: Address,
        payment_amount: i128,
        booking_id: Symbol,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        client.require_auth();

        let key = DataKey::ServiceListing(listing_id.clone());
        let listing: ServiceListing = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

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

        let booking = Booking {
            booking_id: booking_id.clone(),
            listing_id: listing_id.clone(),
            agent_id: listing.agent_id.clone(),
            client: client.clone(),
            escrow_amount: payment_amount,
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
                escrow_amount: payment_amount,
            },
        );

        Ok(())
    }

    /// Complete a booking and release escrow payment to the agent owner.
    pub fn complete_booking(env: Env, booking_id: Symbol) -> Result<(), Error> {
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
        env.storage()
            .persistent()
            .set(&booking_key, &booking);

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
        env.storage()
            .persistent()
            .set(&booking_key, &booking);

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
    pub fn rate_booking(
        env: Env,
        booking_id: Symbol,
        rating: u32,
    ) -> Result<(), Error> {
        if rating < 1 || rating > 5 {
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
        env.storage()
            .persistent()
            .set(&booking_key, &booking);

        // Update agent rating aggregate
        let rating_key = DataKey::AgentRating(booking.agent_id.clone());
        let mut agent_rating: AgentRating = env
            .storage()
            .persistent()
            .get(&rating_key)
            .unwrap_or(AgentRating {
                agent_id: booking.agent_id.clone(),
                total_ratings: 0,
                rating_sum: 0,
            });

        agent_rating.total_ratings += 1;
        agent_rating.rating_sum += rating as u64;
        env.storage()
            .persistent()
            .set(&rating_key, &agent_rating);

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
}

#[cfg(test)]
mod test;
