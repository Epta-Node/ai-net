//! # Data Types for Agent Marketplace

use soroban_sdk::{contracttype, Address, Symbol};

/// Privileged action that must wait out the timelock before executing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdminAction {
    /// Lift the pause.
    Unpause,
    /// Set the payment asset and its decimals.
    SetPaymentAsset(Address, u32),
}

/// An admin action queued with the earliest time it can be executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedAction {
    pub action: AdminAction,
    /// Ledger timestamp from which the action may be executed.
    pub eta: u64,
}

/// On-chain representation of a service listing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceListing {
    /// Unique listing identifier.
    pub listing_id: Symbol,
    /// Agent offering this service.
    pub agent_id: Symbol,
    /// Owner of the agent.
    pub owner: Address,
    /// Capability category being offered.
    pub capability: Symbol,
    /// Price per service unit in stroops.
    pub price_stroops: i128,
    /// Maximum response time SLA in milliseconds.
    pub max_response_time: u32,
    /// Availability hours (0-24).
    pub availability_hours: u32,
    /// Whether the listing is currently active.
    pub active: bool,
}

/// A service booking between a client and agent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Booking {
    /// Unique booking identifier.
    pub booking_id: Symbol,
    /// Reference to the service listing.
    pub listing_id: Symbol,
    /// Agent providing the service.
    pub agent_id: Symbol,
    /// Client who booked the service.
    pub client: Address,
    /// Payment amount held in escrow, in units of the payment asset that
    /// were actually transferred into the contract.
    pub escrow_amount: i128,
    /// Timestamp when booking was created.
    pub created_at: u64,
    /// Whether the booking has been completed.
    pub completed: bool,
    /// Whether the booking was cancelled.
    pub cancelled: bool,
    /// Client rating after completion (0 = unrated, 1-5 = rating).
    pub rating: u32,
}

/// Agent rating record stored on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRating {
    /// Agent being rated.
    pub agent_id: Symbol,
    /// Total number of ratings received.
    pub total_ratings: u64,
    /// Sum of all ratings (for computing average).
    pub rating_sum: u64,
}

/// Event data for service listing.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceListedEvent {
    pub listing_id: Symbol,
    pub agent_id: Symbol,
    pub capability: Symbol,
    pub price_stroops: i128,
}

/// Event data for service booking.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceBookedEvent {
    pub booking_id: Symbol,
    pub listing_id: Symbol,
    pub client: Address,
    pub escrow_amount: i128,
}

/// Event data for service completion.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceCompletedEvent {
    pub booking_id: Symbol,
    pub payment_released: i128,
}

/// Event data for service cancellation.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceCancelledEvent {
    pub booking_id: Symbol,
    pub refund_amount: i128,
}

/// Event data for a booking rating.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceRatedEvent {
    pub booking_id: Symbol,
    pub agent_id: Symbol,
    pub rating: u32,
}

/// Event emitted when admin is transferred.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChangedEvent {
    pub old_admin: Address,
    pub new_admin: Address,
}

/// Minimum duration a listing must stay active before price updates (48 hours).
pub const MINIMUM_LISTING_DURATION: u64 = 48 * 60 * 60;

/// Price history entry for detecting manipulation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceHistoryEntry {
    pub timestamp: u64,
    pub price_stroops: i128,
}
