import { Hono } from 'hono';
import { Env, ParsedProfile } from '../types';
import { extractProfileData } from '../services/ai';

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

  // Extract structured data once at save time. The pipeline then uses
  // parsed target_titles / contacts deterministically - no per-run LLM drift.
  let parsed: ParsedProfile | null = null;
  let parseError: string | null = null;
  try {
    parsed = await extractProfileData(c.env.AI, body.context);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO candidate_profile (id, context, parsed_json, updated_at)
     VALUES (1, ?, ?, datetime('now'))`
  ).bind(body.context, parsed ? JSON.stringify(parsed) : null).run();

  return c.json({
    success: true,
    parsed_summary: parsed
      ? {
          target_titles: parsed.target_titles?.length || 0,
          network_contacts: parsed.network_contacts?.length || 0,
          watched_company_hints: parsed.watched_company_hints?.length || 0,
          exclusions: parsed.exclusions?.length || 0,
        }
      : null,
    parse_error: parseError,
  });
});

// Re-run extraction on the already-saved context (e.g. after a model upgrade)
profile.post('/reparse', async (c) => {
  const row = await c.env.DB.prepare('SELECT context FROM candidate_profile WHERE id = 1')
    .first<{ context: string }>();
  if (!row) return c.json({ error: 'No profile saved' }, 404);
  const parsed = await extractProfileData(c.env.AI, row.context);
  await c.env.DB.prepare(
    `UPDATE candidate_profile SET parsed_json = ?, updated_at = datetime('now') WHERE id = 1`
  ).bind(JSON.stringify(parsed)).run();
  return c.json({ success: true, parsed });
});

profile.delete('/', async (c) => {
  await c.env.DB.prepare('DELETE FROM candidate_profile WHERE id = 1').run();
  return c.json({ success: true });
});

export default profile;
