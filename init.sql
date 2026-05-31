-- Create scores table
CREATE TABLE IF NOT EXISTS scores (
    id SERIAL PRIMARY KEY,
    player_id VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    score INTEGER NOT NULL,
    stage INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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

-- Index for ranking queries (by score desc, stage desc)
CREATE INDEX IF NOT EXISTS idx_scores_ranking ON scores (score DESC, stage DESC);
