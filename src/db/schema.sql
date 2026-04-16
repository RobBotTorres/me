CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  skills TEXT DEFAULT '[]',
  experience_years INTEGER,
  summary TEXT,
  embedding TEXT,
  analysis TEXT,
  career_identities TEXT DEFAULT '[]',
  target_titles TEXT DEFAULT '[]',
  processing_status TEXT DEFAULT 'idle',
  processing_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

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
  job_type TEXT DEFAULT 'full-time',
  remote INTEGER DEFAULT 0,
  source TEXT,
  skills_required TEXT DEFAULT '[]',
  embedding TEXT,
  match_score REAL,
  match_explanation TEXT,
  semantic_score REAL,
  lane TEXT,
  resume_id INTEGER REFERENCES resumes(id),
  posted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id INTEGER REFERENCES resumes(id),
  status TEXT DEFAULT 'saved',
  cover_letter TEXT,
  tailored_resume TEXT,
  notes TEXT,
  applied_at TEXT,
  interview_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'Default',
  keywords TEXT DEFAULT '[]',
  locations TEXT DEFAULT '[]',
  min_salary INTEGER,
  max_salary INTEGER,
  remote_only INTEGER DEFAULT 0,
  job_type TEXT DEFAULT 'full-time',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preference_id INTEGER REFERENCES search_preferences(id),
  jobs_found INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_match_score ON jobs(match_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_lane ON jobs(lane);
CREATE INDEX IF NOT EXISTS idx_jobs_resume_id ON jobs(resume_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_resumes_status ON resumes(processing_status);
