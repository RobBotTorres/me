import { Env, Resume, ExternalJob, ResumeDiagnosis, JobLane } from '../types';
import {
  diagnoseResume,
  rerankJobs,
  getEmbedding,
  getEmbeddingsBatch,
  cosineSimilarity,
  extractJobSkills,
} from './ai';
import { searchJobs } from './jobs';

// How many jobs to fetch, semantically pre-filter, and LLM-rerank.
const JOBS_PER_QUERY = 15;
const MAX_QUERIES = 6;
const SEMANTIC_TOP_N = 30;
const RERANK_BATCH_SIZE = 8;

/**
 * Full resume pipeline:
 *  1. Diagnose resume (STEP 1-5)
 *  2. Save diagnosis + embedding
 *  3. Search job boards using target_titles
 *  4. Embed jobs, semantic pre-filter to top N
 *  5. LLM rerank with lane assignment
 *  6. Save ranked jobs with lane + reasoning
 */
export async function runFullPipeline(env: Env, resumeId: number): Promise<void> {
  const updateStatus = async (status: string, error?: string) => {
    await env.DB.prepare(
      `UPDATE resumes SET processing_status = ?, processing_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(status, error || null, resumeId).run();
  };

  try {
    const resume = await env.DB.prepare('SELECT * FROM resumes WHERE id = ?')
      .bind(resumeId).first<Resume>();
    if (!resume) throw new Error('Resume not found');

    // STEP 1: Diagnose + embed in parallel
    await updateStatus('diagnosing');
    const [diagnosis, embedding] = await Promise.all([
      diagnoseResume(env.AI, resume.raw_text),
      getEmbedding(env.AI, resume.raw_text),
    ]);

    await env.DB.prepare(`
      UPDATE resumes SET
        skills = ?, experience_years = ?, summary = ?,
        analysis = ?, career_identities = ?, target_titles = ?,
        embedding = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      JSON.stringify(diagnosis.skills),
      diagnosis.experience_years,
      diagnosis.summary,
      JSON.stringify(diagnosis),
      JSON.stringify(diagnosis.identities),
      JSON.stringify(diagnosis.target_titles),
      JSON.stringify(embedding),
      resumeId
    ).run();

    // STEP 2: Search using target_titles
    await updateStatus('searching');
    const queries = diagnosis.target_titles.slice(0, MAX_QUERIES);
    if (queries.length === 0) {
      await updateStatus('complete');
      return;
    }

    const searchPromises = queries.map((q) =>
      searchJobs({
        query: q,
        rapidApiKey: env.RAPIDAPI_KEY,
        adzunaAppId: env.ADZUNA_APP_ID,
        adzunaAppKey: env.ADZUNA_APP_KEY,
      })
    );
    const searchResults = await Promise.all(searchPromises);
    const allJobs = dedupeJobs(searchResults.flat()).slice(0, JOBS_PER_QUERY * queries.length);

    if (allJobs.length === 0) {
      await updateStatus('complete');
      return;
    }

    // STEP 3: Semantic pre-filter
    await updateStatus('ranking');
    const jobTexts = allJobs.map((j) => `${j.title} at ${j.company}\n${j.description}`);
    const jobEmbeddings = await embedInBatches(env, jobTexts);

    const scored = allJobs.map((job, i) => ({
      job,
      embedding: jobEmbeddings[i],
      semantic: cosineSimilarity(embedding, jobEmbeddings[i]),
    }));
    scored.sort((a, b) => b.semantic - a.semantic);
    const topSemantic = scored.slice(0, SEMANTIC_TOP_N);

    // STEP 4: LLM rerank in batches
    const rankedJobs: {
      job: ExternalJob;
      embedding: number[];
      semantic: number;
      score: number;
      lane: JobLane;
      reasoning: string;
    }[] = [];

    for (let i = 0; i < topSemantic.length; i += RERANK_BATCH_SIZE) {
      const batch = topSemantic.slice(i, i + RERANK_BATCH_SIZE);
      try {
        const results = await rerankJobs(
          env.AI,
          diagnosis,
          resume.raw_text,
          batch.map((b) => ({
            title: b.job.title,
            company: b.job.company,
            description: b.job.description,
          }))
        );
        for (const r of results) {
          const src = batch[r.job_index];
          if (!src) continue;
          rankedJobs.push({
            ...src,
            score: r.score,
            lane: r.lane,
            reasoning: r.reasoning,
          });
        }
      } catch {
        // If rerank fails for a batch, fall back to semantic score
        for (const b of batch) {
          rankedJobs.push({
            ...b,
            score: Math.round(b.semantic * 100),
            lane: 'domain_relevant',
            reasoning: 'Ranked by semantic similarity (LLM rerank failed).',
          });
        }
      }
    }

    // STEP 5: Store jobs. Delete previous results tied to this resume EXCEPT
    // those that have an application attached (preserves the user's tracker).
    await env.DB.prepare(`
      DELETE FROM jobs
      WHERE resume_id = ?
        AND id NOT IN (SELECT job_id FROM applications)
    `).bind(resumeId).run();

    for (const r of rankedJobs) {
      try {
        // Skip if we already have this external_id (e.g. preserved via application)
        const existing = r.job.external_id
          ? await env.DB.prepare('SELECT id FROM jobs WHERE external_id = ?')
              .bind(r.job.external_id).first<{ id: number }>()
          : null;

        if (existing) {
          // Update scores/lane in place so a saved job gets fresh ranking info too
          await env.DB.prepare(`
            UPDATE jobs SET match_score = ?, match_explanation = ?,
              semantic_score = ?, lane = ?, resume_id = ?
            WHERE id = ?
          `).bind(r.score, r.reasoning, r.semantic, r.lane, resumeId, existing.id).run();
          continue;
        }

        const skills = await extractJobSkills(env.AI, r.job.description).catch(() => []);
        await env.DB.prepare(`
          INSERT INTO jobs (external_id, title, company, location, description, url,
            salary_min, salary_max, job_type, remote, source, skills_required,
            embedding, match_score, match_explanation, semantic_score, lane,
            resume_id, posted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          r.job.external_id || null,
          r.job.title,
          r.job.company,
          r.job.location || null,
          r.job.description,
          r.job.url,
          r.job.salary_min ?? null,
          r.job.salary_max ?? null,
          r.job.job_type || 'full-time',
          r.job.remote ? 1 : 0,
          r.job.source,
          JSON.stringify(skills),
          JSON.stringify(r.embedding),
          r.score,
          r.reasoning,
          r.semantic,
          r.lane,
          resumeId,
          r.job.posted_at || null
        ).run();
      } catch {
        // skip duplicates / DB errors
      }
    }

    await updateStatus('complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateStatus('error', msg);
  }
}

function dedupeJobs(jobs: ExternalJob[]): ExternalJob[] {
  const seen = new Set<string>();
  const out: ExternalJob[] = [];
  for (const j of jobs) {
    const key = j.external_id || `${j.title}::${j.company}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

async function embedInBatches(env: Env, texts: string[]): Promise<number[][]> {
  const BATCH = 16;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const embeddings = await getEmbeddingsBatch(env.AI, batch);
    out.push(...embeddings);
  }
  return out;
}

/**
 * Rerun search/rank against an existing resume (reuses stored diagnosis).
 */
export async function rematchResume(env: Env, resumeId: number): Promise<void> {
  await runFullPipeline(env, resumeId);
}
