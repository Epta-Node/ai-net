//! # Cross-chain agent identity bridging (issue #259)
//!
//! An agent registered here may also work on an EVM chain or on Solana. Those
//! chains cannot read Stellar state, so recognition has to travel as a
//! self-contained artefact: a [`BridgeProof`].
//!
//! ## What a proof asserts
//!
//! That at `issued_at`, the holder of `stellar_pubkey` was the registered owner
//! of `agent_id`, and authorised its use on `target_chain` until `expiry`.
//!
//! ## Construction
//!
//! The registry builds a canonical byte string over the proof fields, hashes it
//! with SHA-256, and checks the agent owner's ed25519 signature over that
//! digest before storing anything. Canonical encoding matters: a verifier on
//! the target chain has to rebuild the exact same bytes, so the layout is fixed
//! and documented in `docs/cross-chain.md`.
//!
//! The chain identifier is part of the signed message, so a proof minted for
//! one chain cannot be replayed on another.
//!
//! ## Verification
//!
//! [`verify`] re-derives the digest from the presented proof and compares it
//! against the stored record, then checks expiry. A verifier that cannot read
//! Stellar state verifies the signature directly against `stellar_pubkey`
//! instead; both paths cover the same bytes.

use soroban_sdk::{symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env, Symbol};

use crate::events::{BridgeProofRevokedEvent, BridgeProofVerifiedEvent, IdentityBridgedEvent};
use crate::types::{BridgeProof, TargetChain};
use crate::{DataKey, Error};

/// Proof lifetime used when the caller does not pick one, in seconds (24h).
pub const DEFAULT_BRIDGE_TTL_SECS: u64 = 86_400;
/// Longest lifetime a proof may be given, in seconds (30 days).
///
/// Bounded because a proof cannot be revoked on the target chain: the only
/// thing limiting a leaked one is its expiry.
pub const MAX_BRIDGE_TTL_SECS: u64 = 2_592_000;

/// Tag mixed into the digest so these bytes cannot be reinterpreted as another
/// protocol's signed message.
const DOMAIN_TAG: &[u8] = b"ai-net.agent-registry.bridge.v1";

/// Chain discriminants used in the canonical encoding. Stable by contract:
/// changing one invalidates every proof already issued for that chain.
const CHAIN_TAG_EVM: u8 = 1;
const CHAIN_TAG_SOLANA: u8 = 2;

/// Build the canonical byte string a proof's digest is taken over.
///
/// Layout, in order:
///
/// ```text
/// domain tag        31 bytes  "ai-net.agent-registry.bridge.v1"
/// agent id length    4 bytes  big-endian length of the field below
/// agent id           n bytes  ScVal XDR of the agent id symbol
/// chain tag          1 byte   1 = EVM, 2 = Solana
/// chain id           4 bytes  big-endian EIP-155 id; zero for Solana
/// stellar pubkey    32 bytes
/// issued_at          8 bytes  big-endian seconds
/// expiry             8 bytes  big-endian seconds
/// ```
///
/// The agent id is encoded as its `ScVal` XDR rather than raw characters:
/// `Symbol` exposes no byte accessor that survives the `wasm32v1-none` build,
/// whereas XDR serialisation is a host function and is a documented Stellar
/// encoding an off-chain verifier can reproduce exactly.
///
/// It is length-prefixed so that `("ab", "c")` and `("a", "bc")` cannot produce
/// the same bytes.
pub fn canonical_message(
    env: &Env,
    agent_id: &Symbol,
    stellar_pubkey: &BytesN<32>,
    target_chain: &TargetChain,
    issued_at: u64,
    expiry: u64,
) -> Bytes {
    let mut message = Bytes::from_slice(env, DOMAIN_TAG);

    let id_xdr = agent_id.clone().to_xdr(env);
    message.extend_from_slice(&id_xdr.len().to_be_bytes());
    message.append(&id_xdr);

    match target_chain {
        TargetChain::Evm(chain_id) => {
            message.push_back(CHAIN_TAG_EVM);
            message.extend_from_slice(&chain_id.to_be_bytes());
        }
        TargetChain::Solana => {
            message.push_back(CHAIN_TAG_SOLANA);
            message.extend_from_slice(&0u32.to_be_bytes());
        }
    }

    message.append(&stellar_pubkey.clone().into());
    message.extend_from_slice(&issued_at.to_be_bytes());
    message.extend_from_slice(&expiry.to_be_bytes());

    message
}

/// Digest a verifier signs and checks: SHA-256 over [`canonical_message`].
pub fn digest_of(
    env: &Env,
    agent_id: &Symbol,
    stellar_pubkey: &BytesN<32>,
    target_chain: &TargetChain,
    issued_at: u64,
    expiry: u64,
) -> BytesN<32> {
    let message = canonical_message(
        env,
        agent_id,
        stellar_pubkey,
        target_chain,
        issued_at,
        expiry,
    );
    env.crypto().sha256(&message).to_bytes()
}

/// Mint a bridge proof for `agent_id` on `target_chain`.
///
/// `ttl_secs` of zero means [`DEFAULT_BRIDGE_TTL_SECS`]. The signature must be
/// the agent owner's ed25519 signature over the digest; an invalid one aborts
/// the invocation through the host's verification, which does not return.
///
/// Re-bridging the same agent to the same chain overwrites the previous proof,
/// which is how a proof is rotated.
pub fn issue(
    env: &Env,
    agent_id: Symbol,
    stellar_pubkey: BytesN<32>,
    target_chain: TargetChain,
    ttl_secs: u64,
    signature: BytesN<64>,
) -> Result<BridgeProof, Error> {
    let ttl = if ttl_secs == 0 {
        DEFAULT_BRIDGE_TTL_SECS
    } else {
        ttl_secs
    };
    if ttl > MAX_BRIDGE_TTL_SECS {
        return Err(Error::InvalidBridgeExpiry);
    }

    let issued_at = env.ledger().timestamp();
    let expiry = issued_at.saturating_add(ttl);

    let digest = digest_of(
        env,
        &agent_id,
        &stellar_pubkey,
        &target_chain,
        issued_at,
        expiry,
    );

    // Aborts the transaction if the signature does not match, so nothing below
    // runs for an unauthorised request.
    let message = canonical_message(
        env,
        &agent_id,
        &stellar_pubkey,
        &target_chain,
        issued_at,
        expiry,
    );
    env.crypto()
        .ed25519_verify(&stellar_pubkey, &message, &signature);

    let proof = BridgeProof {
        agent_id: agent_id.clone(),
        stellar_pubkey,
        target_chain,
        issued_at,
        expiry,
        digest: digest.clone(),
        signature,
    };

    let key = DataKey::BridgeProof(agent_id.clone(), target_chain);
    env.storage().persistent().set(&key, &proof);
    // Retain a little past expiry so a verifier can still distinguish "expired"
    // from "never issued".
    let ttl_ledgers = ((ttl / 5) + 1) as u32;
    env.storage()
        .persistent()
        .extend_ttl(&key, ttl_ledgers, ttl_ledgers.saturating_mul(2));

    env.events().publish(
        (symbol_short!("registry"), symbol_short!("bridged")),
        IdentityBridgedEvent {
            agent_id,
            target_chain,
            digest,
            expiry,
        },
    );

    Ok(proof)
}

/// Check a presented proof against the registry's record.
///
/// Returns `Ok(())` only when the proof matches the stored record field for
/// field and has not expired. A verification attempt is always reported through
/// [`BridgeProofVerifiedEvent`], including failures, so an indexer can see a
/// chain repeatedly presenting stale proofs.
pub fn verify(env: &Env, proof: &BridgeProof) -> Result<(), Error> {
    let key = DataKey::BridgeProof(proof.agent_id.clone(), proof.target_chain);
    let stored: Option<BridgeProof> = env.storage().persistent().get(&key);

    let outcome = match stored {
        None => Err(Error::BridgeProofNotFound),
        Some(record) => {
            // Compare the whole record: a proof carrying a different pubkey,
            // window or signature is not the one this registry issued.
            if record != *proof {
                Err(Error::BridgeProofMismatch)
            } else {
                // Recompute rather than trusting the stored digest, so a proof
                // whose digest disagrees with its own fields is rejected.
                let expected = digest_of(
                    env,
                    &proof.agent_id,
                    &proof.stellar_pubkey,
                    &proof.target_chain,
                    proof.issued_at,
                    proof.expiry,
                );
                if expected != proof.digest {
                    Err(Error::BridgeProofMismatch)
                } else if env.ledger().timestamp() > proof.expiry {
                    Err(Error::BridgeProofExpired)
                } else {
                    Ok(())
                }
            }
        }
    };

    env.events().publish(
        (symbol_short!("registry"), symbol_short!("brdg_vrfy")),
        BridgeProofVerifiedEvent {
            agent_id: proof.agent_id.clone(),
            target_chain: proof.target_chain,
            valid: outcome.is_ok(),
        },
    );

    outcome
}

/// Read the stored proof for an agent and chain, if one exists.
pub fn get(env: &Env, agent_id: Symbol, target_chain: TargetChain) -> Option<BridgeProof> {
    env.storage()
        .persistent()
        .get(&DataKey::BridgeProof(agent_id, target_chain))
}

/// Drop a proof before its expiry.
///
/// Only affects this registry's record: a verifier that checks the signature
/// offline cannot learn about the revocation, which is why proof lifetimes are
/// capped at [`MAX_BRIDGE_TTL_SECS`].
pub fn revoke(
    env: &Env,
    agent_id: Symbol,
    target_chain: TargetChain,
    revoked_by: Address,
) -> Result<(), Error> {
    let key = DataKey::BridgeProof(agent_id.clone(), target_chain);
    if !env.storage().persistent().has(&key) {
        return Err(Error::BridgeProofNotFound);
    }
    env.storage().persistent().remove(&key);

    env.events().publish(
        (symbol_short!("registry"), symbol_short!("brdg_revk")),
        BridgeProofRevokedEvent {
            agent_id,
            target_chain,
            revoked_by,
        },
    );

    Ok(())
}
