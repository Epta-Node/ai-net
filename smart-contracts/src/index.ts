/**
 * AI-Net Smart Contract TypeScript SDK
 *
 * Provides typed wrappers for all Soroban contracts deployed on Stellar.
 *
 * Issue #490 — Create TypeScript SDK wrappers for all Soroban contracts
 */

// Contract Client Wrappers
export * from './registry/registry';
export * from './coordinator/coordinator';
export * from './payment/payment';
export * from './agent_bidding/agent_bidding';
export * from './agent_marketplace/agent_marketplace';
export * from './dispute/resolution';
export * from './task_store/task_store';
export * from './upgrade_manager/upgrade_manager';

// Type definitions
export * from './types';

// Several contract wrappers each declare a structurally identical
// `AssembledTransaction`, so `export *` above leaves the name ambiguous and
// consumers get error TS2308. Every copy is the same shape, so name one of them
// as the public type rather than leaving it unresolved.
export type { AssembledTransaction } from './task_store/task_store';
