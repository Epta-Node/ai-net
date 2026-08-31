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
- [ ] **T10** — Logging: no secrets or PII in log output

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
