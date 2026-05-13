// Dashboard API for feedback-assistant.
// Mounted under the existing /api/* namespace by server.js.
// All routes require cookie session via authMiddleware; mutations require CSRF.
//
// Project CRUD scoping rule: every project belongs to exactly one Org.
// The signed-in user's org_id (from Users table) must match Projects.org_id
// or the request returns 404 (do not leak existence cross-tenant).

import { Hono } from 'hono';
import { randomBytes, randomUUID } from 'node:crypto';
import { streamScreenshotResponse, deleteScreenshotFile } from './feedback-uploads.js';

const ALLOWED_STATUSES = new Set(['new', 'read', 'archived']);

/**
 * Generate a public widget key: `pk_<32 random hex chars>`.
 */
function generatePublicKey() {
  return 'pk_' + randomBytes(16).toString('hex');
}

/**
 * Mask a public_key for list responses — show only first 5 + last 4 chars.
 * Avoids exposing the full key on every dashboard load.
 */
function maskKey(pk) {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 5)}…${pk.slice(-4)}`;
}

/**
 * Resolve the signed-in user's org_id. If the user pre-dates the post-signup
 * org-creation hook (e.g. accounts created with an earlier deploy), lazily
 * create an org and link them in one transaction. Idempotent.
 */
function getUserOrgId(db, userID) {
  const row = db.prepare('SELECT org_id, name, email FROM Users WHERE _id = ?').get(userID);
  if (!row) return null;
  if (row.org_id) return row.org_id;

  // Backfill: user exists but has no org yet. Create one and link.
  const orgId = randomUUID();
  const orgName = `${row.name || row.email || 'My'}'s workspace`;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO Orgs (id, name, created_at) VALUES (?, ?, ?)').run(orgId, orgName, Date.now());
    db.prepare('UPDATE Users SET org_id = ? WHERE _id = ?').run(orgId, userID);
    db.exec('COMMIT');
    return orgId;
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Verify a project belongs to a user's org. Returns the project row or null.
 */
function getOrgProject(db, projectId, orgId) {
  return db
    .prepare('SELECT * FROM Projects WHERE id = ? AND org_id = ?')
    .get(projectId, orgId);
}

export function createFeedbackDashboardApi({ db, authMiddleware, csrfProtection, logger }) {
  const app = new Hono();

  // --- Projects ---

  app.get('/projects', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ projects: [] });

    const rows = db
      .prepare(
        `SELECT id, name, public_key, allowed_origins, daily_budget, greeting, created_at
         FROM Projects WHERE org_id = ? ORDER BY created_at DESC`
      )
      .all(orgId);

    return c.json({
      projects: rows.map((r) => ({
        id: r.id,
        name: r.name,
        publicKey: maskKey(r.public_key),
        allowedOrigins: r.allowed_origins,
        dailyBudget: r.daily_budget,
        greeting: r.greeting,
        createdAt: r.created_at,
      })),
    });
  });

  app.post('/projects', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'No org for user' }, 400);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON' }, 400);

    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    if (name.length > 200) return c.json({ error: 'name too long' }, 400);

    const allowedOrigins = typeof body.allowedOrigins === 'string'
      ? body.allowedOrigins.trim()
      : '';
    const dailyBudget = Number.isFinite(body.dailyBudget)
      ? Math.max(1, Math.min(1_000_000, Math.floor(body.dailyBudget)))
      : 1000;
    const greeting = typeof body.greeting === 'string' ? body.greeting.slice(0, 500) : null;

    const id = randomUUID();
    const publicKey = generatePublicKey();
    const now = Date.now();

    db.prepare(
      `INSERT INTO Projects (id, org_id, name, public_key, allowed_origins, daily_budget, greeting, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, name, publicKey, allowedOrigins, dailyBudget, greeting, now);

    logger?.info?.('project created', { projectId: id, orgId });

    // Stripe-style: full key returned once on creation; subsequent reads are masked.
    return c.json({
      id,
      name,
      publicKey,
      allowedOrigins,
      dailyBudget,
      greeting,
      createdAt: now,
    }, 201);
  });

  app.patch('/projects/:id', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Not found' }, 404);

    const projectId = c.req.param('id');
    const existing = getOrgProject(db, projectId, orgId);
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON' }, 400);

    const updates = [];
    const values = [];

    if (typeof body.name === 'string') {
      const n = body.name.trim();
      if (!n || n.length > 200) return c.json({ error: 'invalid name' }, 400);
      updates.push('name = ?'); values.push(n);
    }
    if (typeof body.allowedOrigins === 'string') {
      updates.push('allowed_origins = ?'); values.push(body.allowedOrigins.trim());
    }
    if (Number.isFinite(body.dailyBudget)) {
      const b = Math.max(1, Math.min(1_000_000, Math.floor(body.dailyBudget)));
      updates.push('daily_budget = ?'); values.push(b);
    }
    if (typeof body.greeting === 'string' || body.greeting === null) {
      updates.push('greeting = ?'); values.push(body.greeting ? body.greeting.slice(0, 500) : null);
    }

    if (!updates.length) return c.json({ error: 'nothing to update' }, 400);

    values.push(projectId);
    db.prepare(`UPDATE Projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = getOrgProject(db, projectId, orgId);
    return c.json({
      id: updated.id,
      name: updated.name,
      publicKey: maskKey(updated.public_key),
      allowedOrigins: updated.allowed_origins,
      dailyBudget: updated.daily_budget,
      greeting: updated.greeting,
      createdAt: updated.created_at,
    });
  });

  app.delete('/projects/:id', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Not found' }, 404);

    const projectId = c.req.param('id');
    const existing = getOrgProject(db, projectId, orgId);
    if (!existing) return c.json({ error: 'Not found' }, 404);

    db.exec('BEGIN');
    try {
      // Phase 2 step 6 (uploads) will need to unlink files for screenshots
      // tied to this project — for now, just clear DB rows. We'll wire the
      // file cleanup when the upload module lands.
      db.prepare('DELETE FROM Submissions WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM Screenshots WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM Changelog WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM DailyIngest WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM Projects WHERE id = ?').run(projectId);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      logger?.error?.('project delete failed', { projectId, error: e.message });
      return c.json({ error: 'Delete failed' }, 500);
    }

    return c.json({ ok: true });
  });

  app.post('/projects/:id/rotate-key', authMiddleware, csrfProtection, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Not found' }, 404);

    const projectId = c.req.param('id');
    const existing = getOrgProject(db, projectId, orgId);
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const newKey = generatePublicKey();
    db.prepare('UPDATE Projects SET public_key = ? WHERE id = ?').run(newKey, projectId);

    logger?.info?.('project key rotated', { projectId });
    // Returned once, in full, just like initial creation.
    return c.json({ id: projectId, publicKey: newKey });
  });

  // --- Submissions ---

  app.get('/projects/:id/submissions', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ submissions: [] });

    const projectId = c.req.param('id');
    const project = getOrgProject(db, projectId, orgId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const url = new URL(c.req.url);
    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');
    const from = url.searchParams.get('from'); // ms
    const to = url.searchParams.get('to');     // ms
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

    const where = ['project_id = ?'];
    const params = [projectId];
    if (status && ALLOWED_STATUSES.has(status)) {
      where.push('status = ?'); params.push(status);
    }
    if (q && q.trim()) {
      where.push('(message LIKE ? OR end_user_name LIKE ? OR end_user_email LIKE ? OR url LIKE ?)');
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like);
    }
    if (from && /^\d+$/.test(from)) { where.push('created_at >= ?'); params.push(parseInt(from, 10)); }
    if (to && /^\d+$/.test(to))     { where.push('created_at <= ?'); params.push(parseInt(to, 10)); }

    const rows = db.prepare(
      `SELECT id, message, url, end_user_name, end_user_email, screenshot_id, status, created_at
       FROM Submissions
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM Submissions WHERE ${where.join(' AND ')}`
    ).get(...params).n;

    return c.json({
      submissions: rows.map((r) => ({
        id: r.id,
        message: r.message,
        url: r.url,
        endUserName: r.end_user_name,
        endUserEmail: r.end_user_email,
        screenshotId: r.screenshot_id,
        status: r.status,
        createdAt: r.created_at,
      })),
      total,
      limit,
      offset,
    });
  });

  app.get('/submissions/:id', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const row = db.prepare(
      `SELECT s.*, p.org_id AS p_org_id
       FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!row) return c.json({ error: 'Not found' }, 404);

    return c.json({
      id: row.id,
      projectId: row.project_id,
      message: row.message,
      url: row.url,
      userAgent: row.user_agent,
      appVersion: row.app_version,
      endUserId: row.end_user_id,
      endUserName: row.end_user_name,
      endUserEmail: row.end_user_email,
      screenshotId: row.screenshot_id,
      status: row.status,
      createdAt: row.created_at,
    });
  });

  app.patch('/submissions/:id', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const owned = db.prepare(
      `SELECT s.id FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!owned) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON' }, 400);

    if (typeof body.status !== 'string' || !ALLOWED_STATUSES.has(body.status)) {
      return c.json({ error: 'status must be new | read | archived' }, 400);
    }

    db.prepare('UPDATE Submissions SET status = ? WHERE id = ?').run(body.status, id);
    return c.json({ id, status: body.status });
  });

  app.delete('/submissions/:id', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const sub = db.prepare(
      `SELECT s.id, s.screenshot_id FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!sub) return c.json({ error: 'Not found' }, 404);

    let screenshotFileId = null;
    if (sub.screenshot_id) {
      // If this is the only submission referencing the screenshot, also remove
      // the screenshot row + file. Defensive: in MVP one-shot-per-submission
      // is the only flow, but the schema allows reuse so check first.
      const others = db.prepare(
        'SELECT COUNT(*) AS n FROM Submissions WHERE screenshot_id = ? AND id != ?'
      ).get(sub.screenshot_id, id).n;
      if (others === 0) {
        screenshotFileId = sub.screenshot_id;
      }
    }

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM Submissions WHERE id = ?').run(id);
      if (screenshotFileId) {
        db.prepare('DELETE FROM Screenshots WHERE id = ?').run(screenshotFileId);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      logger?.error?.('submission delete failed', { id, error: e.message });
      return c.json({ error: 'Delete failed' }, 500);
    }

    if (screenshotFileId) {
      await deleteScreenshotFile(screenshotFileId, logger);
    }

    return c.json({ ok: true });
  });

  // --- Changelog (admin CRUD; public read served from widget-api.js) ---

  app.get('/projects/:id/changelog', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ changelog: [] });

    const projectId = c.req.param('id');
    const project = getOrgProject(db, projectId, orgId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const rows = db.prepare(
      `SELECT id, title, body_md, sort_order, published_at, created_at
       FROM Changelog WHERE project_id = ? ORDER BY sort_order ASC`
    ).all(projectId);

    return c.json({
      changelog: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body_md,
        sortOrder: r.sort_order,
        publishedAt: r.published_at,
        createdAt: r.created_at,
      })),
    });
  });

  app.post('/projects/:id/changelog', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const projectId = c.req.param('id');
    const project = getOrgProject(db, projectId, orgId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON' }, 400);

    const title = (body.title ?? '').trim();
    if (!title) return c.json({ error: 'title required' }, 400);
    if (title.length > 200) return c.json({ error: 'title too long' }, 400);

    const bodyMd = typeof body.body === 'string' ? body.body.slice(0, 50_000) : '';
    const publish = body.publish === true;

    // Append at the end. Caller can reorder via /reorder.
    const maxRow = db.prepare(
      'SELECT MAX(sort_order) AS m FROM Changelog WHERE project_id = ?'
    ).get(projectId);
    const sortOrder = (maxRow?.m ?? 0) + 1;
    const id = randomUUID();
    const now = Date.now();

    db.prepare(
      `INSERT INTO Changelog (id, project_id, title, body_md, sort_order, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, title, bodyMd, sortOrder, publish ? now : null, now);

    return c.json({
      id, title, body: bodyMd, sortOrder,
      publishedAt: publish ? now : null,
      createdAt: now,
    }, 201);
  });

  app.patch('/changelog/:id', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const owned = db.prepare(
      `SELECT cl.id, cl.project_id, cl.published_at FROM Changelog cl
       JOIN Projects p ON p.id = cl.project_id
       WHERE cl.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!owned) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'Invalid JSON' }, 400);

    const updates = [];
    const values = [];
    if (typeof body.title === 'string') {
      const t = body.title.trim();
      if (!t || t.length > 200) return c.json({ error: 'invalid title' }, 400);
      updates.push('title = ?'); values.push(t);
    }
    if (typeof body.body === 'string') {
      updates.push('body_md = ?'); values.push(body.body.slice(0, 50_000));
    }
    if (typeof body.publish === 'boolean') {
      // Toggle published_at: set to now if publishing fresh, null if unpublishing.
      const newPublishedAt = body.publish
        ? (owned.published_at ?? Date.now())
        : null;
      updates.push('published_at = ?'); values.push(newPublishedAt);
    }
    if (!updates.length) return c.json({ error: 'nothing to update' }, 400);

    values.push(id);
    db.prepare(`UPDATE Changelog SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare(
      'SELECT id, title, body_md, sort_order, published_at, created_at FROM Changelog WHERE id = ?'
    ).get(id);
    return c.json({
      id: updated.id,
      title: updated.title,
      body: updated.body_md,
      sortOrder: updated.sort_order,
      publishedAt: updated.published_at,
      createdAt: updated.created_at,
    });
  });

  app.delete('/changelog/:id', authMiddleware, csrfProtection, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const owned = db.prepare(
      `SELECT cl.id FROM Changelog cl
       JOIN Projects p ON p.id = cl.project_id
       WHERE cl.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!owned) return c.json({ error: 'Not found' }, 404);

    db.prepare('DELETE FROM Changelog WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // Reorder: dashboard sends [{id, sortOrder}] after a drag-drop. Updates run in
  // a single transaction. Org-scoped — silently ignores ids not owned by org.
  app.post('/projects/:id/changelog/reorder', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const projectId = c.req.param('id');
    const project = getOrgProject(db, projectId, orgId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.items)) return c.json({ error: 'items array required' }, 400);

    const upd = db.prepare(
      'UPDATE Changelog SET sort_order = ? WHERE id = ? AND project_id = ?'
    );
    db.exec('BEGIN');
    try {
      for (const item of body.items) {
        if (typeof item?.id === 'string' && Number.isFinite(item?.sortOrder)) {
          upd.run(Math.floor(item.sortOrder), item.id, projectId);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      logger?.error?.('changelog reorder failed', { projectId, error: e.message });
      return c.json({ error: 'Reorder failed' }, 500);
    }
    return c.json({ ok: true });
  });

  // --- Screenshots (auth-gated stream) ---

  app.get('/screenshots/:id', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    // Join through Projects to verify the screenshot belongs to the user's org.
    const row = db.prepare(
      `SELECT s.id, s.content_type, s.size_bytes
       FROM Screenshots s
       JOIN Projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!row) return c.json({ error: 'Forbidden' }, 403);

    const res = streamScreenshotResponse(row.id, row.content_type, row.size_bytes);
    if (!res) return c.json({ error: 'File missing' }, 404);
    return res;
  });

  return app;
}
