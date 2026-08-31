# Cross-Chain Agent Identity Bridging

An agent registered in `agent_registry` on Stellar may also work on an EVM chain
or on Solana. Those chains cannot read Stellar state, so recognition has to
travel as a self-contained artefact: a **bridge proof**.

## What a proof asserts

> At `issued_at`, the holder of `stellar_pubkey` was the registered owner of
> `agent_id`, and authorised its use on `target_chain` until `expiry`.

It does **not** assert anything about the agent's reputation, bond or current
status. A verifier that needs those must read the registry directly.

## Lifecycle

```
  bridge_identity        verify_bridge_proof         expiry
        │                        │                     │
        ▼                        ▼                     ▼
   ┌─────────┐            ┌─────────────┐        ┌──────────┐
   │ issued  │───────────▶│  verified   │ ─────▶ │ expired  │
   └─────────┘            └─────────────┘        └──────────┘
        │                                              ▲
        └──────── revoke_bridge_proof ─────────────────┘
```

## Issuing a proof

```rust
client.bridge_identity(
    &agent_id,        // Symbol, must be registered and not frozen
    &stellar_pubkey,  // BytesN<32>, raw ed25519 public key
    &target_chain,    // TargetChain::Evm(chain_id) | TargetChain::Solana
    &ttl_secs,        // 0 selects the 24h default; ceiling is 30 days
    &signature,       // BytesN<64> over the canonical message below
);
```

The registered **owner** of the agent must authorise the call. The registry then
verifies `signature` against `stellar_pubkey` before storing anything, so a
request the key holder did not authorise cannot mint a proof.

Re-bridging the same agent to the same chain **replaces** the previous proof.
That is how a proof is rotated; the rotated-out proof stops verifying.

## The canonical message

Both the registry and any off-chain verifier must hash exactly the same bytes.
The layout is fixed:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 31 | Domain tag, ASCII `ai-net.agent-registry.bridge.v1` |
| 31 | 4 | Length of the agent-id field, big-endian `u32` |
| 35 | *n* | Agent id, as its `ScVal` XDR encoding |
| 35+*n* | 1 | Chain tag: `1` = EVM, `2` = Solana |
| 36+*n* | 4 | EIP-155 chain id, big-endian `u32`; `0` for Solana |
| 40+*n* | 32 | `stellar_pubkey` |
| 72+*n* | 8 | `issued_at`, big-endian `u64` seconds |
| 80+*n* | 8 | `expiry`, big-endian `u64` seconds |

The digest is `SHA-256` over that byte string.

Three details are deliberate:

- **The domain tag** prevents these bytes being reinterpreted as some other
  protocol's signed message.
- **The chain tag and chain id are signed**, so a proof minted for Ethereum
  mainnet cannot be replayed on Base, or on Solana.
- **The agent id is length-prefixed**, so `("ab", "c")` and `("a", "bc")` cannot
  collide.

The agent id is encoded as its `ScVal` XDR rather than as raw characters.
`soroban_sdk::Symbol` exposes no byte accessor that survives the
`wasm32v1-none` build, whereas XDR serialisation is a host function and a
documented Stellar encoding. An off-chain verifier reproduces it with any
Stellar SDK:

```js
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";

const idXdr = nativeToScVal("agent_a", { type: "symbol" }).toXDR(); // Buffer
```

## Verifying

There are two ways to check a proof, covering the same bytes.

### On Stellar, against the registry

```rust
client.verify_bridge_proof(&proof)?;
```

Returns `Ok(())` only when the presented proof matches the stored record field
for field and has not expired. Failures are typed:

| Error | Meaning |
|-------|---------|
| `BridgeProofNotFound` | No proof for this agent and chain — never issued, or revoked |
| `BridgeProofMismatch` | The proof does not match the stored record, or its digest disagrees with its own fields |
| `BridgeProofExpired` | Past `expiry` |

Every attempt emits `BridgeProofVerifiedEvent`, **including failures**, so an
indexer can see a chain repeatedly presenting stale proofs.

### On the target chain, offline

A contract on the target chain cannot read Stellar. It instead:

1. Rebuilds the canonical message from the proof's fields.
2. Hashes it with SHA-256 and checks the result equals `proof.digest`.
3. Verifies `proof.signature` against `proof.stellar_pubkey` (ed25519).
4. Checks `proof.expiry` against its own clock.
5. Checks `proof.target_chain` names *this* chain.

Step 5 is not optional. Without it a proof for another chain, which is otherwise
perfectly valid, would be accepted.

#### Solidity sketch

```solidity
// Ed25519 is not a precompile on most EVM chains; use a verifier library
// or a zk/attestation bridge. The message construction is the part that
// must match exactly.
bytes memory message = abi.encodePacked(
    "ai-net.agent-registry.bridge.v1",
    uint32(agentIdXdr.length),
    agentIdXdr,
    uint8(1),                 // CHAIN_TAG_EVM
    uint32(block.chainid),
    stellarPubkey,
    uint64(issuedAt),
    uint64(expiry)
);
require(sha256(message) == digest, "digest mismatch");
require(block.timestamp <= expiry, "proof expired");
```

## Revocation and its limits

```rust
client.revoke_bridge_proof(&caller, &agent_id, &target_chain)?;
```

`caller` must be the agent's owner or the registry admin. The admin is permitted
so that a compromised agent key cannot strand a live proof.

**Revocation only clears the registry's record.** A verifier that checks the
signature offline has no way to learn about it. This is precisely why proof
lifetimes are capped at 30 days (`MAX_BRIDGE_TTL_SECS`): for an offline
verifier, expiry is the only thing that bounds a leaked proof. Choose the
shortest TTL your integration can tolerate.

If you need revocation to be observable off-chain, have the target chain call
`verify_bridge_proof` through a bridge or oracle rather than verifying offline.

## Events

| Event | Topic | Emitted when |
|-------|-------|--------------|
| `IdentityBridgedEvent` | `("registry", "bridged")` | A proof is issued or rotated |
| `BridgeProofVerifiedEvent` | `("registry", "brdg_vrfy")` | Any verification attempt, pass or fail |
| `BridgeProofRevokedEvent` | `("registry", "brdg_revk")` | A proof is revoked before expiry |

## Constants

| Name | Value | Meaning |
|------|-------|---------|
| `DEFAULT_BRIDGE_TTL_SECS` | 86 400 | Lifetime when `ttl_secs` is `0` |
| `MAX_BRIDGE_TTL_SECS` | 2 592 000 | Ceiling on a proof's lifetime (30 days) |

## Adding a chain

`TargetChain` is a `#[contracttype]` enum and its discriminants are part of the
signed message. Adding a variant is safe; **changing an existing tag invalidates
every proof already issued for that chain**. Bump the domain tag to `...v2` if
the message layout itself ever has to change.
