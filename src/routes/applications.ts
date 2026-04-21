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
    custom_url?: string;
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
  if (body.custom_url !== undefined) { updates.push('custom_url = ?'); params.push(body.custom_url); }
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

// Generate cover letter for an application and save it
applications.post('/:id/cover-letter', async (c) => {
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

  const { generateCoverLetter } = await import('../services/ai');
  const coverLetter = await generateCoverLetter(
    c.env.AI,
    resume.raw_text,
    app.job_title,
    app.company,
    app.job_description || ''
  );

  await c.env.DB.prepare(
    `UPDATE applications SET cover_letter = ?, resume_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(coverLetter, resumeId, id).run();

  return c.json({ cover_letter: coverLetter });
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

// --- CONTACTS ---

// List contacts for an application
applications.get('/:id/contacts', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(
    'SELECT * FROM application_contacts WHERE application_id = ? ORDER BY created_at DESC'
  ).bind(id).all();
  return c.json({ contacts: rows.results });
});

applications.post('/:id/contacts', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    name: string; role?: string; email?: string; phone?: string;
    linkedin?: string; notes?: string;
  }>();
  if (!body.name) return c.json({ error: 'name is required' }, 400);

  const result = await c.env.DB.prepare(`
    INSERT INTO application_contacts (application_id, name, role, email, phone, linkedin, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, body.name,
    body.role || null, body.email || null, body.phone || null,
    body.linkedin || null, body.notes || null
  ).run();
  return c.json({ id: result.meta.last_row_id }, 201);
});

applications.patch('/:id/contacts/:contactId', async (c) => {
  const contactId = c.req.param('contactId');
  const body = await c.req.json<{
    name?: string; role?: string; email?: string; phone?: string;
    linkedin?: string; notes?: string;
  }>();
  const fields: string[] = [];
  const params: (string | null)[] = [];
  for (const key of ['name', 'role', 'email', 'phone', 'linkedin', 'notes'] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key] ?? null);
    }
  }
  if (fields.length === 0) return c.json({ error: 'No fields' }, 400);
  fields.push("updated_at = datetime('now')");
  params.push(contactId);
  await c.env.DB.prepare(
    `UPDATE application_contacts SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...params).run();
  return c.json({ success: true });
});

applications.delete('/:id/contacts/:contactId', async (c) => {
  const contactId = c.req.param('contactId');
  await c.env.DB.prepare('DELETE FROM application_contacts WHERE id = ?').bind(contactId).run();
  return c.json({ success: true });
});

// --- COMMUNICATIONS ---

applications.get('/:id/communications', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(`
    SELECT c.*, ct.name as contact_name, ct.role as contact_role
    FROM application_communications c
    LEFT JOIN application_contacts ct ON c.contact_id = ct.id
    WHERE c.application_id = ?
    ORDER BY c.occurred_at DESC
  `).bind(id).all();
  return c.json({ communications: rows.results });
});

applications.post('/:id/communications', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    contact_id?: number;
    direction: 'sent' | 'received';
    channel: string;
    summary?: string;
    occurred_at?: string;
    next_action?: string;
    next_action_due?: string;
  }>();
  if (!body.direction || !body.channel) {
    return c.json({ error: 'direction and channel required' }, 400);
  }
  const result = await c.env.DB.prepare(`
    INSERT INTO application_communications
      (application_id, contact_id, direction, channel, summary,
       occurred_at, next_action, next_action_due)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
  `).bind(
    id,
    body.contact_id ?? null,
    body.direction, body.channel,
    body.summary || null,
    body.occurred_at || null,
    body.next_action || null,
    body.next_action_due || null
  ).run();
  return c.json({ id: result.meta.last_row_id }, 201);
});

applications.patch('/:id/communications/:commId', async (c) => {
  const commId = c.req.param('commId');
  const body = await c.req.json<{
    contact_id?: number | null;
    direction?: string;
    channel?: string;
    summary?: string;
    occurred_at?: string;
    next_action?: string;
    next_action_due?: string;
  }>();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  for (const key of ['contact_id', 'direction', 'channel', 'summary', 'occurred_at', 'next_action', 'next_action_due'] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key] ?? null);
    }
  }
  if (fields.length === 0) return c.json({ error: 'No fields' }, 400);
  params.push(commId);
  await c.env.DB.prepare(
    `UPDATE application_communications SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...params).run();
  return c.json({ success: true });
});

applications.delete('/:id/communications/:commId', async (c) => {
  const commId = c.req.param('commId');
  await c.env.DB.prepare('DELETE FROM application_communications WHERE id = ?').bind(commId).run();
  return c.json({ success: true });
});

// Get application pipeline stats
applications.get('/stats/pipeline', async (c) => {
  const stats = await c.env.DB.prepare(`
    SELECT status, COUNT(*) as count FROM applications GROUP BY status
  `).all();
  return c.json({ pipeline: stats.results });
});

export default applications;
