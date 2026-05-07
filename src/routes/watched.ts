import { Hono } from 'hono';
import { Env } from '../types';
import { fetchWatchedCompanyJobs } from '../services/jobs';

const watched = new Hono<{ Bindings: Env }>();

const SUPPORTED = ['greenhouse', 'lever', 'ashby'] as const;
type Ats = typeof SUPPORTED[number];

watched.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM watched_companies ORDER BY label, slug'
  ).all();
  return c.json({ companies: rows.results });
});

watched.post('/', async (c) => {
  const body = await c.req.json<{ slug: string; ats: string; label?: string }>();
  if (!body.slug || !body.ats) return c.json({ error: 'slug and ats required' }, 400);
  if (!SUPPORTED.includes(body.ats as Ats)) {
    return c.json({ error: `ats must be one of: ${SUPPORTED.join(', ')}` }, 400);
  }
  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO watched_companies (slug, ats, label) VALUES (?, ?, ?)'
    ).bind(body.slug.trim().toLowerCase(), body.ats, body.label?.trim() || body.slug).run();
    return c.json({ id: result.meta.last_row_id }, 201);
  } catch (e) {
    return c.json({ error: 'Already watching this company on this ATS' }, 409);
  }
});

watched.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM watched_companies WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Test fetch - hits the ATS without saving, returns count + sample
watched.post('/test', async (c) => {
  const body = await c.req.json<{ slug: string; ats: string; label?: string }>();
  if (!body.slug || !body.ats) return c.json({ error: 'slug and ats required' }, 400);
  if (!SUPPORTED.includes(body.ats as Ats)) {
    return c.json({ error: `ats must be one of: ${SUPPORTED.join(', ')}` }, 400);
  }
  const jobs = await fetchWatchedCompanyJobs(body.ats, body.slug, body.label);
  return c.json({
    count: jobs.length,
    sample: jobs.slice(0, 3).map((j) => ({ title: j.title, location: j.location })),
  });
});

export default watched;
