import { Hono } from 'hono';
import { Env, Resume, ResumeDiagnosis, JobLane } from '../types';
import {
  generateCoverLetter,
  getEmbedding,
  cosineSimilarity,
  rerankJobs,
} from '../services/ai';

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

  // Jobs that already have an application are hidden here (they show in the
  // Applications tab instead). Set include_saved=1 to include them anyway.
  const includeSaved = c.req.query('include_saved') === '1';

  let query = 'SELECT * FROM jobs WHERE 1=1';
  if (!includeSaved) query += ' AND id NOT IN (SELECT job_id FROM applications)';
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

// Manually add a single job, optionally assessed against a resume
jobs.post('/manual', async (c) => {
  const body = await c.req.json<{
    title: string;
    company?: string;
    description: string;
    url: string;
    location?: string;
    salary_min?: number;
    salary_max?: number;
    remote?: boolean;
    resume_id?: number;
  }>();

  if (!body.title || !body.description || !body.url) {
    return c.json({ error: 'title, description, and url are required' }, 400);
  }

  let matchScore: number | null = null;
  let matchExplanation: string | null = null;
  let lane: JobLane | null = null;
  let semantic: number | null = null;
  let skills: string[] = [];

  if (body.resume_id) {
    const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?')
      .bind(body.resume_id).first<Resume>();

    if (resume?.analysis && resume.embedding) {
      try {
        const diagnosis = JSON.parse(resume.analysis) as ResumeDiagnosis;
        const resumeEmb = JSON.parse(resume.embedding) as number[];

        // Embed job + compute semantic score
        const jobText = `${body.title} at ${body.company || 'Unknown'}\n${body.description.slice(0, 1500)}`;
        const jobEmb = await getEmbedding(c.env.AI, jobText);
        semantic = cosineSimilarity(resumeEmb, jobEmb);

        // Rerank (1 job)
        const results = await rerankJobs(c.env.AI, diagnosis, resume.raw_text, [{
          title: body.title,
          company: body.company || 'Unknown',
          description: body.description,
        }]);
        if (results.length > 0) {
          matchScore = results[0].score;
          matchExplanation = results[0].reasoning;
          lane = results[0].lane;
          skills = results[0].skills || [];
        } else {
          matchScore = Math.round(semantic * 100);
          matchExplanation = 'Semantic match (rerank returned empty).';
        }
      } catch (err) {
        matchScore = semantic != null ? Math.round(semantic * 100) : null;
        matchExplanation = `Assessment error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const externalId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await c.env.DB.prepare(`
    INSERT INTO jobs (external_id, title, company, location, description, url,
      salary_min, salary_max, job_type, remote, source, skills_required,
      match_score, match_explanation, semantic_score, lane, resume_id, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'full-time', ?, 'manual', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    externalId,
    body.title,
    body.company || 'Unknown',
    body.location || null,
    body.description,
    body.url,
    body.salary_min ?? null,
    body.salary_max ?? null,
    body.remote ? 1 : 0,
    JSON.stringify(skills),
    matchScore,
    matchExplanation,
    semantic,
    lane,
    body.resume_id || null,
    new Date().toISOString()
  ).run();

  const id = result.meta.last_row_id;
  const saved = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  return c.json({ job: saved }, 201);
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
