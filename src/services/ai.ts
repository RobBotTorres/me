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

// --- STEP 1-6 Resume Diagnosis ---

const DIAGNOSE_SYSTEM = `You are helping someone run a comprehensive job search. They have multiple documents that may contradict each other. Push back where they're vague. Never use corporate language ("passionate", "thrilled", "excited"). Only make claims tied to evidence in their materials.

They're flip-flopping between career identities. Your job: collapse that ambiguity into a single coherent positioning.

Output STRICT JSON. Be direct. Fit within token budget.

Schema:
{
  "actual_work": {
    "plain_language": "What they actually DO, in plain English. 2-3 sentences. Ignore titles.",
    "problem_solved": "What specific problem they solve for a company. Concrete.",
    "contradictions": ["Specific contradiction 1 between their documents", "..."]
  },
  "positioning": {
    "closest_to_truth": "Of the identities they've been signaling, which one actually matches the work. Cite evidence.",
    "strategic_repositioning": "Which identity is them reaching/repositioning (vs. what they've actually done).",
    "outdated": "Which identity no longer fits and should be retired.",
    "coherent_statement": "2-3 sentence positioning statement they can use everywhere. Broad enough to cover tech-forward AND e-commerce roles without being two different people."
  },
  "titles": [
    {
      "title": "exact job-board-searchable title",
      "company_type": "Specific: stage + size + industry adjacency (e.g. 'Series B-D DTC brands, 50-500 ppl, CPG-adjacent')",
      "difficulty": "safe | moderate | stretch",
      "lead_with_ecommerce": true
    }
  ],
  "lanes": {
    "fast_income": {
      "description": "Contract/staffing where industry background is a direct asset.",
      "examples": ["e.g. wine industry consultancy, DTC agencies"],
      "probability": "high | medium | low",
      "timeline": "e.g. '2-4 weeks to first contract'"
    },
    "lateral": {
      "description": "Tech-adjacent where industry experience is a feature (CPG tech, DTC platforms, commerce SaaS, wine-tech, vertical SaaS).",
      "examples": ["..."],
      "probability": "high | medium | low",
      "timeline": "e.g. '2-3 months with effort'"
    },
    "stretch": {
      "description": "Pure tech where they need warm referrals + sharper story.",
      "examples": ["..."],
      "probability": "high | medium | low",
      "timeline": "e.g. '6-12 months, referral-gated'"
    }
  },
  "kidding_yourself": {
    "likely_wrong_about": ["specific assumption they're probably wrong about"],
    "value_miscalibration": "where they're over- or under-valuing themselves. Be specific.",
    "chasing_wrong_fits": ["role types they're chasing that don't fit"],
    "ignoring_good_fits": ["role types they should target but are ignoring"]
  },
  "ranked_angles": [
    {
      "title": "specific title",
      "company_type": "specific company profile",
      "lane": "fast_income | lateral | stretch",
      "why_it_fits": "evidence-tied reason",
      "top_5": true
    }
  ],
  "research_list": ["companies or sectors to research further"],
  "target_titles": ["8-12 real searchable titles - SAME as titles[].title, for job board queries"],
  "skills": ["concrete skills from materials"],
  "experience_years": 0,
  "summary": "positioning.coherent_statement (repeated here for compat)"
}

Rules:
- 8-12 titles (mix of safe/moderate/stretch)
- 10-15 ranked_angles with top 5 flagged top_5:true
- Every claim must trace to something in the materials
- Where materials disagree, name it - don't average them
- No corporate enthusiasm language`;

export async function diagnoseResume(ai: Ai, resumeText: string): Promise<ResumeDiagnosis> {
  return runJson<ResumeDiagnosis>(
    ai,
    DIAGNOSE_SYSTEM,
    `MATERIALS (may include resume, portfolio, LinkedIn - call out contradictions):\n\n${resumeText.slice(0, 10000)}`,
    3500
  );
}

// --- Job Reranking with Lane Classification ---

const RERANK_SYSTEM = `You are a job-match strategist. You see a candidate's full diagnosis and a batch of jobs. Score each job 0-100 for fit, assign a lane, give one-sentence reasoning tied to evidence, and extract 3-7 key skills from the job description.

Lanes:
- fast_income: contract/agency/quick-onboarding role the candidate can realistically land in weeks
- lateral: tech-adjacent role where industry experience is a feature (CPG tech, DTC platforms, commerce SaaS, vertical SaaS)
- stretch: pure tech / stretch role, likely needs warm referral to land

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
    positioning: diagnosis.positioning?.coherent_statement || diagnosis.summary,
    closest_to_truth: diagnosis.positioning?.closest_to_truth,
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
// Guide mirrored from docs/resume-tailoring-guide.md — edit both when changing.

const TAILORED_RESUME_GUIDE = `You are tailoring a resume for a specific job. Follow these rules precisely.

PRIME DIRECTIVE: Do not fabricate. Never invent experience, metrics, tools, employers, titles, dates, degrees, certifications, or skills. If a job requires something the source resume doesn't have, omit gracefully — do not claim it.

WHAT YOU CAN DO:
- Reorder bullets within a role, skills within a section
- Re-emphasize: move relevant experience higher, cut irrelevant bullets
- Rephrase: use the job's terminology if source describes the same thing differently
- Tighten: shorter is better, cut filler, use strong verbs
- Tailor the summary: rewrite 2-3 sentence professional summary using facts from source, angled toward this job
- Match keywords: if job says "Kubernetes" and source says "K8s", use "Kubernetes" — same concept

WHAT YOU CANNOT DO:
- Add a skill, tool, or responsibility not already in source
- Change dates, titles, company names, employment periods
- Invent metrics or scope ("led team of 12" when source says "led team")
- Claim certifications, degrees, or languages not listed
- Invent quantitative achievements or project names

TONE:
- Active voice, past tense for completed work, present tense for current role
- Start bullets with strong verbs (led, shipped, reduced, architected, implemented)
- NO corporate filler: no "passionate", "thrilled", "excited", "results-driven", "team player", "go-getter", "dynamic", "synergy"

STRUCTURE (in this order):
1. Name + contact — copy verbatim from source
2. Professional Summary — 2-3 sentences, tailored to this job's language, facts from source only
3. Skills — reorder by relevance to this job; remove irrelevant skills (don't add new ones)
4. Experience — per role: keep title/company/dates unchanged; reorder bullets by relevance; cut bullets that don't support this job; rephrase using job's terminology where applicable
5. Education / Certifications — unchanged
6. Projects — only if present in source

ATS:
- Match exact phrasing of required skills where source supports it
- No graphics, tables, columns, icons — plain text only
- Use standard section headers (Experience, Skills, Education)
- Spell out acronyms on first use if job description does

HANDLING GAPS:
- Don't claim it. Don't relabel adjacent experience.
- Don't mention it ("eager to learn X" is corporate filler — avoid).
- Lean into adjacent strengths and let the reader make the leap.

OUTPUT:
- Plain text only. No markdown, no JSON, no bullet characters other than "-".
- Ready to paste into a form field.
- No preamble ("Here is your tailored resume:") and no trailing commentary.
- ~450-550 words of actual resume content.

AVOID:
- Cramming keywords unnaturally
- Using job description verbatim for responsibilities (sounds fake)
- Rewriting bullets from scratch (you're tailoring, not drafting)
- Removing numbers or specific nouns (those are credibility anchors)
- Adding "Why I'm a fit" (that's a cover letter)
- Stating years of experience not present in source`;

export async function generateTailoredResume(
  ai: Ai,
  resumeText: string,
  jobTitle: string,
  company: string,
  jobDescription: string
): Promise<string> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: TAILORED_RESUME_GUIDE },
      {
        role: 'user',
        content: `SOURCE RESUME (do not fabricate beyond this):
${resumeText}

---

TARGET JOB: ${jobTitle} at ${company}

JOB DESCRIPTION:
${jobDescription.slice(0, 3500)}

Output the tailored plain-text resume now. No preamble.`,
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
  if (s === 'fast_income' || s === 'lateral' || s === 'stretch') return s;
  // Back-compat with old lane names
  if (s === 'domain_relevant') return 'lateral';
  if (s === 'aspirational') return 'stretch';
  return null;
}

export function asExternalJobs(raw: unknown[]): ExternalJob[] {
  return raw as ExternalJob[];
}
