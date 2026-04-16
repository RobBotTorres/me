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

// Tuning knobs (constrained by Cloudflare's subrequest limit: 50 free / 1000 paid per step)
const MAX_QUERIES = 4;
const JOBS_PER_QUERY = 30;
const LLM_RANKED_COUNT = 50;
const SEMANTIC_ONLY_COUNT = 70;
const RERANK_BATCH_SIZE = 15;
const EMBED_BATCH = 40;             // bigger batch = fewer subrequests

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

    // Force a suspension so the next step gets a fresh subrequest budget
    await step.sleep('pause-before-search', '1 second');

    // --- Step 2: Search boards, one step per query (each = fresh invocation) ---
    await emitEvent(db, resumeId, 'search', 'running', { total: queries.length });

    const perQueryResults: ExternalJob[][] = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const result = await step.do(
        `search-query-${i}`,
        { retries: { limit: 2, delay: '3 seconds' }, timeout: '1 minute' },
        async () =>
          searchJobs({
            query: q,
            usaOnly: true,
            rapidApiKey: this.env.RAPIDAPI_KEY,
            adzunaAppId: this.env.ADZUNA_APP_ID,
            adzunaAppKey: this.env.ADZUNA_APP_KEY,
            joobleApiKey: this.env.JOOBLE_API_KEY,
            findworkApiKey: this.env.FINDWORK_API_KEY,
          })
      );
      perQueryResults.push(result);
      await emitEvent(db, resumeId, 'search', 'running', {
        current: i + 1,
        total: queries.length,
      });
    }

    const flat = perQueryResults.flat();
    const allJobs = dedupeJobs(flat).slice(0, JOBS_PER_QUERY * queries.length);

    // Per-source tally
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
      current: allJobs.length,
      total: queries.length,
      message: `${allJobs.length} unique (${flat.length} raw) — ${breakdown}`,
    });

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

    // Another suspension → fresh subrequest budget for embed
    await step.sleep('pause-before-embed', '1 second');

    // --- Step 3: Embed jobs (resilient per-batch; one bad batch doesn't kill step) ---
    const scored = await step.do(
      'embed-jobs',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '5 minutes' },
      async () => {
        await emitEvent(db, resumeId, 'embed_jobs', 'running', { current: 0, total: allJobs.length });

        // Build texts, truncate aggressively to avoid payload errors
        const jobTexts = allJobs.map((j) =>
          `${j.title} at ${j.company}\n${(j.description || '').slice(0, 1500)}`
        );

        // Track successes; skip failed batches rather than aborting
        const embeddingsMap = new Map<number, number[]>();
        let failedBatches = 0;
        let lastError = '';

        for (let i = 0; i < jobTexts.length; i += EMBED_BATCH) {
          const slice = jobTexts.slice(i, i + EMBED_BATCH);
          try {
            const part = await getEmbeddingsBatch(this.env.AI, slice);
            for (let k = 0; k < part.length; k++) {
              embeddingsMap.set(i + k, part[k]);
            }
          } catch (err) {
            failedBatches++;
            lastError = err instanceof Error ? err.message : String(err);
          }
          // Only emit event every few batches to conserve subrequests
          if (i === 0 || i + EMBED_BATCH >= jobTexts.length || i % (EMBED_BATCH * 2) === 0) {
            await emitEvent(db, resumeId, 'embed_jobs', 'running', {
              current: Math.min(i + EMBED_BATCH, jobTexts.length),
              total: jobTexts.length,
              message: failedBatches > 0 ? `${failedBatches} batches failed so far` : undefined,
            });
          }
        }

        const scored = allJobs
          .map((job, i) => {
            const emb = embeddingsMap.get(i);
            if (!emb) return null;
            return { job, embedding: emb, semantic: cosineSimilarity(resumeEmbedding, emb) };
          })
          .filter((x): x is { job: ExternalJob; embedding: number[]; semantic: number } => x !== null);

        if (scored.length === 0) {
          throw new Error(`All ${jobTexts.length} embedding batches failed. Last error: ${lastError || 'unknown'}`);
        }

        scored.sort((a, b) => b.semantic - a.semantic);
        const totalKept = LLM_RANKED_COUNT + SEMANTIC_ONLY_COUNT;
        await emitEvent(db, resumeId, 'embed_jobs', 'completed', {
          current: scored.length, total: allJobs.length,
          message: `Embedded ${scored.length}/${allJobs.length}${failedBatches ? `, ${failedBatches} batches failed` : ''}; top ${Math.min(totalKept, scored.length)} kept`,
        });
        return scored.slice(0, totalKept);
      }
    );

    // --- Step 4: Hybrid ranking ---
    // Top LLM_RANKED_COUNT get full LLM rerank (lane + reasoning)
    // Next SEMANTIC_ONLY_COUNT get semantic-only scores (fast, no LLM)
    type RankedJob = {
      job: ExternalJob; embedding: number[]; semantic: number;
      score: number; lane: JobLane | null; reasoning: string; skills: string[];
    };

    await step.sleep('pause-before-rerank', '1 second');

    const topForLLM = scored.slice(0, LLM_RANKED_COUNT);
    const semanticOnly = scored.slice(LLM_RANKED_COUNT);

    const totalBatches = Math.ceil(topForLLM.length / RERANK_BATCH_SIZE);
    await emitEvent(db, resumeId, 'rerank', 'running', { current: 0, total: topForLLM.length });

    const rankedJobs: RankedJob[] = [];
    for (let b = 0; b < totalBatches; b++) {
      const start = b * RERANK_BATCH_SIZE;
      const batch = topForLLM.slice(start, start + RERANK_BATCH_SIZE);

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
      // Only emit event every other batch to save subrequests
      if (b % 2 === 1 || b === totalBatches - 1) {
        await emitEvent(db, resumeId, 'rerank', 'running', {
          current: Math.min((b + 1) * RERANK_BATCH_SIZE, topForLLM.length),
          total: topForLLM.length,
        });
      }
    }

    // Append semantic-only tier (no LLM cost)
    for (const s of semanticOnly) {
      rankedJobs.push({
        ...s,
        score: Math.round(s.semantic * 100),
        lane: null,
        reasoning: 'Matched by semantic similarity (not LLM-reviewed).',
        skills: [],
      });
    }

    await emitEvent(db, resumeId, 'rerank', 'completed', {
      current: rankedJobs.length, total: rankedJobs.length,
      message: `${topForLLM.length} ranked by LLM, ${semanticOnly.length} by semantic`,
    });

    await step.sleep('pause-before-save', '1 second');

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
