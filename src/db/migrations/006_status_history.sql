-- Migration 006: track status change history per application

CREATE TABLE IF NOT EXISTS application_status_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_changes_app
  ON application_status_changes(application_id, changed_at DESC);
