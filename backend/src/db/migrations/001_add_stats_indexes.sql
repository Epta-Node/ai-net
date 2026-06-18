-- Add indexes to speed up dashboard and analytics queries
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks ("createdAt");
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
