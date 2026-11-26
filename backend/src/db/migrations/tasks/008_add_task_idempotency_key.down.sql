DROP INDEX IF EXISTS idx_tasks_wallet_idempotency;
ALTER TABLE tasks DROP COLUMN idempotencyKey;
