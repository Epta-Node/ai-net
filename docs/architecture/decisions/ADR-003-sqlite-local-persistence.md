# ADR-003: SQLite over PostgreSQL for Local Persistence

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** @Epta-Node/core

## Context

ai-net's backend needs a relational database for tasks, agents, and audit
events. The immediate candidates were PostgreSQL and SQLite.

Key constraints:
- **Zero infrastructure for contributors**: a `git clone` + `npm install`
  should result in a runnable system with no external services.
- **ACID transactions**: task status transitions must be atomic.
- **Scalability**: the initial deployment model is single-node; horizontal
  scaling is a future concern.

## Decision

Use **SQLite** (via the `better-sqlite3` driver) for all persistent backend
state. The database file path is configurable via `DATABASE_URL` in `.env`.

SQLite was chosen over PostgreSQL because:
1. **Zero setup**: SQLite requires no daemon, no Docker service, no credentials
   — the database is a single file that `better-sqlite3` creates automatically.
2. **Full ACID support**: SQLite's WAL mode provides concurrent readers and
   serialised writers, which is sufficient for a single-node deployment.
3. **Embedded testing**: tests use an in-memory SQLite database (`:memory:`)
   with no teardown required, keeping unit and integration tests fast and
   hermetic.
4. **Contributor experience**: PostgreSQL requires either a local install or
   Docker; SQLite reduces the onboarding friction to zero.

The trade-off accepted is that horizontal scaling would require migrating to a
client/server database. This is explicitly deferred; see Consequences.

## Consequences

**Positive:**
- New contributors can run the full stack with `npm run dev` after a single
  `.env` copy — no additional services.
- Test suite is fully hermetic; no database cleanup between test runs.
- Backup is a file copy.

**Negative / trade-offs:**
- SQLite's single-writer serialisation becomes a bottleneck under high
  concurrent write loads (e.g. many agents submitting results simultaneously).
- Migrating to PostgreSQL in a multi-node deployment will require schema
  migration tooling and connection-pool configuration.
- Some PostgreSQL-specific features (LISTEN/NOTIFY, JSONB operators) are not
  available; workarounds are in place in the ORM layer.
