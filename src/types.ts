export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  PIPELINE: Workflow;
  RAPIDAPI_KEY?: string;
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
  JOOBLE_API_KEY?: string;
  FINDWORK_API_KEY?: string;
}

export interface PipelineEvent {
  id: number;
  resume_id: number;
  step_key: string;
  step_label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  current_count: number;
  total_count: number | null;
  message: string | null;
  started_at: string;
  updated_at: string;
}

export interface Resume {
  id: number;
  name: string;
  raw_text: string;
  skills: string;
  experience_years: number | null;
  summary: string | null;
  embedding: string | null;
  analysis: string | null;
  career_identities: string;
  target_titles: string;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
}

export type ProcessingStatus =
  | 'idle'
  | 'extracting'
  | 'diagnosing'
  | 'searching'
  | 'ranking'
  | 'complete'
  | 'error';

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
  semantic_score: number | null;
  lane: JobLane | null;
  resume_id: number | null;
  posted_at: string | null;
  created_at: string;
}

export type JobLane = 'fast_income' | 'domain_relevant' | 'aspirational';

export interface Application {
  id: number;
  job_id: number;
  resume_id: number | null;
  status: string;
  cover_letter: string | null;
  tailored_resume: string | null;
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

// --- AI output shapes ---

export interface CareerIdentity {
  label: string;
  strength: 'strong_on_paper' | 'strong_in_scope' | 'mixed';
  evidence: string[];
  liability_notes?: string;
}

export interface ResumeDiagnosis {
  identities: CareerIdentity[];
  target_titles: string[];
  keywords: string[];
  lanes: {
    fast_income: LaneRecommendation;
    domain_relevant: LaneRecommendation;
    aspirational: LaneRecommendation;
  };
  gaps: {
    fixable_30d: string[];
    fixable_60_90d: string[];
    structural: string[];
  };
  ranked_angles: SearchAngle[];
  honest_notes: string;
  skills: string[];
  experience_years: number;
  summary: string;
}

export interface LaneRecommendation {
  description: string;
  target_companies_or_types: string[];
  realistic_timeline?: string;
}

export interface SearchAngle {
  title: string;
  company_type: string;
  lane: JobLane;
  why_it_fits: string;
  top_5: boolean;
}

export interface JobRerankResult {
  job_index: number;
  score: number;
  lane: JobLane;
  reasoning: string;
}
