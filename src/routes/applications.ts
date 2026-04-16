import { Hono } from 'hono';
import { Env, Resume } from '../types';
import { generateTailoredResume } from '../services/ai';

const applications = new Hono<{ Bindings: Env }>();

// List all applications with job details
applications.get('/', async (c) => {
  const status = c.req.query('status');

  let query = `
    SELECT a.*, j.title as job_title, j.company, j.location, j.url as job_url, j.match_score
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
  `;
  const params: string[] = [];

  if (status) {
    query += ' WHERE a.status = ?';
    params.push(status);
  }

  query += ' ORDER BY a.updated_at DESC';

  const stmt = c.env.DB.prepare(query);
  const results = params.length > 0
    ? await stmt.bind(...params).all()
    : await stmt.all();

  return c.json({ applications: results.results });
});

// Get single application
applications.get('/:id', async (c) => {
  const id = c.req.param('id');
  const app = await c.env.DB.prepare(`
    SELECT a.*, j.title as job_title, j.company, j.location, j.url as job_url,
           j.description as job_description, j.match_score
    FROM applications a
    JOIN jobs j ON a.job_id = j.id
    WHERE a.id = ?
  `).bind(id).first();

  if (!app) return c.json({ error: 'Application not found' }, 404);
  return c.json({ application: app });
});

// Create application (save a job to tracker)
applications.post('/', async (c) => {
  const body = await c.req.json<{
    job_id: number;
    resume_id?: number;
    status?: string;
    notes?: string;
  }>();

  if (!body.job_id) return c.json({ error: 'job_id is required' }, 400);

  // Check job exists
  const job = await c.env.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(body.job_id).first();
  if (!job) return c.json({ error: 'Job not found' }, 404);

  // Check for duplicate
  const existing = await c.env.DB.prepare(
    'SELECT id FROM applications WHERE job_id = ?'
  ).bind(body.job_id).first();
  if (existing) return c.json({ error: 'Application already exists for this job' }, 409);

  const result = await c.env.DB.prepare(`
    INSERT INTO applications (job_id, resume_id, status, notes)
    VALUES (?, ?, ?, ?)
  `).bind(
    body.job_id,
    body.resume_id || null,
    body.status || 'saved',
    body.notes || null
  ).run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

// Update application status
applications.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    status?: string;
    notes?: string;
    cover_letter?: string;
    applied_at?: string;
    interview_at?: string;
  }>();

  const validStatuses = ['saved', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn'];
  if (body.status && !validStatuses.includes(body.status)) {
    return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const updates: string[] = [];
  const params: (string | null)[] = [];

  if (body.status) {
    updates.push('status = ?');
    params.push(body.status);
    if (body.status === 'applied' && !body.applied_at) {
      updates.push("applied_at = datetime('now')");
    }
  }
  if (body.notes !== undefined) { updates.push('notes = ?'); params.push(body.notes); }
  if (body.cover_letter !== undefined) { updates.push('cover_letter = ?'); params.push(body.cover_letter); }
  if (body.applied_at) { updates.push('applied_at = ?'); params.push(body.applied_at); }
  if (body.interview_at) { updates.push('interview_at = ?'); params.push(body.interview_at); }

  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

  updates.push("updated_at = datetime('now')");
  params.push(id);

  await c.env.DB.prepare(`UPDATE applications SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  return c.json({ success: true });
});

// Delete application
applications.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Generate tailored resume for an application (strict no-fabrication)
applications.post('/:id/tailor-resume', async (c) => {
  const id = c.req.param('id');
  const app = await c.env.DB.prepare(`
    SELECT a.*, j.title as job_title, j.company, j.description as job_description
    FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = ?
  `).bind(id).first<{
    resume_id: number | null;
    job_title: string;
    company: string;
    job_description: string;
  }>();
  if (!app) return c.json({ error: 'Application not found' }, 404);

  const body = await c.req.json<{ resume_id?: number }>().catch(() => ({ resume_id: undefined }));
  const resumeId = body.resume_id || app.resume_id;
  if (!resumeId) return c.json({ error: 'No resume linked. Pass resume_id or link one to the application.' }, 400);

  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?')
    .bind(resumeId).first<Resume>();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);

  const tailored = await generateTailoredResume(
    c.env.AI,
    resume.raw_text,
    app.job_title,
    app.company,
    app.job_description || ''
  );

  await c.env.DB.prepare(
    `UPDATE applications SET tailored_resume = ?, resume_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(tailored, resumeId, id).run();

  return c.json({ tailored_resume: tailored });
});

// Get application pipeline stats
applications.get('/stats/pipeline', async (c) => {
  const stats = await c.env.DB.prepare(`
    SELECT status, COUNT(*) as count FROM applications GROUP BY status
  `).all();
  return c.json({ pipeline: stats.results });
});

export default applications;
