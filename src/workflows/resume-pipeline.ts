import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import { Env, Resume, ExternalJob, JobLane } from '../types';
import {
  diagnoseResume,
  rerankJobs,
  getEmbedding,
  getEmbeddingsBatch,
  cosineSimilarity,
} from '../services/ai';
import { searchJobs } from '../services/jobs';

export type ResumePipelineParams = { resumeId: number };

// Tuning knobs
const MAX_QUERIES = 6;
const JOBS_PER_QUERY = 15;
const SEMANTIC_TOP_N = 24;
const RERANK_BATCH_SIZE = 12;

const STEPS = {
  diagnose: 'Diagnose resume',
  search: 'Search job boards',
  embed_jobs: 'Embed job listings',
  rerank: 'Rank and classify',
  save: 'Save results',
} as const;

type StepKey = keyof typeof STEPS;

async function emitEvent(
  db: D1Database,
  resumeId: number,
  stepKey: StepKey,
  status: 'pending' | 'running' | 'completed' | 'failed',
  opts: { current?: number; total?: number; message?: string } = {}
) {
  const label = STEPS[stepKey];
  const existing = await db
    .prepare('SELECT id FROM pipeline_events WHERE resume_id = ? AND step_key = ?')
    .bind(resumeId, stepKey).first<{ id: number }>();

  if (existing) {
    await db.prepare(
      `UPDATE pipeline_events SET status = ?, current_count = COALESCE(?, current_count),
         total_count = COALESCE(?, total_count), message = COALESCE(?, message),
         updated_at = datetime('now') WHERE id = ?`
    ).bind(
      status,
      opts.current ?? null,
      opts.total ?? null,
      opts.message ?? null,
      existing.id
    ).run();
  } else {
    await db.prepare(
      `INSERT INTO pipeline_events (resume_id, step_key, step_label, status, current_count, total_count, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      resumeId, stepKey, label, status,
      opts.current ?? 0,
      opts.total ?? null,
      opts.message ?? null
    ).run();
  }
}

export class ResumePipeline extends WorkflowEntrypoint<Env, ResumePipelineParams> {
  async run(event: WorkflowEvent<ResumePipelineParams>, step: WorkflowStep) {
    const { resumeId } = event.payload;
    const db = this.env.DB;

    // Clear previous events for a clean display
    await db.prepare('DELETE FROM pipeline_events WHERE resume_id = ?').bind(resumeId).run();

    // Seed pending rows so the UI shows the full pipeline upfront
    for (const key of Object.keys(STEPS) as StepKey[]) {
      await emitEvent(db, resumeId, key, 'pending');
    }

    const resume = await step.do('load-resume', async () => {
      const row = await db.prepare('SELECT * FROM resumes WHERE id = ?')
        .bind(resumeId).first<Resume>();
      if (!row) throw new Error('Resume not found');
      return row;
    });

    await db.prepare(
      `UPDATE resumes SET processing_status = 'diagnosing', processing_error = NULL,
         updated_at = datetime('now') WHERE id = ?`
    ).bind(resumeId).run();

    // --- Step 1: Diagnose + embed (parallel inside the step) ---
    const diagnoseResult = await step.do(
      'diagnose',
      { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
      async () => {
        await emitEvent(db, resumeId, 'diagnose', 'running');
        try {
          const [diagnosis, embedding] = await Promise.all([
            diagnoseResume(this.env.AI, resume.raw_text),
            getEmbedding(this.env.AI, resume.raw_text),
          ]);
          await db.prepare(`
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
          await emitEvent(db, resumeId, 'diagnose', 'completed', {
            message: `${diagnosis.identities?.length || 0} identities, ${diagnosis.target_titles?.length || 0} target titles`,
          });
          return { diagnosis, embedding };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emitEvent(db, resumeId, 'diagnose', 'failed', { message: msg });
          throw err;
        }
      }
    );

    const { diagnosis, embedding: resumeEmbedding } = diagnoseResult;
    const queries = diagnosis.target_titles.slice(0, MAX_QUERIES);
    if (queries.length === 0) {
      await this.finish(resumeId);
      return;
    }

    await db.prepare(
      `UPDATE resumes SET processing_status = 'searching', updated_at = datetime('now') WHERE id = ?`
    ).bind(resumeId).run();

    // --- Step 2: Search boards ---
    const allJobs = await step.do(
      'search-boards',
      { retries: { limit: 2, delay: '5 seconds' }, timeout: '2 minutes' },
      async () => {
        await emitEvent(db, resumeId, 'search', 'running', { total: queries.length });
        const searchResults = await Promise.all(
          queries.map((q) =>
            searchJobs({
              query: q,
              rapidApiKey: this.env.RAPIDAPI_KEY,
              adzunaAppId: this.env.ADZUNA_APP_ID,
              adzunaAppKey: this.env.ADZUNA_APP_KEY,
            })
          )
        );
        const deduped = dedupeJobs(searchResults.flat()).slice(0, JOBS_PER_QUERY * queries.length);
        await emitEvent(db, resumeId, 'search', 'completed', {
          current: deduped.length,
          total: queries.length,
          message: `${deduped.length} unique jobs from ${queries.length} queries`,
        });
        return deduped;
      }
    );

    if (allJobs.length === 0) {
      await emitEvent(db, resumeId, 'embed_jobs', 'completed', { message: 'No jobs found' });
      await emitEvent(db, resumeId, 'rerank', 'completed', { message: 'No jobs to rank' });
      await emitEvent(db, resumeId, 'save', 'completed', { message: 'Nothing to save' });
      await this.finish(resumeId);
      return;
    }

    await db.prepare(
      `UPDATE resumes SET processing_status = 'ranking', updated_at = datetime('now') WHERE id = ?`
    ).bind(resumeId).run();

    // --- Step 3: Embed jobs ---
    const scored = await step.do(
      'embed-jobs',
      { retries: { limit: 2, delay: '5 seconds' }, timeout: '3 minutes' },
      async () => {
        await emitEvent(db, resumeId, 'embed_jobs', 'running', { current: 0, total: allJobs.length });
        const jobTexts = allJobs.map((j) => `${j.title} at ${j.company}\n${j.description}`);
        const jobEmbeddings: number[][] = [];
        const BATCH = 16;
        for (let i = 0; i < jobTexts.length; i += BATCH) {
          const part = await getEmbeddingsBatch(this.env.AI, jobTexts.slice(i, i + BATCH));
          jobEmbeddings.push(...part);
          await emitEvent(db, resumeId, 'embed_jobs', 'running', {
            current: Math.min(i + BATCH, jobTexts.length),
            total: jobTexts.length,
          });
        }
        const out = allJobs.map((job, i) => ({
          job, embedding: jobEmbeddings[i],
          semantic: cosineSimilarity(resumeEmbedding, jobEmbeddings[i]),
        }));
        out.sort((a, b) => b.semantic - a.semantic);
        await emitEvent(db, resumeId, 'embed_jobs', 'completed', {
          current: out.length, total: out.length,
          message: `Embedded ${out.length}, top ${Math.min(SEMANTIC_TOP_N, out.length)} selected`,
        });
        return out.slice(0, SEMANTIC_TOP_N);
      }
    );

    // --- Step 4: Rerank in batches (each batch is its own step → durable, retryable) ---
    type RankedJob = {
      job: ExternalJob; embedding: number[]; semantic: number;
      score: number; lane: JobLane; reasoning: string; skills: string[];
    };

    const totalBatches = Math.ceil(scored.length / RERANK_BATCH_SIZE);
    await emitEvent(db, resumeId, 'rerank', 'running', { current: 0, total: scored.length });

    const rankedJobs: RankedJob[] = [];
    for (let b = 0; b < totalBatches; b++) {
      const start = b * RERANK_BATCH_SIZE;
      const batch = scored.slice(start, start + RERANK_BATCH_SIZE);

      const batchRanked = await step.do(
        `rerank-batch-${b}`,
        { retries: { limit: 2, delay: '5 seconds' }, timeout: '3 minutes' },
        async (): Promise<RankedJob[]> => {
          try {
            const results = await rerankJobs(
              this.env.AI, diagnosis, resume.raw_text,
              batch.map((x) => ({
                title: x.job.title, company: x.job.company, description: x.job.description,
              }))
            );
            return results
              .map((r): RankedJob | null => {
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
              .filter((x): x is RankedJob => x !== null);
          } catch {
            return batch.map((x) => ({
              ...x,
              score: Math.round(x.semantic * 100),
              lane: 'domain_relevant' as JobLane,
              reasoning: 'Fallback score from semantic similarity.',
              skills: [],
            }));
          }
        }
      );

      rankedJobs.push(...batchRanked);
      await emitEvent(db, resumeId, 'rerank', 'running', {
        current: Math.min((b + 1) * RERANK_BATCH_SIZE, scored.length),
        total: scored.length,
      });
    }
    await emitEvent(db, resumeId, 'rerank', 'completed', {
      current: rankedJobs.length, total: rankedJobs.length,
      message: `Ranked ${rankedJobs.length} jobs`,
    });

    // --- Step 5: Save to D1 ---
    await step.do(
      'save',
      { retries: { limit: 3, delay: '2 seconds' }, timeout: '1 minute' },
      async () => {
        await emitEvent(db, resumeId, 'save', 'running');

        await db.prepare(`
          DELETE FROM jobs
          WHERE resume_id = ?
            AND id NOT IN (SELECT job_id FROM applications)
        `).bind(resumeId).run();

        const externalIds = rankedJobs
          .map((r) => r.job.external_id)
          .filter((id): id is string => !!id);

        const existingMap = new Map<string, number>();
        if (externalIds.length > 0) {
          const CHUNK = 50;
          for (let i = 0; i < externalIds.length; i += CHUNK) {
            const chunk = externalIds.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = await db
              .prepare(`SELECT id, external_id FROM jobs WHERE external_id IN (${placeholders})`)
              .bind(...chunk).all<{ id: number; external_id: string }>();
            for (const row of rows.results || []) existingMap.set(row.external_id, row.id);
          }
        }

        const stmts: D1PreparedStatement[] = [];
        for (const r of rankedJobs) {
          const existingId = r.job.external_id ? existingMap.get(r.job.external_id) : undefined;
          if (existingId) {
            stmts.push(
              db.prepare(`
                UPDATE jobs SET match_score = ?, match_explanation = ?,
                  semantic_score = ?, lane = ?, resume_id = ?, skills_required = ?
                WHERE id = ?
              `).bind(r.score, r.reasoning, r.semantic, r.lane, resumeId,
                JSON.stringify(r.skills), existingId)
            );
          } else {
            stmts.push(
              db.prepare(`
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
        if (stmts.length > 0) await db.batch(stmts);

        await emitEvent(db, resumeId, 'save', 'completed', {
          current: stmts.length, total: stmts.length,
          message: `Saved ${stmts.length} jobs`,
        });
      }
    );

    await this.finish(resumeId);
  }

  private async finish(resumeId: number) {
    await this.env.DB.prepare(
      `UPDATE resumes SET processing_status = 'complete', processing_error = NULL,
         updated_at = datetime('now') WHERE id = ?`
    ).bind(resumeId).run();
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
