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
  SELF_URL?: string;
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

export type JobLane = 'fast_income' | 'lateral' | 'stretch';

export interface ApplicationContact {
  id: number;
  application_id: number;
  name: string;
  role: string | null;       // recruiter | hiring_manager | interviewer | referral | other
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationCommunication {
  id: number;
  application_id: number;
  contact_id: number | null;
  direction: 'sent' | 'received';
  channel: 'email' | 'phone' | 'linkedin' | 'in_person' | 'other';
  summary: string | null;
  occurred_at: string;
  next_action: string | null;
  next_action_due: string | null;
  created_at: string;
}

export interface Application {
  id: number;
  job_id: number;
  resume_id: number | null;
  status: string;
  cover_letter: string | null;
  tailored_resume: string | null;
  notes: string | null;
  custom_url: string | null;
  applied_at: string | null;
  interview_at: string | null;
  sort_order: number;
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

export interface ResumeDiagnosis {
  actual_work: {
    plain_language: string;
    problem_solved: string;
    contradictions: string[];
  };
  positioning: {
    closest_to_truth: string;
    strategic_repositioning: string;
    outdated: string;
    coherent_statement: string;
  };
  titles: Array<{
    title: string;
    company_type: string;
    difficulty: 'safe' | 'moderate' | 'stretch';
    lead_with_ecommerce: boolean;
  }>;
  lanes: {
    fast_income: LaneDetail;
    lateral: LaneDetail;
    stretch: LaneDetail;
  };
  kidding_yourself: {
    likely_wrong_about: string[];
    value_miscalibration: string;
    chasing_wrong_fits: string[];
    ignoring_good_fits: string[];
  };
  ranked_angles: SearchAngle[];
  research_list: string[];
  target_titles: string[];
  skills: string[];
  experience_years: number;
  summary: string;
}

export interface LaneDetail {
  description: string;
  examples: string[];
  probability: 'high' | 'medium' | 'low';
  timeline: string;
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
