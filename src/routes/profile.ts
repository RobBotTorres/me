import { Hono } from 'hono';
import { Env } from '../types';

const profile = new Hono<{ Bindings: Env }>();

profile.get('/', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM candidate_profile WHERE id = 1').first();
  return c.json({ profile: row });
});

profile.put('/', async (c) => {
  const body = await c.req.json<{ context: string }>();
  if (!body.context || !body.context.trim()) {
    return c.json({ error: 'context is required' }, 400);
  }
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO candidate_profile (id, context, updated_at)
     VALUES (1, ?, datetime('now'))`
  ).bind(body.context).run();
  return c.json({ success: true });
});

profile.delete('/', async (c) => {
  await c.env.DB.prepare('DELETE FROM candidate_profile WHERE id = 1').run();
  return c.json({ success: true });
});

export default profile;
