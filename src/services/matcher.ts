import { Env, Resume, ExternalJob, JobLane } from '../types';
import {
  diagnoseResume,
  rerankJobs,
  getEmbedding,
  getEmbeddingsBatch,
  cosineSimilarity,
} from './ai';
import { searchJobs } from './jobs';

// Tuning knobs (optimized for speed)
const JOBS_PER_QUERY = 15;
const MAX_QUERIES = 6;
const SEMANTIC_TOP_N = 24;
const RERANK_BATCH_SIZE = 12;
const RERANK_CONCURRENCY = 3;

type RankedJob = {
  job: ExternalJob;
  embedding: number[];
  semantic: number;
  score: number;
  lane: JobLane;
  reasoning: string;
  skills: string[];
};

/**
 * Full resume pipeline:
 *  1. Diagnose resume (STEP 1-5) + embed resume (parallel)
 *  2. Search all boards using target_titles (parallel)
 *  3. Embed jobs, semantic pre-filter to top N
 *  4. LLM rerank in parallel batches (now includes skill extraction)
 *  5. Batch upsert to D1
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

    // STEP 1: Diagnose + embed (parallel)
    await updateStatus('diagnosing');
    const [diagnosis, resumeEmbedding] = await Promise.all([
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
      JSON.stringify(resumeEmbedding),
      resumeId
    ).run();

    // STEP 2: Search all boards for every target title (parallel)
    await updateStatus('searching');
    const queries = diagnosis.target_titles.slice(0, MAX_QUERIES);
    if (queries.length === 0) { await updateStatus('complete'); return; }

    const searchResults = await Promise.all(
      queries.map((q) =>
        searchJobs({
          query: q,
          rapidApiKey: env.RAPIDAPI_KEY,
          adzunaAppId: env.ADZUNA_APP_ID,
          adzunaAppKey: env.ADZUNA_APP_KEY,
        })
      )
    );
    const allJobs = dedupeJobs(searchResults.flat()).slice(0, JOBS_PER_QUERY * queries.length);

    if (allJobs.length === 0) { await updateStatus('complete'); return; }

    // STEP 3: Semantic pre-filter
    await updateStatus('ranking');
    const jobTexts = allJobs.map((j) => `${j.title} at ${j.company}\n${j.description}`);
    const jobEmbeddings = await embedInBatches(env, jobTexts);
    const scored = allJobs.map((job, i) => ({
      job, embedding: jobEmbeddings[i],
      semantic: cosineSimilarity(resumeEmbedding, jobEmbeddings[i]),
    }));
    scored.sort((a, b) => b.semantic - a.semantic);
    const topSemantic = scored.slice(0, SEMANTIC_TOP_N);

    // STEP 4: LLM rerank in parallel batches (with concurrency cap)
    const batches: typeof topSemantic[] = [];
    for (let i = 0; i < topSemantic.length; i += RERANK_BATCH_SIZE) {
      batches.push(topSemantic.slice(i, i + RERANK_BATCH_SIZE));
    }

    const rankedJobs: RankedJob[] = [];
    for (let i = 0; i < batches.length; i += RERANK_CONCURRENCY) {
      const chunk = batches.slice(i, i + RERANK_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (batch) => {
          try {
            const rerankResults = await rerankJobs(
              env.AI, diagnosis, resume.raw_text,
              batch.map((b) => ({
                title: b.job.title, company: b.job.company, description: b.job.description,
              }))
            );
            return rerankResults
              .map((r) => {
                const src = batch[r.job_index];
                if (!src) return null;
                return {
                  ...src,
                  score: r.score,
                  lane: r.lane,
                  reasoning: r.reasoning,
                  skills: r.skills || [],
                };
              })
              .filter(Boolean) as RankedJob[];
          } catch {
            return batch.map((b) => ({
              ...b,
              score: Math.round(b.semantic * 100),
              lane: 'domain_relevant' as JobLane,
              reasoning: 'Ranked by semantic similarity (rerank failed).',
              skills: [],
            }));
          }
        })
      );
      for (const batchResult of results) rankedJobs.push(...batchResult);
    }

    // STEP 5: Preserve application-linked jobs, then batch upsert fresh ones
    await env.DB.prepare(`
      DELETE FROM jobs
      WHERE resume_id = ?
        AND id NOT IN (SELECT job_id FROM applications)
    `).bind(resumeId).run();

    // Check which external_ids already exist (protected by applications)
    const externalIds = rankedJobs
      .map((r) => r.job.external_id)
      .filter((id): id is string => !!id);

    const existingMap = new Map<string, number>();
    if (externalIds.length > 0) {
      // D1 doesn't support IN (?) arrays natively with bind; chunk into groups
      const CHUNK = 50;
      for (let i = 0; i < externalIds.length; i += CHUNK) {
        const chunk = externalIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await env.DB
          .prepare(`SELECT id, external_id FROM jobs WHERE external_id IN (${placeholders})`)
          .bind(...chunk).all<{ id: number; external_id: string }>();
        for (const row of rows.results || []) existingMap.set(row.external_id, row.id);
      }
    }

    const inserts: D1PreparedStatement[] = [];
    for (const r of rankedJobs) {
      const existingId = r.job.external_id ? existingMap.get(r.job.external_id) : undefined;

      if (existingId) {
        inserts.push(
          env.DB.prepare(`
            UPDATE jobs SET match_score = ?, match_explanation = ?,
              semantic_score = ?, lane = ?, resume_id = ?,
              skills_required = ?
            WHERE id = ?
          `).bind(r.score, r.reasoning, r.semantic, r.lane, resumeId,
            JSON.stringify(r.skills), existingId)
        );
      } else {
        inserts.push(
          env.DB.prepare(`
            INSERT INTO jobs (external_id, title, company, location, description, url,
              salary_min, salary_max, job_type, remote, source, skills_required,
              embedding, match_score, match_explanation, semantic_score, lane,
              resume_id, posted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            r.job.external_id || null,
            r.job.title, r.job.company,
            r.job.location || null,
            r.job.description, r.job.url,
            r.job.salary_min ?? null, r.job.salary_max ?? null,
            r.job.job_type || 'full-time',
            r.job.remote ? 1 : 0,
            r.job.source,
            JSON.stringify(r.skills),
            JSON.stringify(r.embedding),
            r.score, r.reasoning, r.semantic, r.lane,
            resumeId,
            r.job.posted_at || null
          )
        );
      }
    }

    if (inserts.length > 0) await env.DB.batch(inserts);

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
    const embeddings = await getEmbeddingsBatch(env.AI, texts.slice(i, i + BATCH));
    out.push(...embeddings);
  }
  return out;
}

export async function rematchResume(env: Env, resumeId: number): Promise<void> {
  await runFullPipeline(env, resumeId);
}
