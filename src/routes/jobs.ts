import { Hono } from 'hono';
import { Env, Resume } from '../types';
import { generateCoverLetter } from '../services/ai';

const jobs = new Hono<{ Bindings: Env }>();

// List jobs with filters (resume, lane, remote, location, min/max salary, title)
jobs.get('/', async (c) => {
  const sortBy = c.req.query('sort') || 'match_score';
  const order = c.req.query('order') || 'DESC';
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const resumeId = c.req.query('resume_id');
  const lane = c.req.query('lane');
  const remoteOnly = c.req.query('remote') === '1';
  const location = c.req.query('location');
  const minSalary = c.req.query('min_salary');
  const titleLike = c.req.query('title');
  const minScore = c.req.query('min_score');

  const allowedSorts = ['match_score', 'semantic_score', 'created_at', 'salary_max', 'company', 'title'];
  const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'match_score';
  const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';

  let query = 'SELECT * FROM jobs WHERE 1=1';
  const params: (string | number)[] = [];

  if (resumeId) { query += ' AND resume_id = ?'; params.push(parseInt(resumeId)); }
  if (lane) { query += ' AND lane = ?'; params.push(lane); }
  if (remoteOnly) { query += ' AND remote = 1'; }
  if (location) { query += ' AND location LIKE ?'; params.push(`%${location}%`); }
  if (minSalary) { query += ' AND (salary_max IS NULL OR salary_max >= ?)'; params.push(parseInt(minSalary)); }
  if (titleLike) { query += ' AND title LIKE ?'; params.push(`%${titleLike}%`); }
  if (minScore) { query += ' AND match_score >= ?'; params.push(parseInt(minScore)); }

  query += ` ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const results = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ jobs: results.results, meta: { limit, offset } });
});

// Get single job
jobs.get('/:id', async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({ job });
});

// Manual search endpoint (non-resume-driven) - kept for flexibility but not primary path
jobs.post('/search', async (c) => {
  return c.json({ error: 'Job search is now triggered automatically by resume upload. Upload or re-match a resume instead.' }, 410);
});

// Generate cover letter
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

// Delete job
jobs.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

export default jobs;
