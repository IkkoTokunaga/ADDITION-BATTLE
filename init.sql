-- Create scores table
CREATE TABLE IF NOT EXISTS scores (
    id SERIAL PRIMARY KEY,
    player_id VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    score INTEGER NOT NULL,
    stage INTEGER NOT NULL,
    mode VARCHAR(16) NOT NULL DEFAULT 'normal',
    result_hash VARCHAR(64) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migration for existing deployments: add the dedup key column if missing.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS result_hash VARCHAR(64);
-- Migration for existing deployments: add the game-mode column. Rows recorded
-- before blank mode shipped default to 'normal'.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'normal';
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'scores_result_hash_key'
    ) THEN
        ALTER TABLE scores ADD CONSTRAINT scores_result_hash_key UNIQUE (result_hash);
    END IF;
END $$;

-- Create question_logs table
CREATE TABLE IF NOT EXISTS question_logs (
    id SERIAL PRIMARY KEY,
    score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
    num1 INTEGER NOT NULL,
    num2 INTEGER NOT NULL,
    user_answer INTEGER NOT NULL,
    is_correct BOOLEAN NOT NULL,
    time_taken REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for ranking queries, partitioned by mode (separate normal/blank boards).
-- Drop the pre-blank-mode index so existing deployments pick up the new shape.
DROP INDEX IF EXISTS idx_scores_ranking;
CREATE INDEX IF NOT EXISTS idx_scores_ranking ON scores (mode, score DESC, stage DESC);
