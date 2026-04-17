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

// Tuning knobs. CF Workflows subrequest limit: 50 free / 10000 paid per instance.
// On paid, we can be generous - the old values were tuned for free-tier hard cap.
const MAX_QUERIES = 8;
const JOBS_PER_QUERY = 30;
const LLM_RANKED_COUNT = 60;
const SEMANTIC_ONLY_COUNT = 100;
const RERANK_BATCH_SIZE = 15;

const STEPS = {
  diagnose: 'Diagnose resume',
  search: 'Search job boards',
  embed_jobs: 'Embed job listings',
  rerank: 'Rank and classify',
  save: 'Save results',
} as const;

type StepKey = keyof typeof STEPS;

// emitEvent: no unique-index requirement. Costs 2 subrequests (SELECT + INSERT/UPDATE).
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
      `UPDATE pipeline_events SET status = ?,
         current_count = COALESCE(?, current_count),
         total_count = COALESCE(?, total_count),
         message = COALESCE(?, message),
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

    // ---- Setup (all D1 writes in one step → cached, no replay) ----
    const resume = await step.do('init-and-load', async () => {
      await db.prepare('DELETE FROM pipeline_events WHERE resume_id = ?').bind(resumeId).run();
      const seedStmts = (Object.keys(STEPS) as StepKey[]).map((key) =>
        db.prepare(
          `INSERT INTO pipeline_events (resume_id, step_key, step_label, status) VALUES (?, ?, ?, 'pending')`
        ).bind(resumeId, key, STEPS[key])
      );
      await db.batch(seedStmts);
      await db.prepare(
        `UPDATE resumes SET processing_status = 'diagnosing', processing_error = NULL,
           updated_at = datetime('now') WHERE id = ?`
      ).bind(resumeId).run();
      const row = await db.prepare('SELECT * FROM resumes WHERE id = ?')
        .bind(resumeId).first<Resume>();
      if (!row) throw new Error('Resume not found');
      return row;
    });

    // ---- Step 1: Diagnose ----
    const diagnoseResult = await step.do(
      'diagnose',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '5 minutes' },
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
            diagnosis.summary || diagnosis.positioning?.coherent_statement || '',
            JSON.stringify(diagnosis),
            JSON.stringify(diagnosis.titles || []),
            JSON.stringify(diagnosis.target_titles),
            JSON.stringify(embedding),
            resumeId
          ).run();
          await emitEvent(db, resumeId, 'diagnose', 'completed', {
            message: `${diagnosis.titles?.length || 0} titles, ${diagnosis.target_titles?.length || 0} target queries`,
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

    // ---- Step 2: Search (one step per query) ----
    const perQueryResults: ExternalJob[][] = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const result = await step.do(
        `search-query-${i}`,
        { retries: { limit: 1, delay: '3 seconds' }, timeout: '1 minute' },
        async () => {
          if (i === 0) {
            await db.prepare(
              `UPDATE resumes SET processing_status = 'searching', updated_at = datetime('now') WHERE id = ?`
            ).bind(resumeId).run();
            await emitEvent(db, resumeId, 'search', 'running', { total: queries.length });
          }
          const jobs = await searchJobs({
            query: q,
            usaOnly: true,
            rapidApiKey: this.env.RAPIDAPI_KEY,
            adzunaAppId: this.env.ADZUNA_APP_ID,
            adzunaAppKey: this.env.ADZUNA_APP_KEY,
            joobleApiKey: this.env.JOOBLE_API_KEY,
            findworkApiKey: this.env.FINDWORK_API_KEY,
          });
          await emitEvent(db, resumeId, 'search', 'running', { current: i + 1, total: queries.length });
          return jobs;
        }
      );
      perQueryResults.push(result);
    }

    // Aggregate search results
    const allJobs = await step.do('post-search-aggregate', async () => {
      const flat = perQueryResults.flat();
      const deduped = dedupeJobs(flat).slice(0, JOBS_PER_QUERY * queries.length);
      const bySource: Record<string, number> = {
        remotive: 0, arbeitnow: 0, remoteok: 0, themuse: 0, usajobs: 0,
        workingnomads: 0, jobicy: 0, hackernews: 0, adzuna: 0, jsearch: 0,
        jooble: 0, findwork: 0,
      };
      for (const j of flat) bySource[j.source] = (bySource[j.source] || 0) + 1;
      const breakdown = Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s}:${n}`).join(', ');
      await emitEvent(db, resumeId, 'search', 'completed', {
        current: deduped.length, total: queries.length,
        message: `${deduped.length} unique (${flat.length} raw) — ${breakdown}`,
      });
      await db.prepare(
        `UPDATE resumes SET processing_status = 'ranking', updated_at = datetime('now') WHERE id = ?`
      ).bind(resumeId).run();
      return deduped;
    });

    if (allJobs.length === 0) {
      await step.do('no-jobs-found', async () => {
        await emitEvent(db, resumeId, 'embed_jobs', 'completed', { message: 'No jobs found' });
        await emitEvent(db, resumeId, 'rerank', 'completed', { message: 'No jobs to rank' });
        await emitEvent(db, resumeId, 'save', 'completed', { message: 'Nothing to save' });
      });
      await this.finish(resumeId);
      return;
    }

    // ---- Step 3: Embed jobs (direct ai.run; these are Cloudflare subrequests not external) ----
    const jobTexts = allJobs.map((j) =>
      `${j.title} at ${j.company}\n${(j.description || '').slice(0, 1500)}`
    );

    const scored = await step.do(
      'embed-all',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '3 minutes' },
      async () => {
        await emitEvent(db, resumeId, 'embed_jobs', 'running', {
          current: 0, total: jobTexts.length,
        });
        // Workers AI bge-base supports ~100 texts per call.
        const BATCH = 90;
        const embeddings: number[][] = [];
        for (let i = 0; i < jobTexts.length; i += BATCH) {
          const part = await getEmbeddingsBatch(this.env.AI, jobTexts.slice(i, i + BATCH));
          embeddings.push(...part);
        }
        const scoredAll = allJobs
          .map((job, i) => {
            const emb = embeddings[i];
            if (!emb) return null;
            return { job, semantic: cosineSimilarity(resumeEmbedding, emb) };
          })
          .filter((x): x is { job: ExternalJob; semantic: number } => x !== null);
        scoredAll.sort((a, b) => b.semantic - a.semantic);
        const totalKept = LLM_RANKED_COUNT + SEMANTIC_ONLY_COUNT;
        await emitEvent(db, resumeId, 'embed_jobs', 'completed', {
          current: scoredAll.length, total: allJobs.length,
          message: `Embedded ${scoredAll.length}/${allJobs.length}; top ${Math.min(totalKept, scoredAll.length)} kept`,
        });
        // Return WITHOUT embeddings - they're too large for workflow step output (1 MiB cap).
        // Jobs saved without embedding vectors; can be re-embedded if needed.
        return scoredAll.slice(0, totalKept);
      }
    );

    // ---- Step 4: Rerank (direct ai.run, batched inside the step) ----
    type RankedJob = {
      job: ExternalJob; semantic: number;
      score: number; lane: JobLane | null; reasoning: string; skills: string[];
    };

    const topForLLM = scored.slice(0, LLM_RANKED_COUNT);
    const semanticOnly = scored.slice(LLM_RANKED_COUNT);

    const rankedJobs: RankedJob[] = await step.do(
      'rerank-all',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '5 minutes' },
      async (): Promise<RankedJob[]> => {
        await emitEvent(db, resumeId, 'rerank', 'running', { current: 0, total: topForLLM.length });

        const out: RankedJob[] = [];
        const totalBatches = Math.ceil(topForLLM.length / RERANK_BATCH_SIZE);
        for (let b = 0; b < totalBatches; b++) {
          const start = b * RERANK_BATCH_SIZE;
          const batch = topForLLM.slice(start, start + RERANK_BATCH_SIZE);
          try {
            const results = await rerankJobs(
              this.env.AI, diagnosis, resume.raw_text,
              batch.map((x) => ({
                title: x.job.title, company: x.job.company, description: x.job.description,
              }))
            );
            for (const r of results) {
              const src = batch[r.job_index];
              if (!src) continue;
              out.push({
                ...src,
                score: r.score,
                lane: r.lane,
                reasoning: r.reasoning,
                skills: r.skills || [],
              });
            }
          } catch {
            // Fallback: use semantic scores for this batch
            for (const x of batch) {
              out.push({
                ...x,
                score: Math.round(x.semantic * 100),
                lane: 'lateral',
                reasoning: 'Fallback score (batch rerank failed).',
                skills: [],
              });
            }
          }
        }

        // Append semantic-only tier
        for (const s of semanticOnly) {
          out.push({
            ...s,
            score: Math.round(s.semantic * 100),
            lane: null,
            reasoning: 'Matched by semantic similarity (not LLM-reviewed).',
            skills: [],
          });
        }

        await emitEvent(db, resumeId, 'rerank', 'completed', {
          current: out.length, total: out.length,
          message: `${topForLLM.length} LLM-ranked, ${semanticOnly.length} semantic-only`,
        });
        return out;
      }
    );

    // ---- Step 5: Save ----
    await step.do(
      'save',
      { retries: { limit: 3, delay: '2 seconds' }, timeout: '1 minute' },
      async () => {
        await emitEvent(db, resumeId, 'save', 'running');

        await db.prepare(`
          DELETE FROM jobs WHERE resume_id = ?
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
                null, // embedding not stored (too large to pass through workflow; can re-compute)
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
    if (!j || !j.title || !j.company) continue; // skip malformed
    const key = j.external_id || `${j.title}::${j.company}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}
