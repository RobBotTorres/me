-- Migration 008: watched companies for direct ATS feed polling

CREATE TABLE IF NOT EXISTS watched_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  ats TEXT NOT NULL,           -- 'greenhouse' | 'lever' | 'ashby'
  label TEXT,                  -- display name (e.g. 'Anthropic')
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_watched_slug_ats ON watched_companies(slug, ats);
