-- Migration 002: pipeline events table for granular progress tracking

CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  current_count INTEGER DEFAULT 0,
  total_count INTEGER,
  message TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_resume ON pipeline_events(resume_id, id);

-- Unique constraint so we can UPSERT (single subrequest instead of SELECT+INSERT/UPDATE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_resume_step
  ON pipeline_events(resume_id, step_key);

-- Also track the active workflow instance id per resume
ALTER TABLE resumes ADD COLUMN workflow_id TEXT;
