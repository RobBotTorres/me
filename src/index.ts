import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import jobRoutes from './routes/jobs';
import resumeRoutes from './routes/resumes';
import applicationRoutes from './routes/applications';
import searchRoutes from './routes/search';

const app = new Hono<{ Bindings: Env }>();

// CORS for frontend
app.use('*', cors());

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'ai-job-search-agent', timestamp: new Date().toISOString() });
});

// Dashboard stats
app.get('/api/dashboard', async (c) => {
  const [jobCount, resumeCount, appCount, pipeline, topJobs, recentApps] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM jobs').first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM resumes').first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM applications').first<{ count: number }>(),
    c.env.DB.prepare('SELECT status, COUNT(*) as count FROM applications GROUP BY status').all(),
    c.env.DB.prepare('SELECT id, title, company, location, match_score, url FROM jobs ORDER BY match_score DESC LIMIT 5').all(),
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

// Mount route groups
app.route('/api/jobs', jobRoutes);
app.route('/api/resumes', resumeRoutes);
app.route('/api/applications', applicationRoutes);
app.route('/api/search', searchRoutes);

// Static frontend (public/index.html) is served automatically by the
// [assets] binding in wrangler.toml. This worker only handles /api/* routes.

export default app;
