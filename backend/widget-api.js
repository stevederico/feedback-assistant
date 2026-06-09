// Widget ingest API. Mounted at /v1 from server.js.
//
// Endpoints:
//   POST /v1/submissions               — accepts feedback, persists row
//   POST /v1/screenshots               — multipart upload, returns screenshotId
//   GET  /v1/projects/:pk/changelog    — public, published-only, sort_order
//   GET  /v1/projects/:pk/config       — public, per-project widget config (greeting)
//
// Auth model:
//   - All POSTs require X-Project-Key: pk_*  (looked up against Projects table)
//   - No session cookie, no CSRF — widget runs on arbitrary customer origins
//   - Origin header is logged but NOT enforced (it's spoofable from non-browsers)
//   - Rate limit + per-project daily budget land in step 5

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { ipRateLimit, enforceProjectBudget } from './feedback-rate-limit.js';
import {
  saveScreenshotFile,
  isAllowedMime,
  getMaxScreenshotBytes,
} from './feedback-uploads.js';

const MAX_MESSAGE_CHARS = 5000;

/**
 * Resolve a project row by its public key, or null.
 *
 * @param {Database} db
 * @param {string} publicKey
 */
function findProjectByKey(db, publicKey) {
  if (!publicKey || !publicKey.startsWith('pk_')) return null;
  return db.prepare('SELECT id, org_id, daily_budget, greeting FROM Projects WHERE public_key = ?').get(publicKey);
}

export function createWidgetApi({ logger, db } = {}) {
  const log = logger || { info: console.log, warn: console.warn, error: console.error };
  const app = new Hono();

  // Wide-open CORS for ingest — widgets run on customer origins.
  // Origin allowlist (per-project) is hygiene only; not enforced here.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-Project-Key'],
      credentials: false,
    })
  );

  // Per-IP token bucket applies to all ingest routes.
  app.use('/submissions', ipRateLimit());
  app.use('/screenshots', ipRateLimit());

  app.post('/submissions', async (c) => {
    const publicKey = c.req.header('X-Project-Key');
    const project = findProjectByKey(db, publicKey);
    if (!project) return c.json({ error: 'invalid or missing X-Project-Key' }, 401);

    // Per-project daily budget. Increments the counter; rejects if over.
    const overBudget = enforceProjectBudget(db, project.id, project.daily_budget, c);
    if (overBudget) return overBudget;

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'invalid json' }, 400);

    const message = (body.message ?? '').trim();
    if (!message) return c.json({ error: 'message required' }, 400);
    if (message.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `message must be ${MAX_MESSAGE_CHARS} characters or fewer` }, 413);
    }

    // Truncate or null incidental fields to keep storage bounded.
    const truncate = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
    const url = truncate(body.url, 2000);
    const userAgent = truncate(body.userAgent, 500);
    const appVersion = truncate(body.appVersion, 64);
    const endUserId = truncate(body.endUserId, 200);
    const endUserName = truncate(body.endUserName, 200);
    const endUserEmail = truncate(body.endUserEmail, 320);

    // Validate screenshotId, if provided, actually belongs to this project.
    let screenshotId = null;
    if (typeof body.screenshotId === 'string' && body.screenshotId) {
      const s = db
        .prepare('SELECT id FROM Screenshots WHERE id = ? AND project_id = ?')
        .get(body.screenshotId, project.id);
      if (!s) return c.json({ error: 'screenshotId not found for this project' }, 400);
      screenshotId = s.id;
    }

    const id = randomUUID();
    const now = Date.now();

    db.prepare(
      `INSERT INTO Submissions (
        id, project_id, message, url, user_agent, app_version,
        end_user_id, end_user_name, end_user_email, screenshot_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    ).run(
      id, project.id, message, url, userAgent, appVersion,
      endUserId, endUserName, endUserEmail, screenshotId, now
    );

    log.info('submission persisted', {
      submissionId: id,
      projectId: project.id,
      origin: c.req.header('Origin') || null,
      hasScreenshot: !!screenshotId,
      messagePreview: message.slice(0, 80),
    });

    return c.json({ ok: true, submissionId: id });
  });

  app.post('/screenshots', async (c) => {
    const publicKey = c.req.header('X-Project-Key');
    const project = findProjectByKey(db, publicKey);
    if (!project) return c.json({ error: 'invalid or missing X-Project-Key' }, 401);

    // Parse multipart. Hono returns a File-like object.
    let file;
    try {
      const form = await c.req.formData();
      file = form.get('file');
    } catch {
      return c.json({ error: 'invalid multipart body' }, 400);
    }
    if (!file || typeof file === 'string') {
      return c.json({ error: 'file field required' }, 400);
    }

    const mime = file.type || '';
    if (!isAllowedMime(mime)) {
      return c.json({ error: 'only image/jpeg or image/png allowed' }, 415);
    }

    const max = getMaxScreenshotBytes();
    if (file.size > max) {
      return c.json({ error: `file too large (max ${max} bytes)` }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let storedId;
    try {
      storedId = await saveScreenshotFile(buffer);
    } catch (e) {
      log.error('screenshot write failed', { error: e.message });
      return c.json({ error: 'storage error' }, 500);
    }

    const now = Date.now();
    db.prepare(
      `INSERT INTO Screenshots (id, project_id, content_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(storedId, project.id, mime, buffer.length, now);

    log.info('screenshot uploaded', {
      screenshotId: storedId,
      projectId: project.id,
      mime,
      bytes: buffer.length,
    });

    return c.json({ screenshotId: storedId });
  });

  app.get('/projects/:pk/config', (c) => {
    // Public per-project widget config. Mirrors the changelog endpoint's
    // no-leak posture: unknown keys get {greeting:null} (200, not 404).
    const project = findProjectByKey(db, c.req.param('pk'));
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ greeting: project?.greeting ?? null });
  });

  app.get('/projects/:pk/changelog', (c) => {
    const project = findProjectByKey(db, c.req.param('pk'));
    if (!project) return c.json({ changelog: [] }); // don't leak existence

    const rows = db
      .prepare(
        `SELECT id, title, body_md, published_at, sort_order
         FROM Changelog
         WHERE project_id = ? AND published_at IS NOT NULL
         ORDER BY sort_order ASC`
      )
      .all(project.id);

    return c.json({
      changelog: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body_md,
        publishedAt: r.published_at,
      })),
    });
  });

  return app;
}
