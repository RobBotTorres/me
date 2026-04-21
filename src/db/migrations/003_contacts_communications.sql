-- Migration 003: application contacts + communications log

CREATE TABLE IF NOT EXISTS application_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,           -- recruiter | hiring_manager | interviewer | referral | other
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
  direction TEXT NOT NULL,   -- 'sent' | 'received'
  channel TEXT NOT NULL,     -- 'email' | 'phone' | 'linkedin' | 'in_person' | 'other'
  summary TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  next_action TEXT,
  next_action_due TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_app ON application_contacts(application_id);
CREATE INDEX IF NOT EXISTS idx_communications_app ON application_communications(application_id);
CREATE INDEX IF NOT EXISTS idx_communications_due ON application_communications(next_action_due);
