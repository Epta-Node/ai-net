ALTER TABLE agents ADD COLUMN reputation_score REAL NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN reputation_updated_at TIMESTAMP;

UPDATE agents SET reputation_score = reputationScore WHERE reputationScore IS NOT NULL;
