# Security Checklist — Release Gate

**Every item must be checked before tagging a release.**  
Unchecked items must have a tracked issue with owner and ETA.

---

## Pre-Release Gate

- [ ] **T1** — Threat model reviewed: `docs/THREAT_MODEL.md` exists and covers all contracts
- [ ] **T2** — No hardcoded secrets: `STELLAR_SECRET_KEY`, `VENICE_API_KEY`, DB passwords absent from source
- [ ] **T3** — All environment variables validated at startup (fail-fast on missing required vars)
- [ ] **T4** — Input validation: all API endpoints use Zod/schema validation on request body
- [ ] **T5** — SQL injection prevention: all queries use parameterized statements (no string concatenation)
- [ ] **T6** — XSS prevention: frontend HTML is escaped; no `dangerouslySetInnerHTML` on untrusted content
- [ ] **T7** — CSRF: SameSite=Strict cookies on all auth tokens
- [ ] **T8** — Rate limiting: all API endpoints have rate limits configured
- [ ] **T9** — Error messages: no stack traces or internal details leaked to clients
- [ ] **T10** — Logging: no secrets or PII in log output (see [Log Redaction](#log-redaction); `backend/src/utils/logger.redaction.test.ts` passes)

## Log Redaction

All backend logging goes through `backend/src/utils/logger.ts`. Redaction runs in three layers, so a single missed rule doesn't leak a secret:

1. **Pino `redact` paths** censor known keys (`apiKey`, `token`, `signature`, `jwt`, `veniceApiKey`, `headers.authorization`, `headers.cookie`, `headers["x-api-key"]`, `prompt`, `completion`, ...) with `[REDACTED]`.
2. **Recursive sanitizer** (`sanitizeLogPayload`) runs on every log argument and every `logger.child()` binding:
   - keys matching `secret|token|api_key|password|authorization|cookie|private_key|seed|signature|jwt|credential` become `[REDACTED]`
   - prompt, completion and request/response body keys become `[REDACTED_BODY]`
   - Stellar secret seeds, `Bearer ...` tokens, JWTs and `key=value` secrets are scrubbed out of free-text strings
   - Stellar addresses become `[REDACTED_ADDRESS]`; fields longer than 500 chars are truncated
3. **Whitelisting serializers** for `req` and `res` emit only `id`, `method`, `path` (query string dropped), `ip` and `statusCode`. Headers and bodies are never serialized.

When adding a new secret-bearing field, add its key to `SECRET_KEY_RE` and a payload to the canary test. The canary test logs a known secret through every path above and fails if it appears in the output.

## Smart Contracts

- [ ] **S1** — Coordinator: `CyclicDAGError` thrown for circular dependency detection
- [ ] **S2** — Coordinator: `handleAgentFailure` retries with fallback agents correctly
- [ ] **S3** — Coordinator: `MAX_RETRIES` (3) enforced per agent before failover
- [ ] **S4** — Payment: `lockEscrow` rejects taskId > 28 bytes (Stellar Memo limit)
- [ ] **S5** — Payment: `releasePayment` atomic claim+pay (single Stellar transaction)
- [ ] **S6** — Payment: `EscrowAlreadySettledError` thrown for double-release attempts
- [ ] **S7** — Payment: `getEscrowBalance` returns 0 for settled balances (not a false positive)
- [ ] **S8** — Registry: `clearRegistry` provides test isolation (no cross-test contamination)

## Fault Injection Tests

- [ ] **F1** — Agent crash: node retries with fallback agent, task completes
- [ ] **F2** — All agents for type fail: node marked failed, dependent nodes cascade-fail
- [ ] **F3** — Provider timeout: abort triggers retry, then fallback
- [ ] **F4** — Horizon 429/504: exponential backoff retries, then fails cleanly
- [ ] **F5** — Horizon 404 on release: `EscrowAlreadySettledError` thrown (not silent)
- [ ] **F6** — Horizon 404 on refund: `EscrowAlreadySettledError` thrown (not silent)

## Reconciliation

- [ ] **R1** — Drift detection runs on configurable interval (default 5 minutes)
- [ ] **R2** — DB records vs on-chain claimable balance status compared
- [ ] **R3** — Drift events logged with full diff (DB status, on-chain status, timestamp)
- [ ] **R4** — Idempotent repair: re-running reconciliation produces same result
- [ ] **R5** — Alert emitted when drift detected (event bus or webhook)

## i18n

- [ ] **I1** — Zero untranslated UI strings (en/zh parity test passes in CI)
- [ ] **I2** — Language switcher persists choice to localStorage
- [ ] **I3** — `<html lang>` attribute synced on language change
- [ ] **I4** — `zh-CN` resolves to `zh` bundle (languageOnly mode active)

## CI/CD

- [ ] **C1** — All tests pass (unit + integration + fault injection)
- [ ] **C2** — Linter passes with zero warnings
- [ ] **C3** — TypeScript compilation succeeds with zero errors
- [ ] **C4** — Test coverage >= 80% for new code
- [ ] **C5** — No new `console.log` or `debug` statements in committed code

## Automated Controls (Issue #854)

These checks run on every PR/push without human action. Verify the linked
workflow is still present and green before release:

| Control | Workflow | What it enforces |
|---|---|---|
| Dependency audit (backend, frontend) | `.github/workflows/ci.yml` → `security-audit` | `npm audit --audit-level=high` fails the job on any high/critical advisory |
| Secret scanning | `.github/workflows/ci.yml` → `secret-scan` | TruffleHog scans the full git history (base = default branch, head = HEAD) for committed credentials |
| Container CVE scanning | `.github/workflows/ci.yml` → `container-scan` | Trivy scans the built backend image; HIGH/CRITICAL CVEs fail the job |
| Static analysis (JS/TS + Rust) | `.github/workflows/codeql.yml` | CodeQL on push/PR to main + nightly schedule; results land in the Security tab |
| Rust dependency audit | `.github/workflows/smart-contracts.yml` → `dependency-audit` | `cargo audit --locked` + `cargo deny` on every smart-contracts change |
| Fault injection suite | `tests/e2e/fault-injection.test.ts` (`npm run test:fault`) | Agent crash, capability outage, payment failure, Horizon outage, drift repair, SSE replay, idempotency |
| Full quality gate | `npm run gate` | format + lint + typecheck + coverage thresholds + i18n parity + env validation |

## Manual Review Checklist — Soroban Contracts

Automated scans cannot reason about on-chain authorization semantics. Before
any contract release, a human must confirm **every** invariant:

- [ ] **M1** — Every state-mutating entry point calls `require_auth()` for the
      exact address that owns the mutation (no shared/pooled authorities).
- [ ] **M2** — No `unwrap()`/`expect()` on external input; all fallible
      arithmetic uses checked ops (`checked_add`, `checked_mul`) or
      `try_into()` with a contract-level error.
- [ ] **M3** — Reentrancy guard (`reent` require) is entered before any state
      write in every guarded entry point, and the guard rolls back on `Err`.
- [ ] **M4** — Escrow amounts and fee math are type-safe (`i128` stroops);
      no float conversion anywhere in payment paths.
- [ ] **M5** — Claimable-balance IDs, task IDs, and memo payloads are bounded
      (≤ 28 bytes) and validated before storage.
- [ ] **M6** — Pagination cursors bound every collection read/write; no
      unbounded vector iteration in a single transaction (read ≤ 100 entries,
      write ≤ 50 entries per tx).
- [ ] **M7** — TTLs (`extend_ttl`) are refreshed on every access path;
      temporary storage cannot outlive its intended entity.
- [ ] **M8** — Events are emitted for every state transition an operator
      must reconcile, and event payloads never contain secrets.
- [ ] **M9** — Double-settlement is impossible: release/refund are
      idempotent or guarded by an explicit status enum check.
- [ ] **M10** — Admin/config setters validate new values before persisting
      (limits > 0, addresses non-zero, no self-transfer where forbidden).
- [ ] **M11** — Upgrade authority is a multisig/dao, not a single
      developer key; `update_current_contract_wasm` is `require_auth`'d.
- [ ] **M12** — Tests cover the failure paths (see Fault Injection list),
      not only happy paths; every `Err(...)` variant has at least one test.

---

## Smart Contract Deployment Security

The checklists below are **mandatory gates** at each phase of a Soroban contract
deployment or upgrade. They complement the automated CI controls and the manual
Soroban invariants (M1–M12) already defined above.

> **Reference docs:**
> - Deployment workflow — [`smart-contracts/docs/DEPLOYMENT_GUIDE.md`](../smart-contracts/docs/DEPLOYMENT_GUIDE.md)
> - Upgrade workflow — [`smart-contracts/docs/UPGRADE_GUIDE.md`](../smart-contracts/docs/UPGRADE_GUIDE.md)
> - Storage migration — [`smart-contracts/docs/STORAGE_MIGRATION.md`](../smart-contracts/docs/STORAGE_MIGRATION.md)
> - Threat model — [`docs/THREAT_MODEL.md`](THREAT_MODEL.md)

---

### D1 — Pre-Deployment Checklist

Complete these before running `deploy.sh` against any network.

#### Code Audit
- [ ] **D1.1** — An independent reviewer (not the author) has read every
      state-mutating entry point and confirmed `require_auth()` is called for
      the correct address on each one (see M1).
- [ ] **D1.2** — No `unwrap()` or `expect()` on external input anywhere in the
      contract under deployment; all arithmetic uses checked ops (see M2).
- [ ] **D1.3** — `cargo clippy --all-targets -- -D warnings` passes with zero
      warnings on the release commit.
- [ ] **D1.4** — `cargo fmt --check` passes (no unformatted code).
- [ ] **D1.5** — `cargo audit --locked` and `cargo deny check` show no
      HIGH/CRITICAL advisories (run via `smart-contracts.yml` CI job or locally).
- [ ] **D1.6** — Wasm binary size is within the budget tracked in
      `smart-contracts/wasm-sizes.json`; `scripts/check-wasm-size.mjs` passes.
- [ ] **D1.7** — `scripts/check_upgrade_paths.sh` passes — confirms no contract
      calls `update_current_contract_wasm` outside the canonical upgrade path.

#### Gas Limits
- [ ] **D1.8** — Gas cost estimates for every entry point have been checked
      against `smart-contracts/gas-baselines.json`; `scripts/check-gas-baselines.mjs`
      passes.
- [ ] **D1.9** — No entry point iterates an unbounded collection in a single
      transaction; pagination cursors cap all reads at ≤ 100 items and writes at
      ≤ 50 items (see M6).
- [ ] **D1.10** — TTL `extend_ttl` calls are present on every access path for
      Persistent and Temporary storage; no key can silently expire mid-operation
      (see M7).

#### Access Control
- [ ] **D1.11** — Admin address is a multisig (governance contract or hardware
      wallet), not a single developer key (see M11).
- [ ] **D1.12** — The upgrade authority has been connected to the `UpgradeManager`
      contract; no contract exposes a direct `update_current_contract_wasm` path
      outside the canonical `Upgradeable` trait.
- [ ] **D1.13** — Every config setter validates its input before persisting:
      limits > 0, addresses non-zero, no self-transfer where forbidden (see M10).
- [ ] **D1.14** — The full contract test suite (`cargo test`) passes, including
      all failure-path tests for every `Err(...)` variant (see M12).

---

### D2 — Deployment Checklist

Complete these during and immediately after running `deploy.sh`.

#### Key Management
- [ ] **D2.1** — `STELLAR_SECRET_KEY` is loaded from an environment variable or
      secrets manager — never from a checked-in file or hardcoded string.
- [ ] **D2.2** — The deploying keypair is network-specific (a testnet key is
      never reused on mainnet and vice versa).
- [ ] **D2.3** — After deployment, the deploying keypair's on-chain authority is
      transferred to the multisig admin; the deployment key is rotated or retired.
- [ ] **D2.4** — All contract IDs, Wasm hashes and deployment timestamps are
      recorded in the versioned metadata file
      (`smart-contracts/deployments/<network>.json`) and committed to the repository.
- [ ] **D2.5** — Private keys and seed phrases are absent from deployment metadata
      files, CI logs, and any artifact published during this workflow.

#### Network Verification
- [ ] **D2.6** — `scripts/verify.sh --network <network> --strict` exits zero; the
      on-chain Wasm hash and admin address match the deployment metadata.
- [ ] **D2.7** — The correct network passphrase was used during deployment
      (testnet / futurenet / mainnet — see `DEPLOYMENT_GUIDE.md`).
- [ ] **D2.8** — The deploying account has sufficient XLM to cover all contract
      storage rent for the expected operation period; balance checked via Horizon.
- [ ] **D2.9** — A dry-run (`./scripts/upgrade.sh --dry-run`) was executed before
      any upgrade to confirm exactly which contracts will be modified.
- [ ] **D2.10** — For mainnet: the deployment transaction hash has been recorded
      and the deployment confirmed in Stellar Explorer before proceeding.

---

### D3 — Post-Deployment Checklist

Complete these within 24 hours of a successful deployment or upgrade.

#### Event Monitoring
- [ ] **D3.1** — An event subscription (via Horizon streaming or a backend worker)
      is active for every state-transition event emitted by the deployed contracts;
      see `smart-contracts/docs/TASK_STORE_EVENTS.md` and
      `smart-contracts/docs/events.md` for the event catalogue.
- [ ] **D3.2** — Alerts are configured to fire when any contract emits an
      error-level event (e.g. bond slashed, dispute filed, escrow expired).
- [ ] **D3.3** — The reconciliation service (`EventRetentionService` / payment
      reconciliation) has been restarted and confirmed healthy against the new
      contract addresses.
- [ ] **D3.4** — Gas baseline snapshots have been updated (`cargo test` for gas
      tests, then commit updated `gas-baselines.json`) so regressions are caught
      on the next change.

#### Upgrade Plan
- [ ] **D3.5** — A rollback plan is documented: the previous Wasm hash is recorded
      in the deployment metadata and a `rollback_upgrade` command is known to the
      on-call operator. The 48-hour rollback window is tracked.
- [ ] **D3.6** — The next scheduled upgrade version and migration plan have been
      drafted (or explicitly marked "no upgrade planned") so the team is not
      surprised by storage-layout constraints later.
- [ ] **D3.7** — Deployment metadata (`deployments/<network>.json`) and
      `DEPLOYMENT_GUIDE.md` are up to date; a PR with these changes has been merged.
- [ ] **D3.8** — A post-deployment smoke test has run against the live contract
      (at minimum: register a test agent, submit a test task, verify payment flow
      end-to-end on testnet).

---

### D4 — Emergency Response Procedures

Use these procedures when a deployed contract exhibits unexpected behaviour, a
security vulnerability is discovered, or an upgrade must be reversed.

#### Immediate triage (< 1 hour)
1. **Pause the contract** (if the contract supports a pause entry point) to
   prevent further state mutations while the incident is assessed:
   ```bash
   stellar contract invoke --network <network> \
     --source-account $STELLAR_SECRET_KEY \
     --id $CONTRACT_ID -- pause
   ```
2. **Freeze affected agent(s)** via the registry admin if the incident involves
   a rogue or compromised agent:
   ```bash
   stellar contract invoke --network <network> \
     --source-account $STELLAR_SECRET_KEY \
     --id $REGISTRY_ID -- freeze_agent --agent_id <AGENT_ADDRESS>
   ```
3. **Capture on-chain state** — record the current ledger sequence, event log
   cursor, and any affected balance IDs before any recovery action modifies them.

#### Rollback (within 48-hour window)
4. Confirm the rollback window is still open:
   ```bash
   stellar contract invoke --network <network> \
     --source-account $STELLAR_SECRET_KEY \
     --id $UPGRADE_MANAGER_ID -- can_rollback
   ```
5. Execute rollback via the `UpgradeManager`:
   ```bash
   stellar contract invoke --network <network> \
     --source-account $STELLAR_SECRET_KEY \
     --id $UPGRADE_MANAGER_ID -- rollback_upgrade
   ```
6. Run `scripts/verify.sh --network <network> --strict` to confirm the rollback
   restored the previous Wasm hash and admin address.
7. Resume the contract (if it was paused in step 1) only after the rollback is
   verified.

#### Rollback window expired
8. If the 48-hour window has closed, prepare a **recovery upgrade** that patches
   the vulnerability, test it on testnet against a copy of production state, then
   execute the full D1 → D2 → D3 workflow again.
9. Do **not** use `--force` to bypass safety checks during a recovery upgrade;
   the forced path skips pre-upgrade hooks and version compatibility checks.

#### Escrow / payment incident
10. For a payment contract incident, do not attempt manual claimable-balance
    operations against active task escrows without first halting the coordinator.
    Incorrect manual claims are irreversible on Stellar.
11. Contact the reconciliation team to run a full drift scan
    (`npm run reconcile` or the admin API endpoint) before and after any
    manual recovery action to establish a clear before/after record.

#### Post-incident
12. File a post-mortem issue within 48 hours covering: timeline, root cause,
    affected contracts/users, recovery actions taken, and preventive measures.
13. Update the threat model (`docs/THREAT_MODEL.md`) if the incident revealed a
    previously unmodelled attack surface.
14. Add a regression test (`cargo test`) that would have caught the issue, and
    verify it fails on the vulnerable code before merging the fix.

---

## Pre-Mainnet Security Gate

A mainnet release additionally requires:

- [ ] All Pre-Release Gate, Smart Contracts, and CI/CD items checked above.
- [ ] All 12 manual Soroban invariants (M1–M12) signed off by a reviewer who
      did not write the change.
- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings`, and
      `cargo fmt --check` all green on the release commit.
- [ ] `npm run gate` green on the release commit.
- [ ] Fault injection suite (`npm run test:fault`) green against the release
      commit with the production docker-compose topology.
- [ ] No open HIGH/CRITICAL findings from `security-audit`, `secret-scan`,
      `container-scan`, or CodeQL for the release commit.
- [ ] Threat model (`docs/THREAT_MODEL.md`) re-reviewed for any new contract,
      endpoint, or key-management surface.

---

## Sign-Off

| Item | Owner | Status | Date |
|------|-------|--------|------|
| Threat model | | | |
| Fault injection | | | |
| Reconciliation | | | |
| i18n parity | | | |
| Full checklist | | | |

**Release blocked** if any CRITICAL or HIGH item is unchecked.
