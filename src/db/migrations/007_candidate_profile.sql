-- Migration 007: candidate profile (singleton)
-- Stores the long-form candidate context that authoritatively guides the search:
-- target titles, lane definitions, exclusions, voice rules, network, etc.

CREATE TABLE IF NOT EXISTS candidate_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  context TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
