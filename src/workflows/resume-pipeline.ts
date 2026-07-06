import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from 'cloudflare:workers';
import { Env, Resume, ExternalJob, JobLane, ParsedProfile } from '../types';
import { findWarmPath } from '../services/warm';
import {
  diagnoseResume,
  rerankJobs,
  getEmbedding,
  getEmbeddingsBatch,
  cosineSimilarity,
} from '../services/ai';
import { searchJobs, fetchWatchedCompanyJobs } from '../services/jobs';

export type ResumePipelineParams = { resumeId: number };

// Tuning knobs. CF Workflows subrequest limit: 50 free / 10000 paid per instance.
const MAX_QUERIES = 10;          // profile lists 10 explicit titles - search them all
const MAX_CANDIDATES = 350;      // hard cap on deduped jobs entering embedding
const LLM_RANKED_COUNT = 60;
const SEMANTIC_ONLY_COUNT = 100;
const RERANK_BATCH_SIZE = 15;
const TITLE_MATCH_BOOST = 0.15;  // pre-rank boost when job title matches a target title

// Blend weights for the pre-rank: target-profile similarity dominates so we
// rank toward where the candidate is GOING, not just what their resume says.
const W_TARGET = 0.6;
const W_RESUME = 0.4;

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

    // Load candidate profile (singleton, optional). Drives target_titles, lanes, exclusions.
    const profileRow = await db.prepare('SELECT context, parsed_json FROM candidate_profile WHERE id = 1')
      .first<{ context: string; parsed_json: string | null }>();
    const profileContext = profileRow?.context || undefined;

    // Structured data extracted at profile-save time. Used deterministically:
    // explicit target titles become search queries verbatim (no LLM drift),
    // network contacts power warm-path tagging.
    let parsedProfile: ParsedProfile | null = null;
    if (profileRow?.parsed_json) {
      try { parsedProfile = JSON.parse(profileRow.parsed_json) as ParsedProfile; } catch { /* ignore */ }
    }

    // ---- Step 1: Diagnose ----
    const diagnoseResult = await step.do(
      'diagnose',
      { retries: { limit: 2, delay: '10 seconds' }, timeout: '5 minutes' },
      async () => {
        await emitEvent(db, resumeId, 'diagnose', 'running');
        try {
          const [diagnosis, embedding] = await Promise.all([
            diagnoseResume(this.env.AI, resume.raw_text, profileContext),
            getEmbedding(this.env.AI, resume.raw_text),
          ]);

          // Target embedding: represents the roles the candidate WANTS, not
          // just their history. Built from explicit titles + role thesis.
          // Without this, semantic ranking drags results toward past industry
          // (e.g. wine jobs for a wine-industry resume).
          const targetTitles = parsedProfile?.target_titles?.length
            ? parsedProfile.target_titles
            : diagnosis.target_titles || [];
          const targetText = [
            targetTitles.join('. '),
            parsedProfile?.role_thesis || diagnosis.positioning?.coherent_statement || '',
            `Skills: ${(diagnosis.skills || []).join(', ')}`,
          ].filter(Boolean).join('\n');
          const targetEmbedding = targetText.trim()
            ? await getEmbedding(this.env.AI, targetText)
            : null;
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
            message: `${targetTitles.length} target titles${parsedProfile?.target_titles?.length ? ' (from profile, verbatim)' : ' (LLM-derived)'}`,
          });
          return { diagnosis, embedding, targetEmbedding };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emitEvent(db, resumeId, 'diagnose', 'failed', { message: msg });
          throw err;
        }
      }
    );

    const { diagnosis, embedding: resumeEmbedding, targetEmbedding } = diagnoseResult;

    // Search queries: candidate's explicit titles from the parsed profile take
    // priority (verbatim, full list). LLM-derived titles only as fallback.
    const queries = (
      parsedProfile?.target_titles?.length
        ? parsedProfile.target_titles
        : diagnosis.target_titles || []
    ).slice(0, MAX_QUERIES);
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

    // Pull jobs from watched companies (direct ATS feeds).
    // These hit specific careers pages (Greenhouse / Lever / Ashby) — high signal
    // for Lane 3 stretch targets. Each company = one fetch.
    const watchedJobs = await step.do(
      'fetch-watched-companies',
      { retries: { limit: 1, delay: '5 seconds' }, timeout: '2 minutes' },
      async () => {
        const watched = await db.prepare(
          'SELECT slug, ats, label FROM watched_companies'
        ).all<{ slug: string; ats: string; label: string | null }>();
        const list = watched.results || [];
        if (list.length === 0) return [] as ExternalJob[];
        const fetched = await Promise.all(
          list.map((w) => fetchWatchedCompanyJobs(w.ats, w.slug, w.label || w.slug))
        );
        // Trim + cap so this step's output stays under the 1 MiB limit even
        // with many watched companies that have large boards.
        return fetched.flat().slice(0, 250).map((j) => ({
          ...j,
          description: (j.description || '').slice(0, 1500),
        }));
      }
    );
    if (watchedJobs.length > 0) perQueryResults.push(watchedJobs);

    // Aggregate search results
    const allJobs = await step.do('post-search-aggregate', async () => {
      const flat = perQueryResults.flat();
      const deduped = dedupeJobs(flat).slice(0, MAX_CANDIDATES);
      const bySource: Record<string, number> = {
        remotive: 0, arbeitnow: 0, remoteok: 0, themuse: 0, usajobs: 0,
        workingnomads: 0, jobicy: 0, hackernews: 0, weworkremotely: 0,
        adzuna: 0, jsearch: 0, jooble: 0, findwork: 0,
        greenhouse: 0, lever: 0, ashby: 0,
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
        // Pre-rank = blended similarity + title-match boost.
        // Target similarity (where they're GOING) outweighs resume similarity
        // (where they've BEEN). Jobs whose titles literally match a target
        // title get boosted so "Implementation Manager" can't be drowned out
        // by industry-adjacent noise.
        const targetTitlesNorm = (
          parsedProfile?.target_titles?.length
            ? parsedProfile.target_titles
            : diagnosis.target_titles || []
        ).map(normalizeTitle).filter(Boolean);

        const scoredAll = allJobs
          .map((job, i) => {
            const emb = embeddings[i];
            if (!emb) return null;
            const resumeSim = cosineSimilarity(resumeEmbedding, emb);
            const targetSim = targetEmbedding ? cosineSimilarity(targetEmbedding, emb) : null;
            let semantic = targetSim !== null
              ? W_TARGET * targetSim + W_RESUME * resumeSim
              : resumeSim;
            if (titleMatchesAny(job.title, targetTitlesNorm)) {
              semantic = Math.min(1, semantic + TITLE_MATCH_BOOST);
            }
            return { job, semantic };
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

    // ---- Step 4: Rerank, ONE BATCH PER STEP ----
    // Previously all 4 LLM calls ran inside a single 5-minute step. On slow
    // Workers AI days each call takes 60-180s, so the step blew its timeout
    // (observed: 12-minute rerank on 2026-06-25, WorkflowTimeoutError today).
    // Per-batch steps give every LLM call its own timeout + retries, and a
    // failed batch degrades to semantic scores instead of killing the run.
    type RankedJob = {
      job: ExternalJob; semantic: number;
      score: number; lane: JobLane | null; reasoning: string; skills: string[];
    };

    const topForLLM = scored.slice(0, LLM_RANKED_COUNT);
    const semanticOnly = scored.slice(LLM_RANKED_COUNT);
    const totalBatches = Math.ceil(topForLLM.length / RERANK_BATCH_SIZE);

    const rankedJobs: RankedJob[] = [];
    for (let b = 0; b < totalBatches; b++) {
      const start = b * RERANK_BATCH_SIZE;
      const batch = topForLLM.slice(start, start + RERANK_BATCH_SIZE);

      let batchRanked: RankedJob[];
      try {
        batchRanked = await step.do(
        `rerank-batch-${b}`,
        { retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '3 minutes' },
        async (): Promise<RankedJob[]> => {
          if (b === 0) {
            await emitEvent(db, resumeId, 'rerank', 'running', { current: 0, total: topForLLM.length });
          }
          try {
            const results = await rerankJobs(
              this.env.AI, diagnosis, resume.raw_text,
              batch.map((x) => ({
                title: x.job.title, company: x.job.company, description: x.job.description,
              })),
              profileContext
            );
            const out: RankedJob[] = [];
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
            await emitEvent(db, resumeId, 'rerank', 'running', {
              current: Math.min((b + 1) * RERANK_BATCH_SIZE, topForLLM.length),
              total: topForLLM.length,
            });
            return out;
          } catch {
            // Fallback: semantic scores for this batch only; run continues
            await emitEvent(db, resumeId, 'rerank', 'running', {
              current: Math.min((b + 1) * RERANK_BATCH_SIZE, topForLLM.length),
              total: topForLLM.length,
              message: `Batch ${b + 1} fell back to semantic scoring (AI timeout)`,
            });
            return batch.map((x) => ({
              ...x,
              score: Math.round(x.semantic * 100),
              lane: 'lateral' as JobLane,
              reasoning: 'Fallback score (batch rerank timed out).',
              skills: [],
            }));
          }
        }
        );
      } catch {
        // Step-level timeout after all retries (engine-enforced, not catchable
        // inside the step body). Degrade this batch, keep the run alive.
        batchRanked = batch.map((x) => ({
          ...x,
          score: Math.round(x.semantic * 100),
          lane: 'lateral' as JobLane,
          reasoning: 'Fallback score (batch rerank exhausted retries).',
          skills: [],
        }));
      }
      rankedJobs.push(...batchRanked);
    }

    // Append semantic-only tier + close out the rerank progress row
    await step.do('rerank-finalize', async () => {
      await emitEvent(db, resumeId, 'rerank', 'completed', {
        current: topForLLM.length + semanticOnly.length,
        total: topForLLM.length + semanticOnly.length,
        message: `${topForLLM.length} LLM-ranked, ${semanticOnly.length} semantic-only`,
      });
    });
    for (const s of semanticOnly) {
      rankedJobs.push({
        ...s,
        score: Math.round(s.semantic * 100),
        lane: null,
        reasoning: 'Matched by semantic similarity (not LLM-reviewed).',
        skills: [],
      });
    }


    // ---- Step 5: Save ----
    await step.do(
      'save',
      { retries: { limit: 2, delay: '5 seconds' }, timeout: '3 minutes' },
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

        // Build statements; truncate description to keep payload manageable.
        // Warm-path: deterministic cross-reference of each job's company
        // against the candidate's network contacts from the parsed profile.
        const stmts: D1PreparedStatement[] = [];
        for (const r of rankedJobs) {
          const truncatedDesc = (r.job.description || '').slice(0, 3000);
          const warmPath = findWarmPath(r.job.company, parsedProfile?.network_contacts);
          const existingId = r.job.external_id ? existingMap.get(r.job.external_id) : undefined;
          if (existingId) {
            stmts.push(
              db.prepare(`
                UPDATE jobs SET match_score = ?, match_explanation = ?,
                  semantic_score = ?, lane = ?, warm_path = ?, resume_id = ?, skills_required = ?
                WHERE id = ?
              `).bind(r.score, r.reasoning, r.semantic, r.lane, warmPath, resumeId,
                JSON.stringify(r.skills), existingId)
            );
          } else {
            stmts.push(
              db.prepare(`
                INSERT INTO jobs (external_id, title, company, location, description, url,
                  salary_min, salary_max, job_type, remote, source, skills_required,
                  embedding, match_score, match_explanation, semantic_score, lane,
                  warm_path, resume_id, posted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                r.job.external_id || null,
                r.job.title, r.job.company,
                r.job.location || null,
                truncatedDesc, r.job.url,
                r.job.salary_min ?? null, r.job.salary_max ?? null,
                r.job.job_type || 'full-time',
                r.job.remote ? 1 : 0,
                r.job.source,
                JSON.stringify(r.skills),
                null,
                r.score, r.reasoning, r.semantic, r.lane,
                warmPath,
                resumeId,
                r.job.posted_at || null
              )
            );
          }
        }

        // Chunk batches to avoid D1 payload/timeout issues with many statements
        const BATCH_SIZE = 30;
        for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
          const slice = stmts.slice(i, i + BATCH_SIZE);
          await db.batch(slice);
        }

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

// Normalize a title for matching: lowercase, drop parentheticals
// ("Customer Success Manager (technical / enterprise)" -> "customer success manager"),
// strip punctuation and seniority prefixes that vary between postings.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(sr|jr|senior|junior|staff|principal|lead|i{1,3}|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatchesAny(jobTitle: string, normalizedTargets: string[]): boolean {
  const jt = normalizeTitle(jobTitle);
  if (!jt) return false;
  for (const target of normalizedTargets) {
    if (!target) continue;
    if (jt.includes(target)) return true;
    const words = target.split(' ').filter((w) => w.length > 2);
    if (words.length >= 2 && words.every((w) => jt.includes(w))) return true;
  }
  return false;
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
