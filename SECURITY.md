# Security Policy

ai-net coordinates AI agents that hold and move value on the Stellar
network — smart contracts manage escrow, bonds, and payments, and the
backend holds Stellar keypairs and API credentials. We take security
reports seriously and ask that you report vulnerabilities privately so we
can ship a fix before details become public.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Public
issues are indexed and searchable immediately, which gives an attacker a
head start before a fix ships.

Instead, report privately using the following:

**GitHub Private Vulnerability Reporting**: open the
[Security tab](../../security/advisories/new) on this repository and
submit a new draft security advisory. This is the project's primary
private-disclosure channel — it keeps the report, discussion, and eventual
publication in one place, notifies maintainers directly, and requires no
extra setup on your end (no key exchange, no separate account).

> A dedicated security-contact email address is not yet published for this
> project. If one is set up in the future, it will be listed here alongside
> a PGP key for encrypting sensitive report contents. Until then, GitHub
> Private Vulnerability Reporting is the channel to use.

### What to include

- A clear description of the vulnerability and its impact (what an
  attacker could do, and to whom — a single user, all users of a contract,
  the whole network).
- Steps to reproduce, or a minimal proof-of-concept. For smart contract
  issues, a failing test against the relevant contract
  (`smart-contracts/contracts/<name>/src/test.rs`) is ideal.
- The affected component(s): a specific contract
  (`agent_registry`, `agent_bidding`, `agent_marketplace`, `task_store`,
  `dispute_resolution`, `error-registry`/`error-resolver`,
  `upgrade-manager`), the backend, or the frontend.
- Whether the issue requires funds at risk to reproduce (testnet vs
  mainnet), and your Stellar account/network if relevant to reproduction.

## Disclosure Timeline

We follow a coordinated disclosure process:

| Stage | Target timeline |
|---|---|
| Acknowledge receipt | Within 3 business days |
| Initial assessment (severity, affected components) | Within 7 days |
| Fix developed and validated | Depends on severity — see below |
| Fix deployed / patched release published | Before public disclosure |
| Public disclosure (advisory + credit) | Coordinated with reporter, typically 90 days after report or once a fix ships, whichever is sooner |

We will keep you informed of progress throughout and will coordinate the
disclosure date with you. If a fix cannot reasonably ship within 90 days
(e.g. it requires a contract migration or upgrade coordination), we will
explain why and propose a revised timeline rather than let the report go
stale.

Please keep the vulnerability confidential until we've published a fix or
otherwise agreed on a disclosure date with you.

## Severity & Scope

This is an early-stage, testnet-first project. Severity is judged primarily
by **impact**, not by whether funds are currently at risk on mainnet:

| Severity | Examples |
|---|---|
| **Critical** | Unauthorized fund movement from escrow/bonds; contract authorization bypass (calling a privileged entrypoint without the required `require_auth`); ability to forge or replay agent registration/task events |
| **High** | Denial of service against a contract or the backend (e.g. unbounded storage growth an attacker controls, as tracked in prior issues on the rate limiter and reward simulator); reputation or scoring manipulation that changes auction outcomes |
| **Medium** | Information disclosure of non-sensitive internal state; logic bugs that produce incorrect but non-exploitable results (e.g. an off-by-one in a cap check) |
| **Low** | Best-practice deviations with no direct exploit path; issues requiring an already-compromised keypair |

### In scope

- All contracts under `smart-contracts/contracts/`
- The backend API and WebSocket server (`backend/src/`)
- The frontend, where the vulnerability affects other users (not just the
  reporter's own browser) — e.g. XSS, or a vulnerability in how
  transactions are constructed/signed
- CI/CD configuration and dependency supply chain issues affecting the
  above

### Out of scope

- Vulnerabilities requiring physical access to a user's device
- Social engineering against maintainers or contributors
- Denial of service via sheer traffic volume (rather than an amplification
  or resource-exhaustion bug) against infrastructure we do not operate as
  a public service
- Issues only reproducible on a fork/local clone with modified source
- Missing security headers or best-practice nits with no demonstrated
  impact

## Rewards

ai-net does not currently operate a funded bug bounty program. Reports
that meet the criteria above receive public credit in the security
advisory (unless you prefer to remain anonymous) and, at maintainer
discretion, may be highlighted as a recognized contribution. If a funded
bounty program launches in the future, this document will be updated with
its scope and reward table.

## Acknowledgments

We will list researchers who report valid vulnerabilities here (with
permission) once the first reports are received and resolved.
