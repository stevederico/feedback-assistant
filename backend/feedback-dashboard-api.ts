// Dashboard API for feedback-assistant.
// Mounted under the existing /api/* namespace by server.ts.
// All routes require cookie session via authMiddleware; mutations require CSRF.
//
// Project CRUD scoping rule: every project belongs to exactly one Org.
// The signed-in user's org_id (from Users table) must match Projects.org_id
// or the request returns 404 (do not leak existence cross-tenant).

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { streamScreenshotResponse, deleteScreenshotFile } from './feedback-uploads.ts';
import type { Logger } from './types.ts';

/** Hono context environment shared with server.ts: authMiddleware sets userID. */
type AppEnv = { Variables: { userID: string } };

/** A single node:sqlite result row (column name -> output value). */
type Row = Record<string, unknown>;

/** Narrow an unknown JSON value to a plain object (key -> unknown). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ALLOWED_STATUSES = new Set(['new', 'read', 'archived']);

// ==== ROW COLUMN ACCESSORS ====
// node:sqlite returns rows as Record<string, SQLOutputValue>; these narrow a
// column to the expected primitive without `as` casts.

/** Read a string column; throws if the column is not a string. */
function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new Error(`expected string column "${column}"`);
}

/** Read a nullable string column (null/undefined pass through as null). */
function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new Error(`expected string|null column "${column}"`);
}

/** Read a numeric column (bigint coerced to number); throws if non-numeric. */
function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`expected number column "${column}"`);
}

/** Read a nullable numeric column (null/undefined pass through as null). */
function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`expected number|null column "${column}"`);
}

/**
 * Generate a public widget key: `pk_<32 random hex chars>`.
 */
function generatePublicKey(): string {
  return 'pk_' + randomBytes(16).toString('hex');
}

/**
 * Mask a public_key for list responses — show only first 5 + last 4 chars.
 * Avoids exposing the full key on every dashboard load.
 */
function maskKey(pk: string | null): string | null {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 5)}…${pk.slice(-4)}`;
}

/**
 * Resolve the signed-in user's org_id. If the user pre-dates the post-signup
 * org-creation hook (e.g. accounts created with an earlier deploy), lazily
 * create an org and link them in one transaction. Idempotent.
 */
function getUserOrgId(db: DatabaseSync, userID: string): string | null {
  const row = db.prepare('SELECT org_id, name, email FROM Users WHERE _id = ?').get(userID);
  if (!row) return null;
  const orgId = strOrNull(row, 'org_id');
  if (orgId) return orgId;

  // Backfill: user exists but has no org yet. Create one and link.
  const newOrgId = randomUUID();
  const orgName = `${strOrNull(row, 'name') || strOrNull(row, 'email') || 'My'}'s workspace`;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO Orgs (id, name, created_at) VALUES (?, ?, ?)').run(newOrgId, orgName, Date.now());
    db.prepare('UPDATE Users SET org_id = ? WHERE _id = ?').run(newOrgId, userID);
    db.exec('COMMIT');
    return newOrgId;
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Verify a project belongs to a user's org. Returns the project row or null.
 */
function getOrgProject(db: DatabaseSync, projectId: string, orgId: string): Row | null {
  return db
    .prepare('SELECT * FROM Projects WHERE id = ? AND org_id = ?')
    .get(projectId, orgId) ?? null;
}

/**
 * Map a joined Submissions+Projects list row to the dashboard JSON shape.
 * Expects columns from Submissions plus `project_name` from Projects.
 */
function mapSubmissionListRow(r: Row) {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    projectName: str(r, 'project_name'),
    message: str(r, 'message'),
    url: strOrNull(r, 'url'),
    endUserName: strOrNull(r, 'end_user_name'),
    endUserEmail: strOrNull(r, 'end_user_email'),
    screenshotId: strOrNull(r, 'screenshot_id'),
    status: str(r, 'status'),
    createdAt: num(r, 'created_at'),
  };
}

/**
 * Build shared list filters (status, q, from, to) for submissions queries.
 * Caller supplies the base WHERE clauses and params (project or org scope).
 */
function appendSubmissionListFilters(
  url: URL,
  where: string[],
  params: Array<string | number>,
): { limit: number; offset: number } {
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');
  const from = url.searchParams.get('from'); // ms
  const to = url.searchParams.get('to');     // ms
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

  if (status && ALLOWED_STATUSES.has(status)) {
    where.push('s.status = ?');
    params.push(status);
  }
  if (q && q.trim()) {
    where.push('(s.message LIKE ? OR s.end_user_name LIKE ? OR s.end_user_email LIKE ? OR s.url LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like);
  }
  if (from && /^\d+$/.test(from)) { where.push('s.created_at >= ?'); params.push(parseInt(from, 10)); }
  if (to && /^\d+$/.test(to))     { where.push('s.created_at <= ?'); params.push(parseInt(to, 10)); }

  return { limit, offset };
}

/** Options for {@link createFeedbackDashboardApi}. */
export interface FeedbackDashboardApiOptions {
  db: DatabaseSync;
  authMiddleware: MiddlewareHandler;
  csrfProtection: MiddlewareHandler;
  logger?: Logger;
  widgetVersion?: string | null;
  widgetIntegrity?: string | null;
}

/**
 * Extract a human-readable message from an unknown thrown value.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the feedback dashboard Hono sub-app (mounted under /api). */
export function createFeedbackDashboardApi({
  db,
  authMiddleware,
  csrfProtection,
  logger,
  widgetVersion = null,
  widgetIntegrity = null,
}: FeedbackDashboardApiOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // --- Widget bundle SRI (public; the dashboard renders it into the embed snippet) ---
  app.get('/widget-integrity', (c) => c.json({ version: widgetVersion, integrity: widgetIntegrity }));

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
        id: str(r, 'id'),
        name: str(r, 'name'),
        publicKey: maskKey(strOrNull(r, 'public_key')),
        allowedOrigins: strOrNull(r, 'allowed_origins'),
        dailyBudget: num(r, 'daily_budget'),
        greeting: strOrNull(r, 'greeting'),
        createdAt: num(r, 'created_at'),
      })),
    });
  });

  app.post('/projects', authMiddleware, csrfProtection, async (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ error: 'No org for user' }, 400);

    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const input = body;

    const name = (typeof input.name === 'string' ? input.name : '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    if (name.length > 200) return c.json({ error: 'name too long' }, 400);

    const allowedOrigins = typeof input.allowedOrigins === 'string'
      ? input.allowedOrigins.trim()
      : '';
    const dailyBudget = typeof input.dailyBudget === 'number' && Number.isFinite(input.dailyBudget)
      ? Math.max(1, Math.min(1_000_000, Math.floor(input.dailyBudget)))
      : 1000;
    const greeting = typeof input.greeting === 'string' ? input.greeting.slice(0, 500) : null;

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

    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const input = body;

    const updates: string[] = [];
    const values: Array<string | number | null> = [];

    if (typeof input.name === 'string') {
      const n = input.name.trim();
      if (!n || n.length > 200) return c.json({ error: 'invalid name' }, 400);
      updates.push('name = ?'); values.push(n);
    }
    if (typeof input.allowedOrigins === 'string') {
      updates.push('allowed_origins = ?'); values.push(input.allowedOrigins.trim());
    }
    if (typeof input.dailyBudget === 'number' && Number.isFinite(input.dailyBudget)) {
      const b = Math.max(1, Math.min(1_000_000, Math.floor(input.dailyBudget)));
      updates.push('daily_budget = ?'); values.push(b);
    }
    if (typeof input.greeting === 'string' || input.greeting === null) {
      updates.push('greeting = ?'); values.push(typeof input.greeting === 'string' ? input.greeting.slice(0, 500) : null);
    }

    if (!updates.length) return c.json({ error: 'nothing to update' }, 400);

    values.push(projectId);
    db.prepare(`UPDATE Projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = getOrgProject(db, projectId, orgId);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({
      id: str(updated, 'id'),
      name: str(updated, 'name'),
      publicKey: maskKey(strOrNull(updated, 'public_key')),
      allowedOrigins: strOrNull(updated, 'allowed_origins'),
      dailyBudget: num(updated, 'daily_budget'),
      greeting: strOrNull(updated, 'greeting'),
      createdAt: num(updated, 'created_at'),
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
      logger?.error?.('project delete failed', { projectId, error: errorMessage(e) });
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

  /**
   * Org-wide inbox (all projects). Register before /submissions/:id so
   * "submissions" is not captured as an id.
   */
  app.get('/submissions', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ submissions: [], total: 0, limit: 50, offset: 0 });

    const url = new URL(c.req.url);
    const where = ['p.org_id = ?'];
    const params: Array<string | number> = [orgId];
    const projectFilter = url.searchParams.get('projectId');
    if (projectFilter) {
      where.push('s.project_id = ?');
      params.push(projectFilter);
    }
    const { limit, offset } = appendSubmissionListFilters(url, where, params);

    const rows = db.prepare(
      `SELECT s.id, s.project_id, p.name AS project_name, s.message, s.url,
              s.end_user_name, s.end_user_email, s.screenshot_id, s.status, s.created_at
       FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const totalRow = db.prepare(
      `SELECT COUNT(*) AS n
       FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE ${where.join(' AND ')}`
    ).get(...params);
    const total = totalRow ? num(totalRow, 'n') : 0;

    return c.json({
      submissions: rows.map(mapSubmissionListRow),
      total,
      limit,
      offset,
    });
  });

  app.get('/projects/:id/submissions', authMiddleware, (c) => {
    const userID = c.get('userID');
    const orgId = getUserOrgId(db, userID);
    if (!orgId) return c.json({ submissions: [] });

    const projectId = c.req.param('id');
    const project = getOrgProject(db, projectId, orgId);
    if (!project) return c.json({ error: 'Not found' }, 404);

    const url = new URL(c.req.url);
    const where = ['s.project_id = ?'];
    const params: Array<string | number> = [projectId];
    const { limit, offset } = appendSubmissionListFilters(url, where, params);

    const rows = db.prepare(
      `SELECT s.id, s.project_id, p.name AS project_name, s.message, s.url,
              s.end_user_name, s.end_user_email, s.screenshot_id, s.status, s.created_at
       FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const totalRow = db.prepare(
      `SELECT COUNT(*) AS n FROM Submissions s WHERE ${where.join(' AND ')}`
    ).get(...params);
    const total = totalRow ? num(totalRow, 'n') : 0;

    return c.json({
      submissions: rows.map(mapSubmissionListRow),
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
      `SELECT s.*, p.org_id AS p_org_id, p.name AS project_name
       FROM Submissions s
       JOIN Projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.org_id = ?`
    ).get(id, orgId);
    if (!row) return c.json({ error: 'Not found' }, 404);

    return c.json({
      id: str(row, 'id'),
      projectId: str(row, 'project_id'),
      projectName: str(row, 'project_name'),
      message: str(row, 'message'),
      url: strOrNull(row, 'url'),
      userAgent: strOrNull(row, 'user_agent'),
      appVersion: strOrNull(row, 'app_version'),
      endUserId: strOrNull(row, 'end_user_id'),
      endUserName: strOrNull(row, 'end_user_name'),
      endUserEmail: strOrNull(row, 'end_user_email'),
      screenshotId: strOrNull(row, 'screenshot_id'),
      status: str(row, 'status'),
      createdAt: num(row, 'created_at'),
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

    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const input = body;

    if (typeof input.status !== 'string' || !ALLOWED_STATUSES.has(input.status)) {
      return c.json({ error: 'status must be new | read | archived' }, 400);
    }

    db.prepare('UPDATE Submissions SET status = ? WHERE id = ?').run(input.status, id);
    return c.json({ id, status: input.status });
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

    let screenshotFileId: string | null = null;
    const screenshotId = strOrNull(sub, 'screenshot_id');
    if (screenshotId) {
      // If this is the only submission referencing the screenshot, also remove
      // the screenshot row + file. Defensive: in MVP one-shot-per-submission
      // is the only flow, but the schema allows reuse so check first.
      const othersRow = db.prepare(
        'SELECT COUNT(*) AS n FROM Submissions WHERE screenshot_id = ? AND id != ?'
      ).get(screenshotId, id);
      const others = othersRow ? num(othersRow, 'n') : 0;
      if (others === 0) {
        screenshotFileId = screenshotId;
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
      logger?.error?.('submission delete failed', { id, error: errorMessage(e) });
      return c.json({ error: 'Delete failed' }, 500);
    }

    if (screenshotFileId) {
      await deleteScreenshotFile(screenshotFileId, logger);
    }

    return c.json({ ok: true });
  });

  // --- Changelog (admin CRUD; public read served from widget-api.ts) ---

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
        id: str(r, 'id'),
        title: str(r, 'title'),
        body: str(r, 'body_md'),
        sortOrder: num(r, 'sort_order'),
        publishedAt: numOrNull(r, 'published_at'),
        createdAt: num(r, 'created_at'),
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

    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const input = body;

    const title = (typeof input.title === 'string' ? input.title : '').trim();
    if (!title) return c.json({ error: 'title required' }, 400);
    if (title.length > 200) return c.json({ error: 'title too long' }, 400);

    const bodyMd = typeof input.body === 'string' ? input.body.slice(0, 50_000) : '';
    const publish = input.publish === true;

    // Append at the end. Caller can reorder via /reorder.
    const maxRow = db.prepare(
      'SELECT MAX(sort_order) AS m FROM Changelog WHERE project_id = ?'
    ).get(projectId);
    const sortOrder = (maxRow ? numOrNull(maxRow, 'm') ?? 0 : 0) + 1;
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

    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'Invalid JSON' }, 400);
    const input = body;

    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    if (typeof input.title === 'string') {
      const t = input.title.trim();
      if (!t || t.length > 200) return c.json({ error: 'invalid title' }, 400);
      updates.push('title = ?'); values.push(t);
    }
    if (typeof input.body === 'string') {
      updates.push('body_md = ?'); values.push(input.body.slice(0, 50_000));
    }
    if (typeof input.publish === 'boolean') {
      // Toggle published_at: set to now if publishing fresh, null if unpublishing.
      const newPublishedAt = input.publish
        ? (numOrNull(owned, 'published_at') ?? Date.now())
        : null;
      updates.push('published_at = ?'); values.push(newPublishedAt);
    }
    if (!updates.length) return c.json({ error: 'nothing to update' }, 400);

    values.push(id);
    db.prepare(`UPDATE Changelog SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare(
      'SELECT id, title, body_md, sort_order, published_at, created_at FROM Changelog WHERE id = ?'
    ).get(id);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({
      id: str(updated, 'id'),
      title: str(updated, 'title'),
      body: str(updated, 'body_md'),
      sortOrder: num(updated, 'sort_order'),
      publishedAt: numOrNull(updated, 'published_at'),
      createdAt: num(updated, 'created_at'),
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

    const body: unknown = await c.req.json().catch(() => null);
    const items = body && typeof body === 'object' && 'items' in body ? body.items : undefined;
    if (!Array.isArray(items)) return c.json({ error: 'items array required' }, 400);

    const upd = db.prepare(
      'UPDATE Changelog SET sort_order = ? WHERE id = ? AND project_id = ?'
    );
    db.exec('BEGIN');
    try {
      for (const item of items) {
        if (item && typeof item === 'object' && 'id' in item && 'sortOrder' in item) {
          const itemId = item.id;
          const itemSort = item.sortOrder;
          if (typeof itemId === 'string' && typeof itemSort === 'number' && Number.isFinite(itemSort)) {
            upd.run(Math.floor(itemSort), itemId, projectId);
          }
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      logger?.error?.('changelog reorder failed', { projectId, error: errorMessage(e) });
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

    const res = streamScreenshotResponse(str(row, 'id'), str(row, 'content_type'), num(row, 'size_bytes'));
    if (!res) return c.json({ error: 'File missing' }, 404);
    return res;
  });

  return app;
}
