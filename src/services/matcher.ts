import { Env, Resume, ExternalJob, MatchResult } from '../types';
import { matchJobToResume, extractJobSkills, getEmbedding, cosineSimilarity } from './ai';

/**
 * Orchestrates the matching pipeline:
 * 1. Extract skills from job descriptions
 * 2. Compute AI match scores against resume
 * 3. Store results in D1
 */

export async function matchAndStoreJobs(
  env: Env,
  resume: Resume,
  externalJobs: ExternalJob[]
): Promise<number> {
  const resumeSkills: string[] = JSON.parse(resume.skills || '[]');
  const resumeSummary = resume.summary || resume.raw_text.slice(0, 500);

  let stored = 0;

  // Process jobs in batches of 5 to avoid overwhelming Workers AI
  const batchSize = 5;
  for (let i = 0; i < externalJobs.length; i += batchSize) {
    const batch = externalJobs.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map(async (job) => {
        // Check if job already exists
        const existing = await env.DB.prepare(
          'SELECT id FROM jobs WHERE external_id = ?'
        ).bind(job.external_id || '').first();

        if (existing) return null;

        // Extract required skills from job description
        const requiredSkills = await extractJobSkills(env.AI, job.description);

        // Compute AI match score
        const match = await matchJobToResume(
          env.AI,
          resumeSkills,
          resumeSummary,
          job.title,
          job.description
        );

        return { job, requiredSkills, match };
      })
    );

    // Insert results into D1
    for (const result of results) {
      if (!result) continue;
      const { job, requiredSkills, match } = result;

      try {
        await env.DB.prepare(`
          INSERT INTO jobs (external_id, title, company, location, description, url,
            salary_min, salary_max, job_type, remote, source, skills_required,
            match_score, match_explanation, posted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          job.external_id || null,
          job.title,
          job.company,
          job.location || null,
          job.description,
          job.url,
          job.salary_min ?? null,
          job.salary_max ?? null,
          job.job_type || 'full-time',
          job.remote ? 1 : 0,
          job.source,
          JSON.stringify(requiredSkills),
          match.score,
          match.explanation,
          job.posted_at || null
        ).run();

        stored++;
      } catch {
        // Skip duplicates or DB errors
      }
    }
  }

  return stored;
}

export async function recomputeMatchScores(env: Env, resume: Resume): Promise<number> {
  const resumeSkills: string[] = JSON.parse(resume.skills || '[]');
  const resumeSummary = resume.summary || resume.raw_text.slice(0, 500);

  const jobs = await env.DB.prepare(
    'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100'
  ).all();

  if (!jobs.results) return 0;

  let updated = 0;
  const batchSize = 5;

  for (let i = 0; i < jobs.results.length; i += batchSize) {
    const batch = jobs.results.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (job: Record<string, unknown>) => {
        const match = await matchJobToResume(
          env.AI,
          resumeSkills,
          resumeSummary,
          job.title as string,
          (job.description as string) || ''
        );

        await env.DB.prepare(
          'UPDATE jobs SET match_score = ?, match_explanation = ? WHERE id = ?'
        ).bind(match.score, match.explanation, job.id as number).run();

        updated++;
      })
    );
  }

  return updated;
}
