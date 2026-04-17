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

// Return full error details instead of generic 500
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({
    error: err.message || 'Unknown error',
    name: err.name,
    stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
  }, 500);
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'job-search-agent', timestamp: new Date().toISOString() });
});

// Test endpoint: hit embedding directly so we can isolate whether Workers AI works
// Internal endpoint called by Workflow via self-fetch. Runs in a fresh Worker
// invocation so the Workflow doesn't burn its subrequest budget on AI calls.
// Internal endpoint: rerank all jobs via Workers AI (batches internally)
app.post('/api/internal/rerank', async (c) => {
  const { rerankJobs } = await import('./services/ai');
  const body = await c.req.json<{
    diagnosis: import('./types').ResumeDiagnosis;
    resumeText: string;
    jobs: { title: string; company: string; description: string }[];
    batchSize?: number;
  }>();
  const batchSize = body.batchSize || 15;
  const results: import('./services/ai').JobRerankResultExt[] = [];
  for (let i = 0; i < body.jobs.length; i += batchSize) {
    const batch = body.jobs.slice(i, i + batchSize);
    try {
      const rankResults = await rerankJobs(c.env.AI, body.diagnosis, body.resumeText, batch);
      // Remap indices to global positions
      for (const r of rankResults) {
        results.push({ ...r, job_index: i + r.job_index });
      }
    } catch (err) {
      // Skip failed batch
    }
  }
  return c.json({ results });
});

app.post('/api/internal/embed', async (c) => {
  const body = await c.req.json<{ texts: string[] }>();
  if (!Array.isArray(body.texts) || body.texts.length === 0) {
    return c.json({ error: 'texts required' }, 400);
  }
  const truncated = body.texts.map((t) => (t || '').slice(0, 2000));
  try {
    // Workers AI bge-base supports ~100 texts per request. Batch internally.
    const BATCH = 90;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < truncated.length; i += BATCH) {
      const slice = truncated.slice(i, i + BATCH);
      const response = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: slice });
      const part = (response as { data: number[][] }).data;
      allEmbeddings.push(...part);
    }
    return c.json({ embeddings: allEmbeddings, count: allEmbeddings.length });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/api/test/embed', async (c) => {
  const body = await c.req.json<{ texts?: string[]; count?: number }>().catch(() => ({} as { texts?: string[]; count?: number }));
  const count = body.count ?? 40;
  const texts = body.texts ?? Array.from({ length: count }, (_, i) => `test job ${i} content`);
  const start = Date.now();
  try {
    const response = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts });
    const data = (response as { data: number[][] }).data;
    return c.json({
      ok: true,
      inputs: texts.length,
      embeddings_returned: data.length,
      vector_dim: data[0]?.length,
      ms: Date.now() - start,
    });
  } catch (err) {
    return c.json({
      ok: false,
      inputs: texts.length,
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
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

  // Unique index on pipeline_events (needed for UPSERT)
  try {
    const idx = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pipeline_events_resume_step'"
    ).first();
    checks.d1_pipeline_events_unique_index = {
      ok: !!idx,
      detail: idx ? undefined : "Run: CREATE UNIQUE INDEX idx_pipeline_events_resume_step ON pipeline_events(resume_id, step_key);",
    };
  } catch (e) {
    checks.d1_pipeline_events_unique_index = { ok: false, detail: (e as Error).message };
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
