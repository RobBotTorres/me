-- AI Job Search Agent - D1 Schema

-- User resume profiles
CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  skills TEXT DEFAULT '[]',           -- JSON array of extracted skills
  experience_years INTEGER,
  summary TEXT,                        -- AI-generated summary
  embedding TEXT,                      -- JSON array (vector embedding)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Job listings from various sources
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  description TEXT,
  url TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  job_type TEXT DEFAULT 'full-time',   -- full-time, part-time, contract, internship
  remote INTEGER DEFAULT 0,
  source TEXT,                          -- job board source
  skills_required TEXT DEFAULT '[]',    -- JSON array
  embedding TEXT,                       -- JSON array (vector embedding)
  match_score REAL,                     -- AI-computed match score (0-100)
  match_explanation TEXT,               -- AI explanation of match
  posted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Application tracking
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER REFERENCES resumes(id),
  status TEXT DEFAULT 'saved',          -- saved, applied, screening, interview, offer, rejected, withdrawn
  cover_letter TEXT,                    -- AI-generated cover letter
  notes TEXT,
  applied_at TEXT,
  interview_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Search preferences / saved searches
CREATE TABLE IF NOT EXISTS search_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'Default',
  keywords TEXT DEFAULT '[]',           -- JSON array
  locations TEXT DEFAULT '[]',          -- JSON array
  min_salary INTEGER,
  max_salary INTEGER,
  remote_only INTEGER DEFAULT 0,
  job_type TEXT DEFAULT 'full-time',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Search run history
CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preference_id INTEGER REFERENCES search_preferences(id),
  jobs_found INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',        -- pending, running, completed, failed
  error TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_match_score ON jobs(match_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id);
