import { Hono } from 'hono';
import { Env } from '../types';

const search = new Hono<{ Bindings: Env }>();

// List saved search preferences
search.get('/preferences', async (c) => {
  const results = await c.env.DB.prepare(
    'SELECT * FROM search_preferences ORDER BY created_at DESC'
  ).all();
  return c.json({ preferences: results.results });
});

// Create search preference
search.post('/preferences', async (c) => {
  const body = await c.req.json<{
    name: string;
    keywords: string[];
    locations?: string[];
    min_salary?: number;
    max_salary?: number;
    remote_only?: boolean;
    job_type?: string;
  }>();

  if (!body.name || !body.keywords?.length) {
    return c.json({ error: 'name and keywords are required' }, 400);
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO search_preferences (name, keywords, locations, min_salary, max_salary, remote_only, job_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.name,
    JSON.stringify(body.keywords),
    JSON.stringify(body.locations || []),
    body.min_salary || null,
    body.max_salary || null,
    body.remote_only ? 1 : 0,
    body.job_type || 'full-time'
  ).run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

// Update search preference
search.patch('/preferences/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    keywords?: string[];
    locations?: string[];
    min_salary?: number;
    max_salary?: number;
    remote_only?: boolean;
    job_type?: string;
    is_active?: boolean;
  }>();

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.name) { updates.push('name = ?'); params.push(body.name); }
  if (body.keywords) { updates.push('keywords = ?'); params.push(JSON.stringify(body.keywords)); }
  if (body.locations) { updates.push('locations = ?'); params.push(JSON.stringify(body.locations)); }
  if (body.min_salary !== undefined) { updates.push('min_salary = ?'); params.push(body.min_salary); }
  if (body.max_salary !== undefined) { updates.push('max_salary = ?'); params.push(body.max_salary); }
  if (body.remote_only !== undefined) { updates.push('remote_only = ?'); params.push(body.remote_only ? 1 : 0); }
  if (body.job_type) { updates.push('job_type = ?'); params.push(body.job_type); }
  if (body.is_active !== undefined) { updates.push('is_active = ?'); params.push(body.is_active ? 1 : 0); }

  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

  updates.push("updated_at = datetime('now')");
  params.push(id);

  await c.env.DB.prepare(`UPDATE search_preferences SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  return c.json({ success: true });
});

// Delete search preference
search.delete('/preferences/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM search_preferences WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Get search run history
search.get('/runs', async (c) => {
  const results = await c.env.DB.prepare(`
    SELECT sr.*, sp.name as preference_name
    FROM search_runs sr
    LEFT JOIN search_preferences sp ON sr.preference_id = sp.id
    ORDER BY sr.started_at DESC
    LIMIT 50
  `).all();
  return c.json({ runs: results.results });
});

export default search;
