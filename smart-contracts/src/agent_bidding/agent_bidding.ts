/**
 * TypeScript SDK wrapper for the Agent Bidding Soroban contract.
 *
 * Provides a typed client interface for the on-chain sealed-bid auction
 * contract that allows AI agents to compete for tasks. The contract implements
 * a commit-reveal scheme:
 *
 *  1. `createAuction`  – creator initialises a new auction
 *  2. `submitBid`      – agents submit sealed commitments during the bid window
 *  3. `revealBid`      – bidders reveal plaintext prices/terms within the reveal window
 *  4. `revealBids`     – finalise the reveal phase and select a winner
 *  5. `awardContract`  – creator or winner creates the escrow entry
 *  6. `abortAuction`   – rescue path when reveal window closes with zero reveals
 *
 * Mirrors the Rust contract interface in contracts/agent_bidding/src/lib.rs.
 *
 * Issue #490 — TypeScript SDK wrappers for all Soroban contracts
 */

// ---------------------------------------------------------------------------
// Shared transaction wrapper (mirrors coordinator.ts pattern)
// ---------------------------------------------------------------------------

/** Thin wrapper around an assembled Soroban transaction. */
export interface AssembledTransaction<T> {
  /** Sign and broadcast the transaction, returning the decoded result. */
  signAndSend(): Promise<T>;
  /** Simulate the transaction without broadcasting. */
  simulate(): Promise<T>;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export enum AuctionPhase {
  Bidding = 'Bidding',
  Reveal = 'Reveal',
  Awarded = 'Awarded',
  Cancelled = 'Cancelled',
}

export interface SealedBid {
  /** SHA-256 commitment over (contract_id || task_id || bidder || price || terms || salt) */
  commitment: Uint8Array;
  /** Self-declared reputation score [0, 1000] */
  reputationScore: number;
}

export interface RevealedBid {
  bidder: string;
  priceXLM: bigint;
  terms: string;
  reputationScore: number;
  /** Composite score computed during `revealBids` */
  compositeScore: number;
}

export interface AuctionInfo {
  auctionId: string;
  taskId: string;
  creator: string;
  phase: AuctionPhase;
  reservePrice: bigint;
  priceCap: bigint;
  requiredBond: bigint;
  deadline: bigint;
  revealDeadline: bigint;
  winner?: string;
  winningPrice?: bigint;
}

// ---------------------------------------------------------------------------
// Contract client interface
// ---------------------------------------------------------------------------

export interface AgentBiddingContractClient {
  create_auction(args: {
    task_id: string;
    creator: string;
    bidding_duration_secs: number;
    reveal_duration_secs: number;
    reserve_price: bigint;
    price_cap: bigint;
    required_bond: bigint;
  }): AssembledTransaction<string>;

  submit_bid(args: {
    auction_id: string;
    bidder: string;
    commitment: Uint8Array;
    reputation_score: number;
  }): AssembledTransaction<void>;

  reveal_bid(args: {
    auction_id: string;
    bidder: string;
    price: bigint;
    terms: string;
    salt: Uint8Array;
  }): AssembledTransaction<void>;

  reveal_bids(args: { auction_id: string }): AssembledTransaction<void>;

  award_contract(args: {
    auction_id: string;
    caller: string;
  }): AssembledTransaction<void>;

  abort_auction(args: {
    auction_id: string;
    admin: string;
  }): AssembledTransaction<void>;

  get_auction(auction_id: string): AssembledTransaction<AuctionInfo>;

  get_bids(auction_id: string): AssembledTransaction<RevealedBid[]>;
}

// ---------------------------------------------------------------------------
// High-level SDK wrapper class
// ---------------------------------------------------------------------------

/**
 * AgentBiddingSDK — high-level wrapper around the AgentBidding Soroban contract.
 *
 * @example
 * ```ts
 * const sdk = new AgentBiddingSDK(client);
 *
 * const auctionId = await sdk.createAuction({
 *   taskId: 'task-001',
 *   creator: 'GADDR...',
 *   biddingDurationSecs: 3600,
 *   revealDurationSecs: 1800,
 *   reservePrice: 100n,
 *   priceCap: 10_000n,
 *   requiredBond: 50n,
 * });
 * ```
 */
export class AgentBiddingSDK {
  constructor(private readonly client: AgentBiddingContractClient) {}

  /**
   * Create a new sealed-bid auction for a task.
   * Returns the generated auction ID.
   */
  async createAuction(args: {
    taskId: string;
    creator: string;
    biddingDurationSecs: number;
    revealDurationSecs: number;
    reservePrice: bigint;
    priceCap: bigint;
    requiredBond: bigint;
  }): Promise<string> {
    return this.client
      .create_auction({
        task_id: args.taskId,
        creator: args.creator,
        bidding_duration_secs: args.biddingDurationSecs,
        reveal_duration_secs: args.revealDurationSecs,
        reserve_price: args.reservePrice,
        price_cap: args.priceCap,
        required_bond: args.requiredBond,
      })
      .signAndSend();
  }

  /**
   * Submit a sealed bid commitment during the bidding window.
   */
  async submitBid(args: {
    auctionId: string;
    bidder: string;
    commitment: Uint8Array;
    reputationScore: number;
  }): Promise<void> {
    return this.client
      .submit_bid({
        auction_id: args.auctionId,
        bidder: args.bidder,
        commitment: args.commitment,
        reputation_score: args.reputationScore,
      })
      .signAndSend();
  }

  /**
   * Reveal the plaintext bid during the reveal window.
   */
  async revealBid(args: {
    auctionId: string;
    bidder: string;
    price: bigint;
    terms: string;
    salt: Uint8Array;
  }): Promise<void> {
    return this.client
      .reveal_bid({
        auction_id: args.auctionId,
        bidder: args.bidder,
        price: args.price,
        terms: args.terms,
        salt: args.salt,
      })
      .signAndSend();
  }

  /**
   * Finalise the reveal phase and select a winner.
   * Must be called after the reveal window closes (or all bids are revealed).
   */
  async revealBids(auctionId: string): Promise<void> {
    return this.client.reveal_bids({ auction_id: auctionId }).signAndSend();
  }

  /**
   * Award the contract, creating an escrow entry for the winning price.
   */
  async awardContract(args: {
    auctionId: string;
    caller: string;
  }): Promise<void> {
    return this.client
      .award_contract({ auction_id: args.auctionId, caller: args.caller })
      .signAndSend();
  }

  /**
   * Abort an auction that closed its reveal window with zero reveals.
   */
  async abortAuction(args: {
    auctionId: string;
    admin: string;
  }): Promise<void> {
    return this.client
      .abort_auction({ auction_id: args.auctionId, admin: args.admin })
      .signAndSend();
  }

  /**
   * Fetch auction metadata (read-only simulation).
   */
  async getAuction(auctionId: string): Promise<AuctionInfo> {
    return this.client.get_auction(auctionId).simulate();
  }

  /**
   * Fetch revealed bids for an auction (read-only simulation).
   */
  async getBids(auctionId: string): Promise<RevealedBid[]> {
    return this.client.get_bids(auctionId).simulate();
  }
}
