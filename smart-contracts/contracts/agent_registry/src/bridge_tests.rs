//! Tests for cross-chain agent identity bridging (issue #259).

extern crate std;

use super::*;
use crate::bridge::{canonical_message, digest_of, DEFAULT_BRIDGE_TTL_SECS, MAX_BRIDGE_TTL_SECS};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Map, String, Symbol,
};

/// A registry with an admin, plus a registered agent owned by `owner`.
fn setup() -> (Env, AgentRegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn register(env: &Env, client: &AgentRegistryContractClient, id: &str, owner: &Address) -> Symbol {
    let agent_id = Symbol::new(env, id);
    client.register_agent(&AgentRecord {
        id: agent_id.clone(),
        capability: Symbol::new(env, "research"),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner: owner.clone(),
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    });
    agent_id
}

/// Deterministic key so a failure is reproducible.
fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pubkey_bytes(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

/// Sign the canonical message the contract will build for these parameters.
fn sign_proof(
    env: &Env,
    key: &SigningKey,
    agent_id: &Symbol,
    pubkey: &BytesN<32>,
    chain: &TargetChain,
    issued_at: u64,
    expiry: u64,
) -> BytesN<64> {
    let message = canonical_message(env, agent_id, pubkey, chain, issued_at, expiry);
    let mut buf = std::vec![0u8; message.len() as usize];
    message.copy_into_slice(&mut buf);
    BytesN::from_array(env, &key.sign(&buf).to_bytes())
}

/// Issue a proof with the default TTL, signing for the current ledger time.
fn issue_default(
    env: &Env,
    client: &AgentRegistryContractClient,
    agent_id: &Symbol,
    key: &SigningKey,
    chain: TargetChain,
) -> BridgeProof {
    let pubkey = pubkey_bytes(env, key);
    let issued_at = env.ledger().timestamp();
    let expiry = issued_at + DEFAULT_BRIDGE_TTL_SECS;
    let signature = sign_proof(env, key, agent_id, &pubkey, &chain, issued_at, expiry);
    client.bridge_identity(agent_id, &pubkey, &chain, &0, &signature)
}

#[test]
fn bridge_identity_issues_a_proof_with_the_default_ttl() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(1);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    assert_eq!(proof.agent_id, agent_id);
    assert_eq!(proof.target_chain, TargetChain::Evm(1));
    assert_eq!(proof.expiry - proof.issued_at, DEFAULT_BRIDGE_TTL_SECS);
    assert_eq!(proof.stellar_pubkey, pubkey_bytes(&env, &key));
}

#[test]
fn proof_digest_matches_an_independent_derivation() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(2);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Solana);

    let expected = digest_of(
        &env,
        &proof.agent_id,
        &proof.stellar_pubkey,
        &proof.target_chain,
        proof.issued_at,
        proof.expiry,
    );
    assert_eq!(proof.digest, expected);
}

#[test]
fn issued_proof_verifies() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(3);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(8453));
    assert!(client.try_verify_bridge_proof(&proof).is_ok());
}

#[test]
fn proof_is_readable_from_storage() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(4);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Solana);
    let stored = client.get_bridge_proof(&agent_id, &TargetChain::Solana);

    assert_eq!(stored, Some(proof));
}

#[test]
fn unbridged_agent_has_no_proof() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);

    assert_eq!(
        client.get_bridge_proof(&agent_id, &TargetChain::Solana),
        None
    );
}

#[test]
fn verifying_an_unissued_proof_fails() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(5);
    let pubkey = pubkey_bytes(&env, &key);

    // A well-formed proof the registry never issued.
    let issued_at = env.ledger().timestamp();
    let expiry = issued_at + DEFAULT_BRIDGE_TTL_SECS;
    let chain = TargetChain::Evm(1);
    let forged = BridgeProof {
        agent_id: agent_id.clone(),
        stellar_pubkey: pubkey.clone(),
        target_chain: chain,
        issued_at,
        expiry,
        digest: digest_of(&env, &agent_id, &pubkey, &chain, issued_at, expiry),
        signature: sign_proof(&env, &key, &agent_id, &pubkey, &chain, issued_at, expiry),
    };

    let result = client.try_verify_bridge_proof(&forged);
    assert_eq!(result, Err(Ok(Error::BridgeProofNotFound)));
}

#[test]
fn proof_expires() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(6);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    // Step past the expiry.
    env.ledger().set_timestamp(proof.expiry + 1);

    let result = client.try_verify_bridge_proof(&proof);
    assert_eq!(result, Err(Ok(Error::BridgeProofExpired)));
}

#[test]
fn proof_is_still_valid_at_its_expiry_instant() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(7);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));
    env.ledger().set_timestamp(proof.expiry);

    assert!(client.try_verify_bridge_proof(&proof).is_ok());
}

#[test]
fn a_tampered_proof_is_rejected() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(8);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    // Extend the window without re-signing.
    let tampered = BridgeProof {
        expiry: proof.expiry + 10_000,
        ..proof
    };

    let result = client.try_verify_bridge_proof(&tampered);
    assert_eq!(result, Err(Ok(Error::BridgeProofMismatch)));
}

#[test]
fn a_proof_for_one_chain_does_not_verify_on_another() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(9);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    // Same agent and window, different chain: no record exists for it.
    let swapped = BridgeProof {
        target_chain: TargetChain::Solana,
        ..proof
    };

    let result = client.try_verify_bridge_proof(&swapped);
    assert_eq!(result, Err(Ok(Error::BridgeProofNotFound)));
}

#[test]
fn chain_identity_is_part_of_the_signed_message() {
    let env = Env::default();
    let agent_id = Symbol::new(&env, "agent_a");
    let key = signing_key(10);
    let pubkey = pubkey_bytes(&env, &key);

    let evm = digest_of(&env, &agent_id, &pubkey, &TargetChain::Evm(1), 100, 200);
    let base = digest_of(&env, &agent_id, &pubkey, &TargetChain::Evm(8453), 100, 200);
    let solana = digest_of(&env, &agent_id, &pubkey, &TargetChain::Solana, 100, 200);

    assert_ne!(evm, base, "EIP-155 chain id must change the digest");
    assert_ne!(evm, solana);
    assert_ne!(base, solana);
}

#[test]
fn agent_id_is_bound_into_the_digest() {
    let env = Env::default();
    let key = signing_key(11);
    let pubkey = pubkey_bytes(&env, &key);
    let chain = TargetChain::Evm(1);

    let a = digest_of(&env, &Symbol::new(&env, "agent_a"), &pubkey, &chain, 1, 2);
    let b = digest_of(&env, &Symbol::new(&env, "agent_b"), &pubkey, &chain, 1, 2);

    assert_ne!(a, b);
}

#[test]
fn the_canonical_message_is_domain_separated() {
    let env = Env::default();
    let agent_id = Symbol::new(&env, "agent_a");
    let key = signing_key(12);
    let pubkey = pubkey_bytes(&env, &key);

    let message = canonical_message(&env, &agent_id, &pubkey, &TargetChain::Solana, 1, 2);
    let prefix = Bytes::from_slice(&env, b"ai-net.agent-registry.bridge.v1");

    assert!(message.len() > prefix.len());
    assert_eq!(message.slice(0..prefix.len()), prefix);
}

#[test]
fn a_ttl_beyond_the_ceiling_is_rejected() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(13);
    let pubkey = pubkey_bytes(&env, &key);
    let chain = TargetChain::Evm(1);

    let issued_at = env.ledger().timestamp();
    let too_long = MAX_BRIDGE_TTL_SECS + 1;
    let signature = sign_proof(
        &env,
        &key,
        &agent_id,
        &pubkey,
        &chain,
        issued_at,
        issued_at + too_long,
    );

    let result = client.try_bridge_identity(&agent_id, &pubkey, &chain, &too_long, &signature);
    assert_eq!(result, Err(Ok(Error::InvalidBridgeExpiry)));
}

#[test]
fn bridging_an_unregistered_agent_fails() {
    let (env, client, _admin) = setup();
    let key = signing_key(14);
    let pubkey = pubkey_bytes(&env, &key);
    let chain = TargetChain::Evm(1);
    let missing = Symbol::new(&env, "ghost");

    let issued_at = env.ledger().timestamp();
    let expiry = issued_at + DEFAULT_BRIDGE_TTL_SECS;
    let signature = sign_proof(&env, &key, &missing, &pubkey, &chain, issued_at, expiry);

    let result = client.try_bridge_identity(&missing, &pubkey, &chain, &0, &signature);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

#[test]
fn a_frozen_agent_cannot_be_bridged() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    client.freeze_agent(&agent_id);

    let key = signing_key(15);
    let pubkey = pubkey_bytes(&env, &key);
    let chain = TargetChain::Evm(1);
    let issued_at = env.ledger().timestamp();
    let expiry = issued_at + DEFAULT_BRIDGE_TTL_SECS;
    let signature = sign_proof(&env, &key, &agent_id, &pubkey, &chain, issued_at, expiry);

    let result = client.try_bridge_identity(&agent_id, &pubkey, &chain, &0, &signature);
    assert_eq!(result, Err(Ok(Error::AgentFrozen)));
}

#[test]
#[should_panic]
fn a_signature_from_the_wrong_key_is_rejected() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);

    let declared = signing_key(16);
    let attacker = signing_key(17);
    let pubkey = pubkey_bytes(&env, &declared);
    let chain = TargetChain::Evm(1);

    let issued_at = env.ledger().timestamp();
    let expiry = issued_at + DEFAULT_BRIDGE_TTL_SECS;
    // Signed by a key that is not the one declared in the proof. The host's
    // ed25519 check traps, so the whole invocation aborts.
    let signature = sign_proof(
        &env, &attacker, &agent_id, &pubkey, &chain, issued_at, expiry,
    );

    client.bridge_identity(&agent_id, &pubkey, &chain, &0, &signature);
}

#[test]
fn re_bridging_rotates_the_proof() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(18);

    let first = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    env.ledger().set_timestamp(env.ledger().timestamp() + 60);
    let second = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    assert_ne!(first.digest, second.digest);
    assert_eq!(
        client.get_bridge_proof(&agent_id, &TargetChain::Evm(1)),
        Some(second)
    );
    // The rotated-out proof no longer matches the stored record.
    assert_eq!(
        client.try_verify_bridge_proof(&first),
        Err(Ok(Error::BridgeProofMismatch))
    );
}

#[test]
fn an_agent_can_bridge_to_several_chains_at_once() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(19);

    let evm = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));
    let solana = issue_default(&env, &client, &agent_id, &key, TargetChain::Solana);

    assert!(client.try_verify_bridge_proof(&evm).is_ok());
    assert!(client.try_verify_bridge_proof(&solana).is_ok());
}

#[test]
fn the_owner_can_revoke_a_proof() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(20);

    let proof = issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));
    client.revoke_bridge_proof(&owner, &agent_id, &TargetChain::Evm(1));

    assert_eq!(
        client.get_bridge_proof(&agent_id, &TargetChain::Evm(1)),
        None
    );
    assert_eq!(
        client.try_verify_bridge_proof(&proof),
        Err(Ok(Error::BridgeProofNotFound))
    );
}

#[test]
fn the_admin_can_revoke_a_proof() {
    let (env, client, admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(21);

    issue_default(&env, &client, &agent_id, &key, TargetChain::Solana);
    client.revoke_bridge_proof(&admin, &agent_id, &TargetChain::Solana);

    assert_eq!(
        client.get_bridge_proof(&agent_id, &TargetChain::Solana),
        None
    );
}

#[test]
fn a_stranger_cannot_revoke_a_proof() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);
    let key = signing_key(22);
    issue_default(&env, &client, &agent_id, &key, TargetChain::Evm(1));

    let stranger = Address::generate(&env);
    let result = client.try_revoke_bridge_proof(&stranger, &agent_id, &TargetChain::Evm(1));

    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn revoking_a_proof_that_does_not_exist_fails() {
    let (env, client, _admin) = setup();
    let owner = Address::generate(&env);
    let agent_id = register(&env, &client, "agent_a", &owner);

    let result = client.try_revoke_bridge_proof(&owner, &agent_id, &TargetChain::Evm(1));
    assert_eq!(result, Err(Ok(Error::BridgeProofNotFound)));
}
