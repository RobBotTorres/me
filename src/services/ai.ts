import {
  ResumeDiagnosis,
  JobRerankResult,
  JobLane,
  ExternalJob,
} from '../types';

// Workers AI models
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as const;
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5' as const;

async function runJson<T>(ai: Ai, system: string, user: string, maxTokens = 3500): Promise<T> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  } as Parameters<Ai['run']>[1]);

  const text = (response as { response: string }).response;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in model response');
  return JSON.parse(jsonMatch[0]) as T;
}

// --- STEP 1-5 Resume Diagnosis ---

const DIAGNOSE_SYSTEM = `You are a brutally honest career strategist. A resume needs a comprehensive search plan. Your tone is direct, evidence-based, and never smooths over contradictions. You never use corporate enthusiasm language (no "passionate", "thrilled", "excited").

Output STRICT JSON matching this schema:
{
  "identities": [
    {
      "label": "string (e.g. 'technical PM', 'e-commerce ops lead')",
      "strength": "strong_on_paper | strong_in_scope | mixed",
      "evidence": ["specific project/metric/tool from resume"],
      "liability_notes": "string, optional - where this reading could screen out"
    }
  ],
  "target_titles": ["exact job-board-searchable titles, 8-15 of them across identities"],
  "keywords": ["ATS/recruiter search terms found in resume"],
  "lanes": {
    "fast_income": {
      "description": "contract/staffing/agency realities for this candidate",
      "target_companies_or_types": ["types or named agencies"],
      "realistic_timeline": "e.g. '2-4 weeks to first contract'"
    },
    "domain_relevant": {
      "description": "where industry background is an ASSET",
      "target_companies_or_types": ["specific company types"]
    },
    "aspirational": {
      "description": "stretch roles requiring warm referrals",
      "target_companies_or_types": ["named companies or types"]
    }
  },
  "gaps": {
    "fixable_30d": ["specific gaps fixable quickly"],
    "fixable_60_90d": ["medium-term gaps"],
    "structural": ["gaps that won't close without a pivot"]
  },
  "ranked_angles": [
    {
      "title": "specific job title",
      "company_type": "describe the company profile",
      "lane": "fast_income | domain_relevant | aspirational",
      "why_it_fits": "specific evidence-tied reason",
      "top_5": true
    }
  ],
  "honest_notes": "one paragraph of direct feedback - overqualified where, underqualified where, mis-qualified where",
  "skills": ["concrete skills from resume"],
  "experience_years": 0,
  "summary": "2-sentence summary, no fluff"
}

Rules:
- Only make claims you can tie to evidence in the resume.
- Be direct about weaknesses. The user can take it.
- Flag ambiguity instead of smoothing it over.
- ranked_angles should have 15-20 entries, with top 5 flagged top_5:true.
- target_titles must be real, searchable titles (what a recruiter types into LinkedIn).`;

export async function diagnoseResume(ai: Ai, resumeText: string): Promise<ResumeDiagnosis> {
  return runJson<ResumeDiagnosis>(
    ai,
    DIAGNOSE_SYSTEM,
    `RESUME:\n\n${resumeText}`,
    4096
  );
}

// --- Job Reranking with Lane Classification ---

const RERANK_SYSTEM = `You are a job-match strategist. You see a candidate's full diagnosis and a batch of jobs. Score each job 0-100 for fit, assign a lane, and give one-sentence reasoning tied to evidence.

Lanes:
- fast_income: contract/agency/quick-onboarding role the candidate can realistically land in weeks
- domain_relevant: candidate's background is an asset, not a handicap
- aspirational: stretch role, likely needs warm referral to land

Output STRICT JSON:
{
  "results": [
    { "job_index": 0, "score": 0-100, "lane": "fast_income|domain_relevant|aspirational", "reasoning": "one sentence" }
  ]
}

Rules:
- Be honest about low scores. Don't inflate.
- If the job description is too thin to judge, score it max 40.
- Reasoning must cite specific resume or job details.`;

export async function rerankJobs(
  ai: Ai,
  diagnosis: ResumeDiagnosis,
  resumeText: string,
  jobs: { title: string; company: string; description: string }[]
): Promise<JobRerankResult[]> {
  if (jobs.length === 0) return [];

  const diagSummary = {
    identities: diagnosis.identities.map((i) => i.label),
    target_titles: diagnosis.target_titles,
    skills: diagnosis.skills,
  };

  const jobBlocks = jobs
    .map(
      (j, i) =>
        `[${i}] ${j.title} @ ${j.company}\n${(j.description || '').slice(0, 800)}`
    )
    .join('\n\n---\n\n');

  const result = await runJson<{ results: JobRerankResult[] }>(
    ai,
    RERANK_SYSTEM,
    `CANDIDATE DIAGNOSIS:
${JSON.stringify(diagSummary, null, 2)}

RESUME EXCERPT:
${resumeText.slice(0, 1500)}

JOBS TO RANK:
${jobBlocks}`,
    3500
  );

  return result.results || [];
}

// --- Tailored Resume Generation ---

const TAILORED_RESUME_SYSTEM = `You tailor resumes for specific jobs. ABSOLUTE RULE: do NOT fabricate. Never invent experience, metrics, tools, employers, titles, or dates. Never add skills that aren't already present in the source resume. You may reorder, re-emphasize, rephrase, and cut bullets. You may adjust the professional summary to align with the job, but only using facts already present.

Output plain text only - no markdown, no JSON. Just a clean text resume ready to paste into a form.

Structure:
- Name + contact (copy verbatim from source)
- Professional Summary (2-3 sentences, tailored but factual)
- Skills (only skills present in source, prioritized by job relevance)
- Experience (reorder bullets within each role by job relevance; cut irrelevant bullets; keep all dates/titles/employers unchanged)
- Education (unchanged)

If the source resume is missing something the job requires, DO NOT add it. Just omit. The user will see gaps and decide themselves.`;

export async function generateTailoredResume(
  ai: Ai,
  resumeText: string,
  jobTitle: string,
  company: string,
  jobDescription: string
): Promise<string> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: TAILORED_RESUME_SYSTEM },
      {
        role: 'user',
        content: `SOURCE RESUME (do not fabricate beyond this):\n${resumeText}\n\n---\n\nTARGET JOB: ${jobTitle} at ${company}\n\nJOB DESCRIPTION:\n${jobDescription.slice(0, 3000)}`,
      },
    ],
    max_tokens: 2500,
  });
  return (response as { response: string }).response.trim();
}

// --- Cover Letter (kept from v1) ---

export async function generateCoverLetter(
  ai: Ai,
  resumeText: string,
  jobTitle: string,
  company: string,
  jobDescription: string
): Promise<string> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'Write a concise cover letter. Under 250 words. Direct tone. No corporate enthusiasm language ("passionate", "excited", "thrilled"). Only claim facts present in the resume. Specific references to the job description.',
      },
      {
        role: 'user',
        content: `RESUME:\n${resumeText}\n\nJOB: ${jobTitle} at ${company}\n\nDESCRIPTION:\n${jobDescription.slice(0, 2500)}`,
      },
    ],
    max_tokens: 800,
  });
  return (response as { response: string }).response.trim();
}

// --- Embeddings ---

export async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const truncated = text.slice(0, 2000);
  const response = await ai.run(EMBEDDING_MODEL, { text: [truncated] });
  return (response as { data: number[][] }).data[0];
}

export async function getEmbeddingsBatch(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const truncated = texts.map((t) => t.slice(0, 2000));
  const response = await ai.run(EMBEDDING_MODEL, { text: truncated });
  return (response as { data: number[][] }).data;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

// --- Helpers retained for job skill extraction ---

export async function extractJobSkills(ai: Ai, jobDescription: string): Promise<string[]> {
  try {
    const response = await ai.run(TEXT_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'Extract required technical and professional skills from this job posting. Return JSON {"skills": ["skill1", ...]}.',
        },
        { role: 'user', content: jobDescription.slice(0, 3000) },
      ],
      max_tokens: 400,
      response_format: { type: 'json_object' },
    } as Parameters<Ai['run']>[1]);
    const text = (response as { response: string }).response;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as { skills?: string[] };
    return parsed.skills || [];
  } catch {
    return [];
  }
}

export function laneFromString(s: string | null | undefined): JobLane | null {
  if (s === 'fast_income' || s === 'domain_relevant' || s === 'aspirational') return s;
  return null;
}

export function asExternalJobs(raw: unknown[]): ExternalJob[] {
  return raw as ExternalJob[];
}
