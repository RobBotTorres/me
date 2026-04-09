import { Hono } from 'hono';
import { Env, Resume } from '../types';
import { searchJobs, SearchOptions } from '../services/jobs';
import { matchAndStoreJobs } from '../services/matcher';
import { generateCoverLetter } from '../services/ai';

const jobs = new Hono<{ Bindings: Env }>();

// List jobs with filtering and sorting
jobs.get('/', async (c) => {
  const sortBy = c.req.query('sort') || 'match_score';
  const order = c.req.query('order') || 'DESC';
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const source = c.req.query('source');
  const minScore = c.req.query('min_score');

  const allowedSorts = ['match_score', 'created_at', 'salary_max', 'company', 'title'];
  const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'match_score';
  const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';

  let query = 'SELECT * FROM jobs WHERE 1=1';
  const params: (string | number)[] = [];

  if (source) {
    query += ' AND source = ?';
    params.push(source);
  }
  if (minScore) {
    query += ' AND match_score >= ?';
    params.push(parseInt(minScore));
  }

  query += ` ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = c.env.DB.prepare(query);
  const results = await stmt.bind(...params).all();

  return c.json({ jobs: results.results, meta: { limit, offset } });
});

// Get single job with full details
jobs.get('/:id', async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({ job });
});

// Search for new jobs from external APIs and match against resume
jobs.post('/search', async (c) => {
  const body = await c.req.json<{
    query: string;
    location?: string;
    remote_only?: boolean;
    resume_id?: number;
  }>();

  if (!body.query) {
    return c.json({ error: 'query is required' }, 400);
  }

  // Search external APIs
  const searchOptions: SearchOptions = {
    query: body.query,
    location: body.location,
    remoteOnly: body.remote_only,
    rapidApiKey: c.env.RAPIDAPI_KEY,
    adzunaAppId: c.env.ADZUNA_APP_ID,
    adzunaAppKey: c.env.ADZUNA_APP_KEY,
  };

  const externalJobs = await searchJobs(searchOptions);

  // If resume provided, match and store with scores
  if (body.resume_id) {
    const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?')
      .bind(body.resume_id).first<Resume>();

    if (resume) {
      const stored = await matchAndStoreJobs(c.env, resume, externalJobs);
      return c.json({ jobs_found: externalJobs.length, jobs_stored: stored, message: 'Jobs matched and saved' });
    }
  }

  // Store without matching
  let stored = 0;
  for (const job of externalJobs) {
    try {
      const existing = await c.env.DB.prepare('SELECT id FROM jobs WHERE external_id = ?')
        .bind(job.external_id || '').first();
      if (existing) continue;

      await c.env.DB.prepare(`
        INSERT INTO jobs (external_id, title, company, location, description, url,
          salary_min, salary_max, job_type, remote, source, posted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        job.external_id || null, job.title, job.company, job.location || null,
        job.description, job.url, job.salary_min ?? null, job.salary_max ?? null,
        job.job_type || 'full-time', job.remote ? 1 : 0, job.source, job.posted_at || null
      ).run();
      stored++;
    } catch { /* skip duplicates */ }
  }

  return c.json({ jobs_found: externalJobs.length, jobs_stored: stored });
});

// Generate cover letter for a job
jobs.post('/:id/cover-letter', async (c) => {
  const jobId = c.req.param('id');
  const body = await c.req.json<{ resume_id: number }>();

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?')
    .bind(body.resume_id).first<Resume>();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);

  const coverLetter = await generateCoverLetter(
    c.env.AI,
    resume.raw_text,
    job.title as string,
    job.company as string,
    (job.description as string) || ''
  );

  return c.json({ cover_letter: coverLetter });
});

// Delete a job
jobs.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

export default jobs;
