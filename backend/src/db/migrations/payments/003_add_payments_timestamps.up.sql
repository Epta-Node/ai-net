-- Issue #496 — record when an escrow was locked and when its status last changed.
--
-- The reconciliation service needs the escrow's age to decide whether a still
-- locked payment whose task has gone terminal is genuinely expired. Both columns
-- are nullable so rows written before this migration (and any in-flight write
-- from an older process) keep working; the service falls back to the owning
-- task's `updatedAt` when `createdAt` is NULL.
ALTER TABLE payments ADD COLUMN createdAt TEXT;
ALTER TABLE payments ADD COLUMN updatedAt TEXT;

-- Reconciliation remediation only ever acts on escrow that is still outstanding,
-- so the hot path is "every locked payment", not a status scan over history.
CREATE INDEX IF NOT EXISTS idx_payments_status_balanceId ON payments (status, balanceId);
