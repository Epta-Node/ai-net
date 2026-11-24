CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  prompt          TEXT NOT NULL,
  walletPublicKey TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'queued',
  dagJson         TEXT NOT NULL DEFAULT '[]',
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);
