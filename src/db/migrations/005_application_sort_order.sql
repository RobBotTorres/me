-- Migration 005: application sort order for manual reordering

ALTER TABLE applications ADD COLUMN sort_order INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_applications_sort ON applications(sort_order);
