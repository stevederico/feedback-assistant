// Widget ingest API. Mounted at /v1 from server.ts.
//
// Endpoints:
//   POST /v1/submissions               — accepts feedback, persists row
//   POST /v1/screenshots               — multipart upload, returns screenshotId
//   GET  /v1/projects/:pk/changelog    — public, published-only, sort_order
//   GET  /v1/projects/:pk/widget        — public, per-project widget config (greeting)
//
// Auth model:
//   - All POSTs require X-Project-Key: pk_*  (looked up against Projects table)
//   - No session cookie, no CSRF — widget runs on arbitrary customer origins
//   - Per-project allowed_origins enforced when non-empty (empty = allow all)
//   - Rate limit + per-project daily budget

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ipRateLimit, enforceProjectBudget } from './feedback-rate-limit.ts';
import {
  saveScreenshotFile,
  isAllowedMime,
  getMaxScreenshotBytes,
} from './feedback-uploads.ts';
import { parseAllowedOrigins, isOriginAllowed } from './feedback-origin.ts';
import type { Logger } from './types.ts';

const MAX_MESSAGE_CHARS = 5000;

/** A project row resolved from its public key. */
interface ProjectKeyRow {
  id: string;
  org_id: string;
  daily_budget: number;
  greeting: string | null;
  /** Raw CSV from Projects.allowed_origins. */
  allowed_origins: string;
}

/** A single node:sqlite result row (column name -> output value). */
type Row = Record<string, unknown>;

/** Narrow an unknown JSON value to a plain object (key -> unknown). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string column off a node:sqlite row without an `as` cast. */
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

/**
 * Resolve a project row by its public key, or null.
 */
function findProjectByKey(db: DatabaseSync, publicKey: string | undefined): ProjectKeyRow | null {
  if (!publicKey || !publicKey.startsWith('pk_')) return null;
  const row = db.prepare(
    'SELECT id, org_id, daily_budget, greeting, allowed_origins FROM Projects WHERE public_key = ?',
  ).get(publicKey);
  if (!row) return null;
  return {
    id: str(row, 'id'),
    org_id: str(row, 'org_id'),
    daily_budget: num(row, 'daily_budget'),
    greeting: strOrNull(row, 'greeting'),
    allowed_origins: strOrNull(row, 'allowed_origins') ?? '',
  };
}

/**
 * 403 when the project has a non-empty allowlist and Origin is not listed.
 * Empty allowlist = allow all (including missing Origin).
 *
 * @returns A Response to return, or null when the request may proceed
 */
function rejectIfOriginBlocked(
  c: { req: { header: (name: string) => string | undefined } },
  project: ProjectKeyRow,
  log: Logger,
): Response | null {
  const allowed = parseAllowedOrigins(project.allowed_origins);
  const origin = c.req.header('Origin') ?? null;
  if (isOriginAllowed(origin, allowed)) return null;
  log.warn?.('widget origin rejected', {
    projectId: project.id,
    origin,
  });
  return Response.json({ error: 'origin not allowed' }, { status: 403 });
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Truncate a string-ish value to a max length, or null when not a string. */
function truncate(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

/** Options for {@link createWidgetApi}. */
export interface WidgetApiOptions {
  logger?: Logger;
  db: DatabaseSync;
}

/** Build the widget ingest Hono sub-app (mounted at /v1). */
export function createWidgetApi({ logger, db }: WidgetApiOptions): Hono {
  const log: Logger = logger || {
    info: (message, meta) => console.log(message, meta),
    warn: (message, meta) => console.warn(message, meta),
    error: (message, meta) => console.error(message, meta),
    debug: (message, meta) => console.debug(message, meta),
  };
  const app = new Hono();

  // CORS stays wide open (credentials: false). Per-project allowlist is
  // enforced after key lookup via rejectIfOriginBlocked (app-level 403).
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
    const blocked = rejectIfOriginBlocked(c, project, log);
    if (blocked) return blocked;

    // Per-project daily budget. Increments the counter; rejects if over.
    const overBudget = enforceProjectBudget(db, project.id, project.daily_budget, c);
    if (overBudget) return overBudget;

    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'invalid json' }, 400);
    const input = body;

    const message = (typeof input.message === 'string' ? input.message : '').trim();
    if (!message) return c.json({ error: 'message required' }, 400);
    if (message.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `message must be ${MAX_MESSAGE_CHARS} characters or fewer` }, 413);
    }

    // Truncate or null incidental fields to keep storage bounded.
    const url = truncate(input.url, 2000);
    const userAgent = truncate(input.userAgent, 500);
    const appVersion = truncate(input.appVersion, 64);
    const endUserId = truncate(input.endUserId, 200);
    const endUserName = truncate(input.endUserName, 200);
    const endUserEmail = truncate(input.endUserEmail, 320);

    // Validate screenshotId, if provided, actually belongs to this project.
    let screenshotId: string | null = null;
    if (typeof input.screenshotId === 'string' && input.screenshotId) {
      const s = db
        .prepare('SELECT id FROM Screenshots WHERE id = ? AND project_id = ?')
        .get(input.screenshotId, project.id);
      if (!s) return c.json({ error: 'screenshotId not found for this project' }, 400);
      screenshotId = str(s, 'id');
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
    const blocked = rejectIfOriginBlocked(c, project, log);
    if (blocked) return blocked;

    // Parse multipart. Hono returns a File-like object.
    let file: File | string | null = null;
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

    let storedId: string;
    try {
      storedId = await saveScreenshotFile(buffer);
    } catch (e) {
      log.error('screenshot write failed', { error: errorMessage(e) });
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

  app.get('/projects/:pk/widget', (c) => {
    // Public per-project widget config (greeting). Named /widget rather than
    // /config because Cloudflare's WAF blocks any path containing "config".
    // Mirrors the changelog endpoint's no-leak posture: unknown keys get
    // {greeting:null} (200, not 404). Known keys still enforce origin allowlist.
    const project = findProjectByKey(db, c.req.param('pk'));
    c.header('Cache-Control', 'public, max-age=60');
    if (!project) return c.json({ greeting: null });
    const blocked = rejectIfOriginBlocked(c, project, log);
    if (blocked) return blocked;
    return c.json({ greeting: project.greeting ?? null });
  });

  app.get('/projects/:pk/changelog', (c) => {
    const project = findProjectByKey(db, c.req.param('pk'));
    if (!project) return c.json({ changelog: [] }); // don't leak existence
    const blocked = rejectIfOriginBlocked(c, project, log);
    if (blocked) return blocked;

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
        id: str(r, 'id'),
        title: str(r, 'title'),
        body: str(r, 'body_md'),
        publishedAt: num(r, 'published_at'),
      })),
    });
  });

  return app;
}
