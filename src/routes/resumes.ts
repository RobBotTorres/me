import { Hono } from 'hono';
import { Env, Resume } from '../types';
import { runFullPipeline } from '../services/matcher';

const resumes = new Hono<{ Bindings: Env }>();

// List all resumes with status. Auto-marks stale (>5 min) in-progress as error.
resumes.get('/', async (c) => {
  await c.env.DB.prepare(
    `UPDATE resumes SET processing_status = 'error',
       processing_error = 'Pipeline timed out (worker likely killed). Click Re-run to retry.'
     WHERE processing_status IN ('extracting','diagnosing','searching','ranking')
       AND (julianday('now') - julianday(updated_at)) * 24 * 60 > 5`
  ).run();

  const results = await c.env.DB.prepare(
    `SELECT id, name, skills, experience_years, summary, career_identities,
            target_titles, processing_status, processing_error, created_at, updated_at
     FROM resumes ORDER BY created_at DESC`
  ).all();
  return c.json({ resumes: results.results });
});

// Manually reset a stuck resume status
resumes.post('/:id/reset', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(
    `UPDATE resumes SET processing_status = 'idle',
       processing_error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
  return c.json({ success: true });
});

// Get single resume (includes full analysis)
resumes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?').bind(id).first();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);
  return c.json({ resume });
});

// Lightweight status poll
resumes.get('/:id/status', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, processing_status, processing_error, updated_at FROM resumes WHERE id = ?'
  ).bind(id).first();
  if (!row) return c.json({ error: 'Resume not found' }, 404);

  const jobCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM jobs WHERE resume_id = ?'
  ).bind(id).first<{ count: number }>();

  return c.json({ ...row, job_count: jobCount?.count || 0 });
});

// Upload resume + kick off full pipeline
resumes.post('/', async (c) => {
  const body = await c.req.json<{ name: string; text: string }>();
  if (!body.name || !body.text) {
    return c.json({ error: 'name and text are required' }, 400);
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO resumes (name, raw_text, processing_status)
    VALUES (?, ?, 'extracting')
  `).bind(body.name, body.text).run();

  const resumeId = result.meta.last_row_id as number;

  // Run pipeline in background
  c.executionCtx.waitUntil(runFullPipeline(c.env, resumeId));

  return c.json({ id: resumeId, processing_status: 'extracting' }, 201);
});

// Delete resume (and its associated jobs)
resumes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM jobs WHERE resume_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM resumes WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Re-run the full pipeline for an existing resume
resumes.post('/:id/rematch', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT id FROM resumes WHERE id = ?').bind(id).first<Resume>();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE resumes SET processing_status = 'diagnosing', processing_error = NULL WHERE id = ?`
  ).bind(id).run();

  c.executionCtx.waitUntil(runFullPipeline(c.env, Number(id)));
  return c.json({ success: true, processing_status: 'diagnosing' });
});

export default resumes;
