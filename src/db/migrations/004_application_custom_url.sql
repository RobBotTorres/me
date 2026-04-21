-- Migration 004: add custom URL column to applications

ALTER TABLE applications ADD COLUMN custom_url TEXT;
