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

const DIAGNOSE_SYSTEM = `You are a brutally honest career strategist. Your tone is direct, evidence-based. Never use corporate enthusiasm language ("passionate", "thrilled", "excited").

Output COMPACT JSON. Be concise. No padding text outside the JSON.

Schema:
{
  "identities": [{"label":"...", "strength":"strong_on_paper|strong_in_scope|mixed", "evidence":["..."], "liability_notes":"..."}],
  "target_titles": ["..."],
  "lanes": {
    "fast_income": {"description":"...", "target_companies_or_types":["..."], "realistic_timeline":"..."},
    "domain_relevant": {"description":"...", "target_companies_or_types":["..."]},
    "aspirational": {"description":"...", "target_companies_or_types":["..."]}
  },
  "gaps": {"fixable_30d":["..."], "fixable_60_90d":["..."], "structural":["..."]},
  "ranked_angles": [{"title":"...", "company_type":"...", "lane":"...", "why_it_fits":"...", "top_5":true}],
  "honest_notes": "one paragraph",
  "skills": ["..."],
  "experience_years": 0,
  "summary": "2 sentences"
}

Constraints:
- 3-5 identities only
- 8-12 target_titles (real searchable titles)
- 10-12 ranked_angles total, with top 5 marked top_5:true
- Each evidence/note/why_it_fits: ONE sentence max
- Only claims tied to resume evidence`;

export async function diagnoseResume(ai: Ai, resumeText: string): Promise<ResumeDiagnosis> {
  return runJson<ResumeDiagnosis>(
    ai,
    DIAGNOSE_SYSTEM,
    `RESUME:\n\n${resumeText.slice(0, 8000)}`,
    2200
  );
}

// --- Job Reranking with Lane Classification ---

const RERANK_SYSTEM = `You are a job-match strategist. You see a candidate's full diagnosis and a batch of jobs. Score each job 0-100 for fit, assign a lane, give one-sentence reasoning tied to evidence, and extract 3-7 key skills from the job description.

Lanes:
- fast_income: contract/agency/quick-onboarding role the candidate can realistically land in weeks
- domain_relevant: candidate's background is an asset, not a handicap
- aspirational: stretch role, likely needs warm referral to land

Output STRICT JSON:
{
  "results": [
    { "job_index": 0, "score": 0-100, "lane": "fast_income|domain_relevant|aspirational", "reasoning": "one sentence", "skills": ["skill1", "skill2"] }
  ]
}

Rules:
- Be honest about low scores. Don't inflate.
- If the job description is too thin to judge, score it max 40.
- Reasoning must cite specific resume or job details.
- Skills: only pull what's actually in the job description. No guessing.`;

export interface JobRerankResultExt {
  job_index: number;
  score: number;
  lane: JobLane;
  reasoning: string;
  skills?: string[];
}

export async function rerankJobs(
  ai: Ai,
  diagnosis: ResumeDiagnosis,
  resumeText: string,
  jobs: { title: string; company: string; description: string }[]
): Promise<JobRerankResultExt[]> {
  if (jobs.length === 0) return [];

  const diagSummary = {
    identities: diagnosis.identities.map((i) => i.label),
    target_titles: diagnosis.target_titles,
    skills: diagnosis.skills,
  };

  const jobBlocks = jobs
    .map((j, i) => `[${i}] ${j.title} @ ${j.company}\n${(j.description || '').slice(0, 800)}`)
    .join('\n\n---\n\n');

  const result = await runJson<{ results: JobRerankResultExt[] }>(
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
