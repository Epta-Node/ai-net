/**
 * TypeScript SDK wrapper for the Agent Marketplace Soroban contract.
 *
 * Provides a typed client interface for the on-chain marketplace that enables
 * service listing, discovery, booking with escrow, and rating of AI agents.
 *
 * Key operations:
 *  - `initialize`     – set up the marketplace admin
 *  - `listService`    – register an agent's service offering
 *  - `bookService`    – create a booking with escrow for a listed service
 *  - `completeBooking`– mark a booking as completed and release escrow
 *  - `rateAgent`      – submit a rating for a completed booking
 *  - `findByCapability` – discover services by capability
 *
 * Mirrors the Rust contract interface in contracts/agent_marketplace/src/lib.rs.
 *
 * Issue #490 — TypeScript SDK wrappers for all Soroban contracts
 */

// ---------------------------------------------------------------------------
// Shared transaction wrapper (mirrors coordinator.ts pattern)
// ---------------------------------------------------------------------------

/** Thin wrapper around an assembled Soroban transaction. */
export interface AssembledTransaction<T> {
  signAndSend(): Promise<T>;
  simulate(): Promise<T>;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export enum BookingStatus {
  Pending = 'Pending',
  Active = 'Active',
  Completed = 'Completed',
  Disputed = 'Disputed',
  Cancelled = 'Cancelled',
}

export interface ServiceListing {
  listingId: string;
  agentId: string;
  capability: string;
  priceXLM: bigint;
  description: string;
  maxConcurrentBookings: number;
  isActive: boolean;
}

export interface Booking {
  bookingId: string;
  listingId: string;
  clientId: string;
  agentId: string;
  priceXLM: bigint;
  status: BookingStatus;
  createdAt: bigint;
  completedAt?: bigint;
}

export interface AgentRating {
  agentId: string;
  totalRatings: number;
  averageScore: number;
}

// ---------------------------------------------------------------------------
// Contract client interface
// ---------------------------------------------------------------------------

export interface AgentMarketplaceContractClient {
  initialize(args: { admin: string }): AssembledTransaction<void>;

  pause(args: { admin: string }): AssembledTransaction<void>;
  unpause(args: { admin: string }): AssembledTransaction<void>;

  list_service(args: {
    agent_id: string;
    capability: string;
    price_xlm: bigint;
    description: string;
    max_concurrent_bookings: number;
  }): AssembledTransaction<string>;

  delist_service(args: {
    listing_id: string;
    agent_id: string;
  }): AssembledTransaction<void>;

  book_service(args: {
    listing_id: string;
    client_id: string;
  }): AssembledTransaction<string>;

  complete_booking(args: {
    booking_id: string;
    agent_id: string;
  }): AssembledTransaction<void>;

  cancel_booking(args: {
    booking_id: string;
    caller: string;
  }): AssembledTransaction<void>;

  rate_agent(args: {
    booking_id: string;
    client_id: string;
    score: number;
  }): AssembledTransaction<void>;

  get_listing(listing_id: string): AssembledTransaction<ServiceListing>;

  get_booking(booking_id: string): AssembledTransaction<Booking>;

  get_agent_rating(agent_id: string): AssembledTransaction<AgentRating>;

  find_by_capability(capability: string): AssembledTransaction<ServiceListing[]>;
}

// ---------------------------------------------------------------------------
// High-level SDK wrapper class
// ---------------------------------------------------------------------------

/**
 * AgentMarketplaceSDK — high-level wrapper around the AgentMarketplace Soroban contract.
 *
 * @example
 * ```ts
 * const sdk = new AgentMarketplaceSDK(client);
 *
 * const listingId = await sdk.listService({
 *   agentId: 'GAGENT...',
 *   capability: 'nlp.summarisation',
 *   priceXLM: 500n,
 *   description: 'Text summarisation up to 10k tokens',
 *   maxConcurrentBookings: 5,
 * });
 * ```
 */
export class AgentMarketplaceSDK {
  constructor(private readonly client: AgentMarketplaceContractClient) {}

  /**
   * Initialise the marketplace with a given admin address.
   */
  async initialize(admin: string): Promise<void> {
    return this.client.initialize({ admin }).signAndSend();
  }

  /**
   * Pause the marketplace (admin only).
   */
  async pause(admin: string): Promise<void> {
    return this.client.pause({ admin }).signAndSend();
  }

  /**
   * Unpause the marketplace (admin only).
   */
  async unpause(admin: string): Promise<void> {
    return this.client.unpause({ admin }).signAndSend();
  }

  /**
   * Register a new service listing. Returns the generated listing ID.
   */
  async listService(args: {
    agentId: string;
    capability: string;
    priceXLM: bigint;
    description: string;
    maxConcurrentBookings: number;
  }): Promise<string> {
    return this.client
      .list_service({
        agent_id: args.agentId,
        capability: args.capability,
        price_xlm: args.priceXLM,
        description: args.description,
        max_concurrent_bookings: args.maxConcurrentBookings,
      })
      .signAndSend();
  }

  /**
   * Remove a service listing. Must be called by the listing's agent.
   */
  async delistService(args: {
    listingId: string;
    agentId: string;
  }): Promise<void> {
    return this.client
      .delist_service({ listing_id: args.listingId, agent_id: args.agentId })
      .signAndSend();
  }

  /**
   * Book a service, creating an escrow entry. Returns the booking ID.
   */
  async bookService(args: {
    listingId: string;
    clientId: string;
  }): Promise<string> {
    return this.client
      .book_service({ listing_id: args.listingId, client_id: args.clientId })
      .signAndSend();
  }

  /**
   * Mark a booking as completed, releasing the escrow to the agent.
   */
  async completeBooking(args: {
    bookingId: string;
    agentId: string;
  }): Promise<void> {
    return this.client
      .complete_booking({ booking_id: args.bookingId, agent_id: args.agentId })
      .signAndSend();
  }

  /**
   * Cancel a booking and refund the escrow to the client.
   */
  async cancelBooking(args: {
    bookingId: string;
    caller: string;
  }): Promise<void> {
    return this.client
      .cancel_booking({ booking_id: args.bookingId, caller: args.caller })
      .signAndSend();
  }

  /**
   * Submit a rating for a completed booking.
   * @param score Rating value in [1, 5].
   */
  async rateAgent(args: {
    bookingId: string;
    clientId: string;
    score: number;
  }): Promise<void> {
    return this.client
      .rate_agent({
        booking_id: args.bookingId,
        client_id: args.clientId,
        score: args.score,
      })
      .signAndSend();
  }

  /**
   * Fetch a service listing by ID (read-only).
   */
  async getListing(listingId: string): Promise<ServiceListing> {
    return this.client.get_listing(listingId).simulate();
  }

  /**
   * Fetch a booking by ID (read-only).
   */
  async getBooking(bookingId: string): Promise<Booking> {
    return this.client.get_booking(bookingId).simulate();
  }

  /**
   * Fetch aggregated rating data for an agent (read-only).
   */
  async getAgentRating(agentId: string): Promise<AgentRating> {
    return this.client.get_agent_rating(agentId).simulate();
  }

  /**
   * Discover service listings by capability (read-only).
   */
  async findByCapability(capability: string): Promise<ServiceListing[]> {
    return this.client.find_by_capability(capability).simulate();
  }
}
