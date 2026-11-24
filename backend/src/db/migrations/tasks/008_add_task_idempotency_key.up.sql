ALTER TABLE tasks ADD COLUMN idempotencyKey TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_wallet_idempotency
ON tasks (walletPublicKey, idempotencyKey);
