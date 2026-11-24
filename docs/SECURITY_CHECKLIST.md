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
