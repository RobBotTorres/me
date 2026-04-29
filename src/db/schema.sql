CREATE TABLE IF NOT EXISTS candidate_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  context TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

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
  workflow_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_resume_step ON pipeline_events(resume_id, step_key);

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
  custom_url TEXT,
  applied_at TEXT,
  interview_at TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS application_status_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_changes_app
  ON application_status_changes(application_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS application_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  linkedin TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS application_communications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES application_contacts(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  summary TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  next_action TEXT,
  next_action_due TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_app ON application_contacts(application_id);
CREATE INDEX IF NOT EXISTS idx_communications_app ON application_communications(application_id);
CREATE INDEX IF NOT EXISTS idx_communications_due ON application_communications(next_action_due);

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
