import { Hono } from 'hono';
import { Env, Resume } from '../types';
import { analyzeResume } from '../services/ai';
import { recomputeMatchScores } from '../services/matcher';

const resumes = new Hono<{ Bindings: Env }>();

// List all resumes
resumes.get('/', async (c) => {
  const results = await c.env.DB.prepare(
    'SELECT id, name, skills, experience_years, summary, created_at FROM resumes ORDER BY created_at DESC'
  ).all();
  return c.json({ resumes: results.results });
});

// Get single resume
resumes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?').bind(id).first();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);
  return c.json({ resume });
});

// Upload & analyze a resume
resumes.post('/', async (c) => {
  const body = await c.req.json<{ name: string; text: string }>();

  if (!body.name || !body.text) {
    return c.json({ error: 'name and text are required' }, 400);
  }

  // AI analysis
  const analysis = await analyzeResume(c.env.AI, body.text);

  const result = await c.env.DB.prepare(`
    INSERT INTO resumes (name, raw_text, skills, experience_years, summary)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    body.name,
    body.text,
    JSON.stringify(analysis.skills),
    analysis.experience_years,
    analysis.summary
  ).run();

  return c.json({
    id: result.meta.last_row_id,
    name: body.name,
    skills: analysis.skills,
    experience_years: analysis.experience_years,
    summary: analysis.summary,
  }, 201);
});

// Delete resume
resumes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM resumes WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Re-analyze resume with AI
resumes.post('/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?').bind(id).first<Resume>();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);

  const analysis = await analyzeResume(c.env.AI, resume.raw_text);

  await c.env.DB.prepare(`
    UPDATE resumes SET skills = ?, experience_years = ?, summary = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(JSON.stringify(analysis.skills), analysis.experience_years, analysis.summary, id).run();

  return c.json({ analysis });
});

// Recompute match scores for all jobs against this resume
resumes.post('/:id/rematch', async (c) => {
  const id = c.req.param('id');
  const resume = await c.env.DB.prepare('SELECT * FROM resumes WHERE id = ?').bind(id).first<Resume>();
  if (!resume) return c.json({ error: 'Resume not found' }, 404);

  const updated = await recomputeMatchScores(c.env, resume);
  return c.json({ updated });
});

export default resumes;
