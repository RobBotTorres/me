export interface Env {
  DB: D1Database;
  AI: Ai;
  RAPIDAPI_KEY?: string;
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
}

export interface Resume {
  id: number;
  name: string;
  raw_text: string;
  skills: string;
  experience_years: number | null;
  summary: string | null;
  embedding: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: number;
  external_id: string | null;
  title: string;
  company: string;
  location: string | null;
  description: string | null;
  url: string | null;
  salary_min: number | null;
  salary_max: number | null;
  job_type: string;
  remote: number;
  source: string | null;
  skills_required: string;
  embedding: string | null;
  match_score: number | null;
  match_explanation: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface Application {
  id: number;
  job_id: number;
  resume_id: number | null;
  status: string;
  cover_letter: string | null;
  notes: string | null;
  applied_at: string | null;
  interview_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchPreference {
  id: number;
  name: string;
  keywords: string;
  locations: string;
  min_salary: number | null;
  max_salary: number | null;
  remote_only: number;
  job_type: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SearchRun {
  id: number;
  preference_id: number | null;
  jobs_found: number;
  status: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

// External job board API response types
export interface ExternalJob {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  salary_min?: number;
  salary_max?: number;
  job_type?: string;
  remote?: boolean;
  source: string;
  external_id?: string;
  posted_at?: string;
}

export interface AIAnalysis {
  skills: string[];
  experience_years: number;
  summary: string;
}

export interface MatchResult {
  score: number;
  explanation: string;
  skills_matched: string[];
  skills_missing: string[];
}
