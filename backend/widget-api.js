// Widget ingest API. Mounted at /v1 from server.js.
// Phase 1: stub. Accepts submissions, validates lightly, logs.
// Phase 2 will: replace stub with multi-tenant SQLite schema, project key auth,
// rate limiting, screenshot storage on the persistent volume.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

export function createWidgetApi({ logger } = {}) {
  const log = logger || { info: console.log, warn: console.warn };
  const app = new Hono();

  // Wide-open CORS for ingest — widgets run on customer origins.
  // Phase 2 will replace this with a per-project allowlist (hygiene only;
  // real defense is rate limit + ingestion budget).
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-Project-Key'],
      credentials: false,
    })
  );

  app.post('/submissions', async (c) => {
    const projectKey = c.req.header('X-Project-Key');
    if (!projectKey || !projectKey.startsWith('pk_')) {
      return c.json({ error: 'missing or invalid X-Project-Key' }, 401);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'invalid json' }, 400);

    const message = (body.message ?? '').trim();
    if (!message) return c.json({ error: 'message required' }, 400);
    if (message.length > 5000) {
      return c.json({ error: 'message must be 5000 characters or fewer' }, 413);
    }

    log.info('widget submission received', {
      projectKey,
      origin: c.req.header('Origin') || null,
      url: body.url ?? null,
      hasScreenshot: !!body.screenshotDataUrl,
      endUserId: body.endUserId ?? null,
      messagePreview: message.slice(0, 80),
    });

    // Phase 2: persist to SQLite, store screenshot to volume, enforce budget/rate-limit.
    return c.json({ ok: true });
  });

  app.get('/projects/:pk/changelog', (c) => {
    // Phase 2: serve per-project changelog from DB.
    return c.json({ changelog: [] });
  });

  return app;
}
