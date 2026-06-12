-- Migration 009: warm paths, outreach plans, parsed profile

ALTER TABLE candidate_profile ADD COLUMN parsed_json TEXT;
ALTER TABLE applications ADD COLUMN outreach_plan TEXT;
ALTER TABLE jobs ADD COLUMN warm_path TEXT;
