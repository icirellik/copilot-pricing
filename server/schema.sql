-- One row per (league, handle, date) with that day's total AIC.
-- Today/week/all-time boards are SUMs over these day rows.
CREATE TABLE IF NOT EXISTS entries (
  league     TEXT NOT NULL,
  handle     TEXT NOT NULL,
  date       TEXT NOT NULL,            -- YYYY-MM-DD, publisher-local, opaque
  total_aic  REAL NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (league, handle, date)
);

-- Speeds up the league+date range scans used by the leaderboard queries.
CREATE INDEX IF NOT EXISTS idx_entries_league_date ON entries(league, date);
