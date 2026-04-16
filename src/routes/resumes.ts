import { Hono } from 'hono';
import { Env, Resume, PipelineEvent } from '../types';

const resumes = new Hono<{ Bindings: Env }>();

// List all resumes (auto-mark stale in-progress as error)
resumes.get('/', async (c) => {
  await c.env.DB.prepare(
    `UPDATE resumes SET processing_status = 'error',
       processing_error = 'Pipeline appears stuck. Click Re-run to retry.'
     WHERE processing_status IN ('extracting','diagnosing','searching','ranking')
       AND (julianday('now') - julianday(updated_at)) * 24 * 60 > 15`
  ).run();

  const results = await c.env.DB.prepare(
    `SELECT id, name, skills, experience_years, summary, career_identities,
            target_titles, processing_status, processing_error,
            workflow_id, created_at, updated_at
     FROM resumes ORDER BY created_at DESC`
  ).all();
  return c.json({ resumes: results.results });
});

// Get single resume (with full analysis)
resumes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?').bind(id).first();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);
  return c.json({ resume });
});

// Get pipeline events for progress display
resumes.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM pipeline_events WHERE resume_id = ? ORDER BY id ASC`
  ).bind(id).all<PipelineEvent>();

  // Also include workflow status if we have an ID
  const resume = await c.env.DB.prepare(
    'SELECT workflow_id, processing_status FROM resumes WHERE id = ?'
  ).bind(id).first<{ workflow_id: string | null; processing_status: string }>();

  let workflow_status: string | null = null;
  if (resume?.workflow_id) {
    try {
      const instance = await c.env.PIPELINE.get(resume.workflow_id);
      const status = await instance.status();
      workflow_status = status.status;
    } catch {
      workflow_status = null;
    }
  }

  return c.json({
    events: rows.results || [],
    processing_status: resume?.processing_status || 'idle',
    workflow_status,
  });
});

// Lightweight status poll (kept for backward compat)
resumes.get('/:id/status', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, processing_status, processing_error, updated_at FROM resumes WHERE id = ?'
  ).bind(id).first();
  if (!row) return c.json({ error: 'Resume not found' }, 404);
  return c.json(row);
});

// Upload resume + kick off workflow
resumes.post('/', async (c) => {
  const body = await c.req.json<{ name: string; text: string }>();
  if (!body.name || !body.text) {
    return c.json({ error: 'name and text are required' }, 400);
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO resumes (name, raw_text, processing_status)
    VALUES (?, ?, 'diagnosing')
  `).bind(body.name, body.text).run();

  const resumeId = result.meta.last_row_id as number;

  const instance = await c.env.PIPELINE.create({ params: { resumeId } });
  await c.env.DB.prepare(
    'UPDATE resumes SET workflow_id = ? WHERE id = ?'
  ).bind(instance.id, resumeId).run();

  return c.json({ id: resumeId, workflow_id: instance.id, processing_status: 'diagnosing' }, 201);
});

// Delete resume (cascades: jobs, applications via job_id FK, pipeline_events)
resumes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM jobs WHERE resume_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM pipeline_events WHERE resume_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM resumes WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Manually reset a stuck resume status
resumes.post('/:id/reset', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    `UPDATE resumes SET processing_status = 'idle',
       processing_error = NULL, workflow_id = NULL,
       updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
  await c.env.DB.prepare('DELETE FROM pipeline_events WHERE resume_id = ?').bind(id).run();
  return c.json({ success: true });
});

// Re-run the full pipeline for an existing resume
resumes.post('/:id/rematch', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT id FROM resumes WHERE id = ?')
    .bind(id).first<Resume>();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);

  const instance = await c.env.PIPELINE.create({ params: { resumeId: Number(id) } });
  await c.env.DB.prepare(
    `UPDATE resumes SET workflow_id = ?, processing_status = 'diagnosing',
       processing_error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(instance.id, id).run();

  return c.json({ success: true, workflow_id: instance.id, processing_status: 'diagnosing' });
});

export default resumes;
