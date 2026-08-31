# Security review — `agent_bidding` commit-reveal auction

**Contract**: `smart-contracts/contracts/agent_bidding`
**Scope**: the sealed-bid commit-reveal flow — `create_auction`, `submit_bid`,
`reveal_bid`, `reveal_bids`, `award_contract`, `abort_auction`.
**Tracking issue**: [#350](https://github.com/Epta-Node/ai-net/issues/350)

This document is the deliverable half of #350: it states the attack surface of
the auction, the mitigation now in the contract for each attack, and — just as
importantly — the guarantees the contract does **not** make, so integrators do
not assume protection that is not there.

Every mitigation below is covered by a named test in `src/lib.rs`; the test name
is given so a reviewer can go straight from a claim to the code that proves it.

---

## 1. Threat model

**Assets.** Bidder bonds (locked at `submit_bid`), the escrowed task price
(locked at `award_contract`), and the *integrity of the award* — that the
task goes to the bid that actually scored best.

**Adversary.** Any account that can submit transactions. It can:

- read all ledger state, including every sealed commitment and every reveal,
  the instant it lands;
- observe pending transactions before they are included, and submit its own
  transaction in the same or an earlier ledger (front-running);
- create unlimited Stellar accounts (Sybil), bounded only by the XLM each one
  must post as a bond;
- choose to stay silent at any point in the flow.

It cannot forge signatures, break SHA-256, or rewrite history.

**Trust assumptions.** The task creator is trusted to fund the escrow
off-chain; bidder-reported `reputation` is *self-declared* and not verified by
this contract (see §4.1). Ledger timestamps are trusted to within the usual
validator drift, which is why every window is minutes-to-hours, never seconds.

---

## 2. Auction timeline

```text
create_auction                deadline                reveal_deadline
      │                          │                          │
      ├────── bidding window ────┤                          │
      │   submit_bid accepted    │                          │
      │                          ├───── reveal window ──────┤
      │                          │    reveal_bid accepted   │
      │                          │                          ├──► reveal_bids
      │                          │                          │    award_contract
      │                          │                          │    (or abort_auction)
      │                          │                          │
      │                          └── reveal_bids also allowed early,
      │                              but only once revealed_count == bid_count
```

Both windows are bounded by `MIN_PHASE_DURATION_SECS` (60 s) and
`MAX_PHASE_DURATION_SECS` (30 days). A window shorter than a minute is not
reliably reachable across ledger close times, so allowing it would hand the
creator a censorship tool; a window longer than a month would let one call lock
bonds effectively forever.

---

## 3. Attack surface and mitigations

### A-1 — Front-running the finalisation (critical)

**Attack.** `reveal_bids` is permissionless and computes the winner from
whatever has been revealed *so far*. In the original design it became callable
the instant the bidding deadline passed. An attacker could therefore, in a
single ledger: reveal their own (deliberately poor) bid, then call
`reveal_bids`. Selection would run over a field of exactly one — theirs — and
every honest bidder who had not yet gotten a reveal transaction included would
be scored out of the auction entirely. The attacker wins at their own asking
price, having beaten no one.

This is the sharpest form of the problem: it needs no capital beyond one bond,
no Sybils, and no cryptographic work, only transaction ordering.

**Mitigation.** A bounded reveal window, plus a finalisation gate:

```rust
if now < auction.reveal_deadline && auction.revealed_count < auction.bid_count {
    return Err(Error::RevealPeriodActive);
}
```

`reveal_bids` is refused while the window is still open *and* any sealed bid
remains unrevealed. The attacker cannot compress the reveal window; every
bidder gets the full window to reveal. Once `revealed_count == bid_count` there
is nothing left to race, so the auction may be finalised early — this is a
liveness optimisation that cannot be abused, because an attacker cannot make
`revealed_count` reach `bid_count` while an honest bid is still sealed.

*Tests*: `reveal_bids_cannot_be_front_run_while_reveals_are_outstanding`,
`reveal_bids_finalises_early_when_every_bid_is_revealed`,
`reveal_bids_before_deadline_fails`.

### A-2 — The free "last look" option (high)

**Attack.** Reveals are public as they land. A bidder who has not yet revealed
can read every price already disclosed and only then decide whether to open
their own bid. If non-reveal costs nothing, a sealed bid is a free option: bid
aggressively, and if the revealed field shows the bid was a mistake, simply
never reveal and walk away whole. Systematically exercised, this destroys the
information content of the sealed-bid mechanism.

**Mitigation.** Non-reveal is priced. `award_contract` now settles bonds
asymmetrically: bidders who revealed are marked `refunded`, bidders who did not
are marked `forfeited`. The `forfeited` flag is a distinct field from
`refunded`, so an indexer can never confuse "got their bond back" with "lost
it".

The option is not eliminated — it cannot be, since no contract can compel a
signature — it is *priced at the bond*. Creators should therefore set `bond`
at or above the value they estimate the last-look option to be worth for their
task size. A bond of dust re-opens this attack, and no code change can fix
that; it is a configuration duty, called out again in §5.

*Tests*: `award_contract_forfeits_bonds_of_non_revealers`,
`award_contract_refunds_all_revealed_bidders`.

### A-3 — Commitment replay (high)

**Attack.** The original pre-image was `SHA-256(bidder ‖ price ‖ terms ‖ salt)`
— bound to the bidder, but to nothing else. Two consequences:

1. *Cross-auction replay.* The same bidder's commitment for price P is byte-
   identical on every auction. Once they reveal on auction A, the plaintext of
   their still-sealed bid on auction B is public knowledge to anyone who
   compares the two commitments. The seal on B is gone.
2. *Cross-deployment replay.* The same commitment is valid against any
   deployment of this contract, so a testnet reveal unseals a mainnet bid.

**Mitigation.** Domain separation. The pre-image is now:

```text
SHA-256( domain ‖ contract_id ‖ task_id ‖ bidder ‖ price ‖ terms ‖ salt )
```

with `domain = COMMITMENT_DOMAIN = "ai-net:agent_bidding:v2:bid"`. Identical
plaintext produces a different digest on every `(deployment, auction, bidder)`
triple, so a commitment is only ever meaningful in the one place it was built
for.

Copying a *rival's* commitment verbatim was already useless — their address is
in the pre-image — and now costs the copier their bond, since they can never
produce a reveal that verifies and are settled as a non-revealer under A-2.

Off-chain tooling should not re-implement this layout. The contract exposes
`commitment_of(...)`, which is literally the function `reveal_bid` verifies
against, so the two cannot drift. **Compute it locally** — calling it against a
public RPC endpoint hands the plaintext price to whoever operates that node,
which defeats the seal just as thoroughly as publishing it.

*Tests*: `commitment_cannot_be_replayed_across_auctions`,
`commitment_cannot_be_replayed_by_another_bidder`,
`commitment_of_matches_what_reveal_verifies`.

### A-4 — Late reveal / re-reveal (medium)

**Attack.** Two variants: revealing after the winner has been computed in order
to displace them, and re-revealing an already-open bid at a different price.

**Mitigation.** `reveal_bid` enforces `deadline <= now < reveal_deadline`
(`BiddingPeriodActive` / `RevealPeriodEnded`), and refuses a second reveal
(`BidAlreadyRevealed`). After `reveal_bids` the auction leaves the `Bidding`
phase, so every further reveal fails on the phase check. Selection therefore
runs exactly once over a set that is frozen before it runs.

The re-reveal guard also protects the A-1 gate: `revealed_count` must not be
inflatable by replaying a reveal, or an attacker could drive it to `bid_count`
artificially and unlock early finalisation.

*Tests*: `reveal_bid_after_reveal_deadline_fails`, `reveal_bid_twice_fails`,
`late_reveal_cannot_displace_an_already_selected_winner`,
`revealed_bid_cannot_be_reopened_at_a_new_price`, `reveal_bids_twice_fails`.

### A-5 — Double commit / commitment overwrite (medium)

**Attack.** If a bidder could submit a second commitment, the first would not
be binding: they could re-commit late in the bidding window, or hold two
commitments and open whichever the revealed field favoured.

**Mitigation.** One bid per `(task_id, bidder)`. A second `submit_bid` is
`BidAlreadyExists`, whether or not the commitment differs from the first. The
originally stored commitment is the one that stands.

*Tests*: `submit_bid_duplicate_fails`,
`submit_bid_second_different_commitment_fails`.

### A-6 — Unbounded position size (medium)

**Attack.** Nothing bounded the revealed price, so a winning bid could commit
the creator to an arbitrarily large escrow. Nothing bounded `terms`, so a
bidder could park unbounded bytes in contract storage. Nothing bounded the
bidder list, so `reveal_bids` and `award_contract` — both of which iterate it —
could be pushed past the transaction resource limit, permanently wedging the
auction and stranding every bond.

**Mitigation.** Three caps:

| Cap | Constant | Enforced at |
|---|---|---|
| Price ceiling per auction | `AuctionConfig.max_price` (`0` → `MAX_BID_PRICE`) | `reveal_bid` → `InvalidPrice` |
| Global price ceiling | `MAX_BID_PRICE` = 10¹⁷ stroops | `create_auction` → `InvalidPrice` / `InvalidPriceRange` |
| Bidders per auction | `MAX_BIDDERS` = 100 | `submit_bid` → `AuctionFull` |
| `terms` length | `MAX_TERMS_LEN` = 512 bytes | `reveal_bid` → `TermsTooLong` |

The price cap is enforced at *reveal*, not at commit — the contract cannot see
a sealed price, which is the entire point of the mechanism. An over-cap bidder
therefore burns their bond discovering their bid was inadmissible, which is the
correct incentive.

`MAX_BID_PRICE` also keeps the scoring arithmetic away from `i128` overflow:
the largest intermediate is `SCORE_SCALE * price ≈ 10²⁰`, some 18 orders of
magnitude below `i128::MAX`. The arithmetic is nonetheless written with
`checked_*` throughout, returning `ArithmeticOverflow` rather than panicking, so
a future edit that loosens the cap degrades to a clean error instead of a
wedged auction.

`get_bidders` is paginated and clamps `limit` to 50, so no view can be asked to
materialise an unbounded vector either.

*Tests*: `submit_bid_rejects_beyond_max_bidders`,
`reveal_bid_rejects_price_above_cap`, `reveal_bid_rejects_price_below_reserve`,
`reveal_bid_rejects_oversized_terms`,
`create_auction_rejects_inverted_price_range`,
`create_auction_rejects_price_above_global_ceiling`,
`get_bidders_pages_and_clamps_limit`.

### A-7 — Stranded bonds on a dead auction (medium)

**Attack.** Not an attack so much as a liveness hole that an attacker can
trigger: if nobody reveals, `reveal_bids` returns `NotEnoughBids` forever, the
auction never leaves `Bidding`, and every bond is locked permanently. A griefer
who bids on many auctions and never reveals imposes exactly this on every
counterparty.

**Mitigation.** `abort_auction` — callable by anyone (authenticated) once
`now >= reveal_deadline` and `revealed_count == 0`. It moves the auction to
`Cancelled` and releases every bond.

Bonds are *refunded* here, not forfeited: with no winner there is no
counterparty the forfeiture would compensate, so burning them would destroy
value without deterring anything. Forfeiture in A-2 is meaningful precisely
because there *is* a winner who was harmed by the withdrawal.

The path is deliberately permissionless — restricting it to the creator would
let a vanished creator strand other people's bonds. It is also strictly gated:
if even one bid was revealed, `abort_auction` returns `AuctionNotAbortable` and
the auction must be finalised through `reveal_bids`, so it can never be used to
discard an auction someone legitimately won.

*Tests*: `abort_auction_releases_bonds_when_nobody_reveals`,
`abort_auction_rejected_while_reveal_window_open`,
`abort_auction_rejected_when_a_bid_was_revealed`,
`cancelled_auction_accepts_no_further_calls`.

### A-8 — Unauthenticated state mutation (medium)

**Attack.** `reveal_bids` and `award_contract` originally took no caller and
performed no `require_auth()`, contrary to the repository invariant that every
on-chain mutation authenticates. `award_contract` in particular could be
triggered by a complete stranger, fixing the escrow terms between two parties
neither of whom asked for it at that moment.

**Mitigation.** Both now take a `caller: Address` and call
`caller.require_auth()`.

- `reveal_bids` stays *permissionless but attributable*: any authenticated
  caller may finalise, because the outcome is a pure function of frozen on-chain
  state, so who calls it cannot change what it decides.
- `award_contract` additionally requires `caller == creator || caller == winner`
  — the two parties the escrow actually binds. Anyone else gets `Unauthorized`.

*Tests*: `award_contract_rejects_unrelated_caller`, `award_contract_twice_fails`.

### A-9 — Terminal-phase re-entry (low)

**Attack.** Calling into an auction that has already settled, hoping a stale
code path re-runs a refund or re-creates an escrow.

**Mitigation.** `require_live` rejects any mutating call on an `Awarded` or
`Cancelled` auction with `AuctionClosed`; `award_contract` guards `Awarded`
explicitly with `AlreadyAwarded` and re-checks `escrow_created`. Bond settlement
skips any bid already marked `refunded` or `forfeited`, so even a hypothetical
double-settlement cannot double-count.

*Tests*: `cancelled_auction_accepts_no_further_calls`,
`award_contract_twice_fails`.

---

## 4. Residual risk — what this contract does *not* defend against

These are real limitations. They are listed so integrators plan around them
rather than discover them.

### 4.1 Reputation is self-declared

`submit_bid` takes `reputation` as a caller-supplied `u32` and validates only
that it is in `[0, 100]`. Nothing stops every bidder from claiming 100. Since
reputation carries 40 % of the composite score, a marketplace that cares about
the score being meaningful must source reputation from an attested oracle or the
`agent_registry` contract rather than from the bidder. **Until then, treat the
score as price-driven with an advisory reputation tiebreak.**

### 4.2 Reveals are public as they land

Bids revealed earlier in the window are visible to bidders who have not revealed
yet. Their commitments are already fixed, so they cannot *change* a bid — but
they retain the walk-away option that A-2 prices rather than removes. Only a
scheme with encrypted reveals or threshold decryption removes it outright; that
is out of scope here.

### 4.3 Sybil bidding

Bond cost is the only Sybil resistance. An adversary willing to post `N × bond`
can occupy N of the `MAX_BIDDERS` slots and crowd out honest bidders. Bond
sizing is again the lever.

### 4.4 Bonds and escrow are state, not custody

`SealedBid.bond` and `Escrow.amount` model the *accounting* of locked value.
This contract does not itself move XLM or invoke a token contract; an escrow
contract or off-chain relayer must honour the flags. **A `refunded` /
`forfeited` / `released` flag is an instruction to that component, not proof
that value moved.** Any integration must settle real funds against these flags,
or the incentives described above do not exist economically.

### 4.5 Timestamp granularity

All windows use `env.ledger().timestamp()`, which validators can nudge within a
small drift. `MIN_PHASE_DURATION_SECS` of 60 s keeps that drift immaterial
relative to window length. Do not build a workflow that depends on second-level
precision at a window boundary.

---

## 5. Guidance for creators

1. **Size the bond against the last-look option (§A-2), not against spam.** The
   bond is the entire price of walking away after seeing the field. A token bond
   restores the free option that A-2 exists to remove.
2. **Set `max_price` deliberately.** Leaving it `0` normalises to `MAX_BID_PRICE`
   (10¹⁰ XLM) — technically safe for the arithmetic, but no real cap. Set it to
   the largest position you are prepared to escrow.
3. **Give the reveal window room.** It must comfortably exceed the time an agent
   needs to notice the bidding deadline and land a transaction. An hour is the
   default for a reason.
4. **Compute commitments locally** with `commitment_of` semantics — never by
   invoking the view against a third-party RPC endpoint (§A-3).
5. **Wire `forfeited` into settlement.** If the settlement component treats
   `forfeited` as `refunded`, A-2's mitigation silently disappears (§4.4).

---

## 6. Error-code reference for the hardening

| Code | Variant | Raised when |
|---|---|---|
| 18 | `RevealPeriodEnded` | `reveal_bid` after `reveal_deadline` |
| 19 | `RevealPeriodActive` | `reveal_bids`/`abort_auction` while reveals are still possible |
| 20 | `AuctionFull` | `submit_bid` beyond `MAX_BIDDERS` |
| 21 | `InvalidDuration` | phase duration outside `[MIN, MAX]_PHASE_DURATION_SECS` |
| 22 | `TermsTooLong` | revealed `terms` exceeds `MAX_TERMS_LEN` |
| 23 | `InvalidPriceRange` | `max_price < reserve_price`, or above `MAX_BID_PRICE` |
| 24 | `AuctionClosed` | any mutation on an `Awarded`/`Cancelled` auction |
| 25 | `AuctionNotAbortable` | `abort_auction` when a bid was revealed |
| 26 | `ArithmeticOverflow` | checked arithmetic failed during scoring |

Codes `1..=17` are unchanged and keep their original meaning. Per the contract's
own rule, no existing variant was renumbered.
