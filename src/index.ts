import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import jobRoutes from './routes/jobs';
import resumeRoutes from './routes/resumes';
import applicationRoutes from './routes/applications';
import searchRoutes from './routes/search';

export { ResumePipeline } from './workflows/resume-pipeline';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'job-search-agent', timestamp: new Date().toISOString() });
});

// Diagnostics: check schema + bindings
app.get('/api/diagnostics', async (c) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // D1 tables
  try {
    const tables = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all<{ name: string }>();
    const names = new Set((tables.results || []).map((r) => r.name));
    checks.d1_pipeline_events_table = { ok: names.has('pipeline_events'), detail: names.has('pipeline_events') ? undefined : 'Migration 002 not applied' };
  } catch (e) {
    checks.d1_pipeline_events_table = { ok: false, detail: (e as Error).message };
  }

  // workflow_id column
  try {
    const cols = await c.env.DB.prepare("PRAGMA table_info(resumes)").all<{ name: string }>();
    const hasCol = (cols.results || []).some((c) => c.name === 'workflow_id');
    checks.d1_workflow_id_column = { ok: hasCol, detail: hasCol ? undefined : 'ALTER TABLE resumes ADD COLUMN workflow_id TEXT pending' };
  } catch (e) {
    checks.d1_workflow_id_column = { ok: false, detail: (e as Error).message };
  }

  // Workflow binding present
  checks.workflow_binding = {
    ok: typeof c.env.PIPELINE !== 'undefined',
    detail: typeof c.env.PIPELINE === 'undefined' ? 'PIPELINE binding missing. Not deployed or plan does not support Workflows.' : undefined,
  };

  // AI binding
  checks.ai_binding = { ok: typeof c.env.AI !== 'undefined' };

  const allOk = Object.values(checks).every((c) => c.ok);
  return c.json({ ok: allOk, checks });
});

app.get('/api/dashboard', async (c) => {
  const [jobCount, resumeCount, appCount, pipeline, topJobs, recentApps] = await Promise.all([
    c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM jobs WHERE id NOT IN (SELECT job_id FROM applications)'
    ).first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM resumes').first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM applications').first<{ count: number }>(),
    c.env.DB.prepare('SELECT status, COUNT(*) as count FROM applications GROUP BY status').all(),
    c.env.DB.prepare(`
      SELECT id, title, company, location, match_score, lane, url FROM jobs
      WHERE id NOT IN (SELECT job_id FROM applications)
      ORDER BY match_score DESC LIMIT 5
    `).all(),
    c.env.DB.prepare(`
      SELECT a.id, a.status, a.updated_at, j.title, j.company
      FROM applications a JOIN jobs j ON a.job_id = j.id
      ORDER BY a.updated_at DESC LIMIT 5
    `).all(),
  ]);

  return c.json({
    stats: {
      total_jobs: jobCount?.count || 0,
      total_resumes: resumeCount?.count || 0,
      total_applications: appCount?.count || 0,
    },
    pipeline: pipeline.results,
    top_matches: topJobs.results,
    recent_applications: recentApps.results,
  });
});

// Manual cron trigger (for testing)
app.post('/api/cron/run', async (c) => {
  const resumes = await c.env.DB.prepare(
    "SELECT id FROM resumes WHERE processing_status IN ('complete', 'error', 'idle')"
  ).all<{ id: number }>();

  const triggered: { id: number; workflow_id: string }[] = [];
  for (const r of resumes.results || []) {
    const instance = await c.env.PIPELINE.create({ params: { resumeId: r.id } });
    await c.env.DB.prepare(
      'UPDATE resumes SET workflow_id = ?, processing_status = ? WHERE id = ?'
    ).bind(instance.id, 'diagnosing', r.id).run();
    triggered.push({ id: r.id, workflow_id: instance.id });
  }
  return c.json({ triggered });
});

app.route('/api/jobs', jobRoutes);
app.route('/api/resumes', resumeRoutes);
app.route('/api/applications', applicationRoutes);
app.route('/api/search', searchRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const resumes = await env.DB.prepare(
      "SELECT id FROM resumes WHERE processing_status IN ('complete', 'error', 'idle')"
    ).all<{ id: number }>();

    for (const r of resumes.results || []) {
      const instance = await env.PIPELINE.create({ params: { resumeId: r.id } });
      await env.DB.prepare(
        'UPDATE resumes SET workflow_id = ?, processing_status = ? WHERE id = ?'
      ).bind(instance.id, 'diagnosing', r.id).run();
    }
  },
};
