import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import jobRoutes from './routes/jobs';
import resumeRoutes from './routes/resumes';
import applicationRoutes from './routes/applications';
import searchRoutes from './routes/search';
import { runFullPipeline } from './services/matcher';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'job-search-agent', timestamp: new Date().toISOString() });
});

app.get('/api/dashboard', async (c) => {
  // Exclude jobs that already have an application (tracked elsewhere)
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

  for (const r of resumes.results || []) {
    c.executionCtx.waitUntil(runFullPipeline(c.env, r.id));
  }
  return c.json({ triggered: resumes.results?.length || 0 });
});

app.route('/api/jobs', jobRoutes);
app.route('/api/resumes', resumeRoutes);
app.route('/api/applications', applicationRoutes);
app.route('/api/search', searchRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const resumes = await env.DB.prepare(
      "SELECT id FROM resumes WHERE processing_status IN ('complete', 'error', 'idle')"
    ).all<{ id: number }>();

    for (const r of resumes.results || []) {
      ctx.waitUntil(runFullPipeline(env, r.id));
    }
  },
};
