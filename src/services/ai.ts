import {
  ResumeDiagnosis,
  JobRerankResult,
  JobLane,
  ExternalJob,
} from '../types';

// Workers AI models
const TEXT_MODEL = '@cf/moonshotai/kimi-k2.6' as const;
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

export async function diagnoseResume(
  ai: Ai,
  resumeText: string,
  profileContext?: string
): Promise<ResumeDiagnosis> {
  // When profile context is present, treat its data as authoritative.
  // Use its target_titles, lane definitions, exclusions verbatim.
  const sysPrompt = profileContext
    ? `${DIAGNOSE_SYSTEM}

=== AUTHORITATIVE CANDIDATE PROFILE ===
The candidate has provided a structured context document below. Treat its data as ground truth.
- For "target_titles": use the candidate's explicit list verbatim. Do not invent new ones.
- For "lanes": use the candidate's lane definitions (especially Lane 1 staffing, Lane 2 domain-relevant, Lane 3 aspirational warm-intro-only).
- For "skills": prefer skills listed in the candidate's TECHNICAL STACK section.
- Hard exclusions are non-negotiable - reflect them in the diagnosis.
- Voice and tone for any text fields: direct, low-key, no corporate enthusiasm. No "passionate", "thrilled", "excited". No em dashes.

CANDIDATE CONTEXT:
${profileContext.slice(0, 12000)}`
    : DIAGNOSE_SYSTEM;

  return runJson<ResumeDiagnosis>(
    ai,
    sysPrompt,
    `MATERIALS (resume, portfolio, LinkedIn — call out contradictions):\n\n${resumeText.slice(0, 10000)}`,
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
  jobs: { title: string; company: string; description: string }[],
  profileContext?: string
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

  const sysPrompt = profileContext
    ? `${RERANK_SYSTEM}

=== AUTHORITATIVE CANDIDATE PROFILE ===
Apply these rules strictly when scoring:

HARD EXCLUSIONS (score 0, lane "stretch", reasoning="Excluded by candidate constraints: <reason>"):
- Roles requiring relocation
- 100% sales quota roles (BDR, AE, full-cycle sales)
- Pure design roles
- Junior IC roles where scope would be a step backward
- Industries: defense, surveillance, gambling, predatory fintech, fossil fuel, MLM
- Pure individual-contributor engineering roles
- Pure people-management roles disconnected from the work

LANE TAGGING (use the candidate's exact definitions):
- fast_income: contract / staffing / agency placements (TEKsystems, Robert Half, Insight Global types). W2 contract, contract-to-hire, FTE placements via staffing.
- lateral: domain-relevant where candidate's wine/CPG/DTC/e-commerce background is an asset. Includes Commerce7, WineDirect, Tock, Corksy, Shopify Plus partners, Klaviyo, Recharge, Yotpo, CPG, DTC brands with substantial e-commerce ops.
- stretch: aspirational mission-driven tech (Anthropic, Figma, Mozilla, Stripe, Etsy, Patagonia, Dr. Bronner's). Score these only if there's a clear signal the role fits; warm-intro reality should be reflected in the reasoning.

RED FLAGS (downgrade score by 15-25):
- "Wear many hats" without commensurate scope/comp
- Vague title with no leveling
- "Rockstar"/"ninja" language
- "Fast-paced" with no PTO floor mentioned
- Visible recent layoffs or mass exits

GREEN FLAGS (boost score by 10-20):
- Mission alignment (AI access, creative economy tools, sustainability, ethical tech, open source, B-corp/worker-owned)
- "Bridging business and technical" or "translating between teams"
- Remote-first with documented async culture
- Clear leveling and comp transparency
- Customer-facing technical roles at infrastructure / dev tools companies
- TPM / implementation roles at SaaS companies whose customers are DTC brands

LOCATION HARD CONSTRAINT: Oakland, CA. Remote OR commutable Bay Area only. Anything requiring relocation = excluded.

REASONING REQUIREMENTS:
- Cite specific JD details, not generic praise
- If excluded, name the exact reason
- If lane=stretch and there's no obvious warm-intro path, note "warm-intro-gated" in reasoning

CANDIDATE CONTEXT (for additional details):
${profileContext.slice(0, 8000)}`
    : RERANK_SYSTEM;

  const result = await runJson<{ results: JobRerankResultExt[] }>(
    ai,
    sysPrompt,
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
- Stating years of experience not present in source

=== FEW-SHOT EXAMPLES ===

# Example 1: Summary repositioning

Source: "Technical operations leader with 12 years of experience. Managed e-commerce platforms for wine industry brands. Expertise in full-stack development, project management, and platform integrations."

→ Tailored for "Senior Technical Program Manager" (SaaS):
"Operations leader with 12 years driving cross-functional platform initiatives. Led multi-stakeholder e-commerce implementations at scale, coordinating engineering, product, and business teams through complex integrations. Specialized in technical program management where domain knowledge meets execution."

→ Tailored for "Director of E-commerce Operations" (DTC):
"E-commerce operations leader with 12 years running production platforms for consumer brands. Deep DTC expertise with full ownership of tech stack decisions, team leadership, and day-to-day platform operations. Wine industry background brings category-specific operational insight."

Both use only source facts. Different angle and keywords. Same honest story.

# Example 2: Bullet transformation

Source: "Led migration from legacy platform to Shopify Plus; reduced checkout abandonment by 22% and site load time by 1.8s"

→ For "Technical Program Manager":
"Led platform migration to Shopify Plus, managing scope, timeline, and cross-functional handoffs across engineering, ops, and marketing. Shipped with measurable outcomes: 22% drop in checkout abandonment, 1.8s load time improvement."

→ For "Technical Operations Manager":
"Architected and executed migration from legacy platform to Shopify Plus. Drove 22% reduction in checkout abandonment and 1.8s improvement in load time through targeted technical interventions."

→ For "Solutions Engineer":
"Designed and implemented end-to-end platform migration to Shopify Plus, evaluating tradeoffs across performance, integrations, and cost. Delivered 22% checkout conversion lift and 1.8s load time reduction."

Same work, different voice. PM = coordination. TechOps = execution. SE = solution design.

# Example 3: Skills reordering

Source: "JavaScript, PHP, Cloudflare Workers, AWS, React, Shopify, API Integration, GA4, Looker Studio, Postman"

→ For "Technical Program Manager - E-commerce":
"Shopify, API Integration, AWS, Cloudflare Workers, JavaScript, React, GA4, Looker Studio, PHP, Postman"

→ For "Senior Full-Stack Developer":
"JavaScript, React, PHP, AWS, Cloudflare Workers, API Integration, Shopify, Postman, GA4, Looker Studio"

Reorder by the job's priorities. Nothing added, nothing removed.

# Example 4: Gap handling (critical)

Job requires: Python, Kubernetes, Go. Source has: JavaScript, Node.js, Docker, AWS.

WRONG (fabrication): "Skills: JavaScript, Node.js, Docker, AWS, Python, Kubernetes"
WRONG (corporate filler): "Seeking to leverage Node.js background while expanding into Python"
RIGHT: Lead with Node.js, Docker, AWS prominently. Do not mention Python, Kubernetes, or Go. Let the reader evaluate.

If multiple critical gaps exist, include hidden comment at top: <!-- GAP: Python/Kubernetes/Go not in source; match weak -->

# Example 5: Anti-patterns — never write these

"Highly passionate technical operations leader" — drop "highly passionate"
"Results-driven team player with a go-getter attitude" — all filler
"Eager to leverage synergies in a dynamic environment" — corporate nonsense
"Led team of 15" when source says "team" — inventing scale
"Reduced costs by 30%" when source has no metric — inventing numbers
"Expert in Kubernetes" when source doesn't mention it — fabrication
"Proficient in modern JavaScript frameworks" — prefer specific names from source

# Example 6: Industry pivot framing (wine/CPG → tech)

WRONG (hides the pivot):
"Technical program manager with 12 years managing platforms at scale..."
(Buries industry context, credibility claims feel thin)

WRONG (leads with wine too hard for tech):
"Passionate wine industry veteran bringing 12 years of DTC commerce expertise..."
(Telegraphs 'not really tech' in line 1)

RIGHT (lets the pivot breathe):
"Technical operations leader with 12 years managing production e-commerce platforms. Background includes DTC wine commerce — a category-specific crash course in complex integrations (compliance, tax, shipping, fulfillment) that translates directly to any multi-layer SaaS implementation."
(Tech identity first. Industry as a differentiated asset, not an apology.)

Non-tech background = asset (domain complexity) or omitted where neutral. Never a liability.`;

export async function generateTailoredResume(
  ai: Ai,
  resumeText: string,
  jobTitle: string,
  company: string,
  jobDescription: string,
  profileContext?: string
): Promise<string> {
  const sys = profileContext
    ? `${TAILORED_RESUME_GUIDE}

=== CANDIDATE-SPECIFIC RULES (override generic rules where they conflict) ===
The candidate has provided voice/style rules and verified accomplishments. Treat these as authoritative.
- Use ONLY accomplishments from the candidate's "KEY ACCOMPLISHMENTS" section if present in the context.
- Voice: direct, low-key, no corporate enthusiasm. No "passionate", "thrilled", "excited to", "I'd love the chance to". No apologetic framing. No "I know this is a long shot". No hedging. No em dashes (use periods, commas, colons, parentheses). Short sentences when possible.
- Output format: markdown (.md). Never PDF or DOCX.
- Do not soften attribution. If "one of four leads", say "one of four leads", not "led".

CANDIDATE CONTEXT:
${profileContext.slice(0, 10000)}`
    : TAILORED_RESUME_GUIDE;

  const response = await ai.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `SOURCE RESUME (do not fabricate beyond this):
${resumeText}

---

TARGET JOB: ${jobTitle} at ${company}

JOB DESCRIPTION:
${jobDescription.slice(0, 3500)}

Output the tailored markdown resume now. No preamble.`,
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
  jobDescription: string,
  profileContext?: string
): Promise<string> {
  const baseRules = `Write a concise cover letter. Under 250 words. Direct tone. No corporate enthusiasm language ("passionate", "excited", "thrilled", "I'd love the chance to"). No apologetic framing. No "I know this is a long shot". No em dashes (use periods, commas, colons, parentheses). Short sentences. Plainly confident, not boastful, not self-deprecating. Only claim facts present in the resume. Cite specific JD details, not generic praise.`;

  const sys = profileContext
    ? `${baseRules}

=== CANDIDATE CONTEXT (authoritative) ===
Use ONLY accomplishments from the candidate's "KEY ACCOMPLISHMENTS" section. Do not soften attribution (if "one of four leads", say so). Output should sound like the candidate's voice as described in their context document.

${profileContext.slice(0, 8000)}`
    : baseRules;

  const response = await ai.run(TEXT_MODEL, {
    messages: [
      { role: 'system', content: sys },
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
