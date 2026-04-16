-- Migration 001: add full-pipeline fields
-- Run each statement individually in D1 Console, or:
--   npx wrangler d1 execute job-search-db --remote --file=src/db/migrations/001_pipeline.sql

ALTER TABLE resumes ADD COLUMN analysis TEXT;
ALTER TABLE resumes ADD COLUMN career_identities TEXT DEFAULT '[]';
ALTER TABLE resumes ADD COLUMN target_titles TEXT DEFAULT '[]';
ALTER TABLE resumes ADD COLUMN processing_status TEXT DEFAULT 'idle';
ALTER TABLE resumes ADD COLUMN processing_error TEXT;

ALTER TABLE jobs ADD COLUMN lane TEXT;
ALTER TABLE jobs ADD COLUMN resume_id INTEGER REFERENCES resumes(id);
ALTER TABLE jobs ADD COLUMN semantic_score REAL;

ALTER TABLE applications ADD COLUMN tailored_resume TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_lane ON jobs(lane);
CREATE INDEX IF NOT EXISTS idx_jobs_resume_id ON jobs(resume_id);
CREATE INDEX IF NOT EXISTS idx_resumes_status ON resumes(processing_status);
