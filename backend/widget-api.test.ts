// Tests for the widget ingest API (mounted at /v1) and the dashboard
// widget-integrity endpoint. Uses node:test + an in-memory node:sqlite DB.
//
// Run via: node --test (see package.json)

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Screenshots are written to disk — point uploads at a temp dir before the
// uploads module resolves its cached directory.
process.env.UPLOADS_DIR = resolve(tmpdir(), `fa-test-uploads-${process.pid}`);

import { DatabaseSync } from 'node:sqlite';
import type { Hono, MiddlewareHandler } from 'hono';
import { bootstrapFeedbackSchema } from './feedback-schema.ts';
import { createWidgetApi } from './widget-api.ts';
import { createFeedbackDashboardApi } from './feedback-dashboard-api.ts';
import { parseAllowedOrigins, isOriginAllowed } from './feedback-origin.ts';
import { ensureUploadsDir, getUploadsDir } from './feedback-uploads.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PK = 'pk_testkey0000000000000000000000aa';
const OTHER_PK = 'pk_otherkey0000000000000000000000bb';

let app: Hono;
let testDb: DatabaseSync;

/** Read a string column off a node:sqlite row without an `as` cast. */
function stringColumn(row: Record<string, unknown> | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value === 'string') return value;
  throw new Error(`expected string column "${column}"`);
}

/** True when an unknown value is a plain object (key -> unknown). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown JSON response body to a plain object. */
function asBody(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error('expected a JSON object response body');
}

before(() => {
  const db = new DatabaseSync(':memory:');
  // Skateboard normally creates Users; the feedback schema only ALTERs it.
  db.exec('CREATE TABLE IF NOT EXISTS Users (_id TEXT PRIMARY KEY, email TEXT, name TEXT, created_at INTEGER)');
  bootstrapFeedbackSchema(db);

  const now = Date.now();
  db.prepare('INSERT INTO Orgs (id, name, created_at) VALUES (?, ?, ?)').run('org1', 'Org One', now);
  db.prepare('INSERT INTO Orgs (id, name, created_at) VALUES (?, ?, ?)').run('org2', 'Org Two', now);
  db.prepare(
    'INSERT INTO Apps (id, org_id, name, public_key, daily_budget, greeting, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('proj1', 'org1', 'Proj One', PK, 1000, 'Hey there!', now);
  db.prepare(
    'INSERT INTO Apps (id, org_id, name, public_key, daily_budget, greeting, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('proj2', 'org2', 'Proj Two', OTHER_PK, 1000, null, now);

  app = createWidgetApi({ logger: { info() {}, warn() {}, error() {}, debug() {} }, db });
  testDb = db;
});

test('GET /v1/projects/:pk/widget returns greeting for a valid key', async () => {
  const res = await app.request(`/projects/${PK}/widget`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const body = asBody(await res.json());
  assert.equal(body.greeting, 'Hey there!');
});

test('GET /v1/projects/:pk/widget returns null greeting for an unknown key (no leak)', async () => {
  const res = await app.request('/projects/pk_does_not_exist/widget');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  assert.equal(body.greeting, null);
});

test('POST /v1/screenshots then /v1/submissions persists screenshot_id', async () => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'shot.png');
  const up = await app.request('/screenshots', {
    method: 'POST',
    headers: { 'X-Project-Key': PK },
    body: form,
  });
  assert.equal(up.status, 200);
  const { screenshotId } = asBody(await up.json());
  assert.ok(screenshotId);

  const sub = await app.request('/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project-Key': PK },
    body: JSON.stringify({ message: 'with shot', screenshotId }),
  });
  assert.equal(sub.status, 200);
  const { submissionId } = asBody(await sub.json());
  assert.equal(typeof submissionId, 'string');

  const row = testDb.prepare('SELECT screenshot_id FROM Submissions WHERE id = ?').get(String(submissionId));
  assert.equal(stringColumn(row, 'screenshot_id'), screenshotId);
});

test('POST /v1/submissions rejects a screenshotId from another project', async () => {
  // Upload a screenshot under OTHER_PK (org2), then try to attach it via PK (org1).
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' }), 'shot.png');
  const up = await app.request('/screenshots', {
    method: 'POST',
    headers: { 'X-Project-Key': OTHER_PK },
    body: form,
  });
  const { screenshotId } = asBody(await up.json());

  const sub = await app.request('/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project-Key': PK },
    body: JSON.stringify({ message: 'cross-project', screenshotId }),
  });
  assert.equal(sub.status, 400);
});

test('POST /v1/submissions requires a valid X-Project-Key', async () => {
  const res = await app.request('/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project-Key': 'nope' },
    body: JSON.stringify({ message: 'hi' }),
  });
  assert.equal(res.status, 401);
});

test('GET /api/widget-integrity returns version + integrity', async () => {
  const passthrough: MiddlewareHandler = (_c, next) => next();
  const dash = createFeedbackDashboardApi({
    db: testDb,
    authMiddleware: passthrough,
    csrfProtection: passthrough,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    widgetVersion: '9.9.9',
    widgetIntegrity: 'sha384-deadbeef',
  });
  const res = await dash.request('/widget-integrity');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  assert.equal(body.version, '9.9.9');
  assert.equal(body.integrity, 'sha384-deadbeef');
});

/**
 * Build a dashboard app with auth that always resolves to a fixed user.
 * Seeds that user into Users with the given org so org-scoped routes work.
 */
function dashboardForUser(userId: string, orgId: string) {
  const now = Date.now();
  testDb.prepare(
    'INSERT OR IGNORE INTO Users (_id, email, name, created_at, org_id) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@example.com`, userId, now, orgId);

  const authAsUser: MiddlewareHandler = async (c, next) => {
    c.set('userID', userId);
    await next();
  };
  return createFeedbackDashboardApi({
    db: testDb,
    authMiddleware: authAsUser,
    csrfProtection: async (_c, next) => next(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

test('GET /apps/:id/submissions includes appId and appName', async () => {
  const now = Date.now();
  testDb.prepare(
    `INSERT INTO Submissions (id, app_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-list-1', 'proj1', 'hello from list', 'new', now);

  const dash = dashboardForUser('user-org1', 'org1');
  const res = await dash.request('/apps/proj1/submissions');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  const list = body.submissions;
  assert.ok(Array.isArray(list));
  const first = list.find((s) => isRecord(s) && s.id === 'sub-list-1');
  assert.ok(isRecord(first));
  assert.equal(first.appId, 'proj1');
  assert.equal(first.appName, 'Proj One');
  assert.equal(first.message, 'hello from list');
});

test('GET /submissions lists org-wide and tags each row with appName', async () => {
  const now = Date.now();
  // Second project in the same org so org-wide has mixed sources.
  testDb.prepare(
    `INSERT OR IGNORE INTO Apps (id, org_id, name, public_key, daily_budget, greeting, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('proj1b', 'org1', 'Proj One B', 'pk_proj1b0000000000000000000000cc', 1000, null, now);
  testDb.prepare(
    `INSERT INTO Submissions (id, app_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-org-a', 'proj1', 'from A', 'new', now);
  testDb.prepare(
    `INSERT INTO Submissions (id, app_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-org-b', 'proj1b', 'from B', 'new', now + 1);

  const dash = dashboardForUser('user-org1b', 'org1');
  const res = await dash.request('/submissions');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  const list = body.submissions;
  assert.ok(Array.isArray(list));
  const byId = new Map(
    list.filter(isRecord).map((s) => [String(s.id), s]),
  );
  assert.equal(byId.get('sub-org-a')?.appName, 'Proj One');
  assert.equal(byId.get('sub-org-b')?.appName, 'Proj One B');
});

test('GET /submissions/:id includes appName', async () => {
  const now = Date.now();
  testDb.prepare(
    `INSERT INTO Submissions (id, app_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-detail-1', 'proj1', 'detail me', 'new', now);

  const dash = dashboardForUser('user-org1c', 'org1');
  const res = await dash.request('/submissions/sub-detail-1');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  assert.equal(body.appId, 'proj1');
  assert.equal(body.appName, 'Proj One');
  assert.equal(body.message, 'detail me');
});

test('widget source builds DOM without innerHTML (Trusted-Types safe)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'widget', 'src', 'index.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(src), 'widget/src/index.js must not assign .innerHTML');
});

describe('feedback-origin helpers', () => {
  test('empty CSV means allow all', () => {
    assert.equal(parseAllowedOrigins(''), null);
    assert.equal(parseAllowedOrigins('  ,  '), null);
    assert.equal(parseAllowedOrigins(null), null);
    assert.equal(isOriginAllowed('https://evil.com', null), true);
    assert.equal(isOriginAllowed(undefined, null), true);
  });

  test('exact origin match', () => {
    const allowed = parseAllowedOrigins('https://app.example.com, https://staging.example.com');
    assert.ok(allowed);
    assert.equal(isOriginAllowed('https://app.example.com', allowed), true);
    assert.equal(isOriginAllowed('https://evil.com', allowed), false);
    assert.equal(isOriginAllowed(undefined, allowed), false);
  });

  test('wildcard host pattern', () => {
    const allowed = parseAllowedOrigins('*.example.com');
    assert.ok(allowed);
    assert.equal(isOriginAllowed('https://foo.example.com', allowed), true);
    assert.equal(isOriginAllowed('https://example.com', allowed), true);
    assert.equal(isOriginAllowed('https://evil.com', allowed), false);
    assert.equal(isOriginAllowed('https://evil-example.com', allowed), false);
  });
});

describe('origin allowlist on /v1', () => {
  const RESTRICT_PK = 'pk_restrict00000000000000000000rr';

  before(() => {
    const now = Date.now();
    testDb.prepare(
      `INSERT OR IGNORE INTO Apps
       (id, org_id, name, public_key, allowed_origins, daily_budget, greeting, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'proj-restrict',
      'org1',
      'Restricted',
      RESTRICT_PK,
      'https://app.example.com, *.good.com',
      1000,
      null,
      now,
    );
  });

  test('empty allowlist still accepts foreign Origin', async () => {
    const res = await app.request('/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': PK,
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ message: 'from anywhere' }),
    });
    assert.equal(res.status, 200);
  });

  test('matching Origin is allowed', async () => {
    const res = await app.request('/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': RESTRICT_PK,
        Origin: 'https://app.example.com',
      },
      body: JSON.stringify({ message: 'allowed host' }),
    });
    assert.equal(res.status, 200);
  });

  test('wildcard matching Origin is allowed', async () => {
    const res = await app.request('/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': RESTRICT_PK,
        Origin: 'https://shop.good.com',
      },
      body: JSON.stringify({ message: 'wildcard ok' }),
    });
    assert.equal(res.status, 200);
  });

  test('foreign Origin is 403', async () => {
    const res = await app.request('/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': RESTRICT_PK,
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ message: 'nope' }),
    });
    assert.equal(res.status, 403);
    const body = asBody(await res.json());
    assert.equal(body.error, 'origin not allowed');
  });

  test('missing Origin with non-empty allowlist is 403', async () => {
    const res = await app.request('/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': RESTRICT_PK,
      },
      body: JSON.stringify({ message: 'no origin' }),
    });
    assert.equal(res.status, 403);
  });

  test('changelog GET enforces allowlist', async () => {
    const bad = await app.request(`/projects/${RESTRICT_PK}/changelog`, {
      headers: { Origin: 'https://evil.com' },
    });
    assert.equal(bad.status, 403);
    const good = await app.request(`/projects/${RESTRICT_PK}/changelog`, {
      headers: { Origin: 'https://app.example.com' },
    });
    assert.equal(good.status, 200);
  });
});

test('DELETE /apps/:id unlinks screenshot files on disk', async () => {
  const now = Date.now();
  const shotId = 'shot-cleanup-file-001';
  const projId = 'proj-cleanup-files';
  const pk = 'pk_cleanup0000000000000000000000zz';

  await ensureUploadsDir();
  const dir = getUploadsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, shotId);
  writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  testDb.prepare(
    `INSERT INTO Apps (id, org_id, name, public_key, daily_budget, greeting, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(projId, 'org1', 'Cleanup', pk, 1000, null, now);
  testDb.prepare(
    `INSERT INTO Screenshots (id, app_id, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(shotId, projId, 'image/png', 4, now);

  assert.equal(existsSync(filePath), true);

  const dash = dashboardForUser('user-cleanup', 'org1');
  const res = await dash.request(`/apps/${projId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(existsSync(filePath), false);
  const gone = testDb.prepare('SELECT id FROM Apps WHERE id = ?').get(projId);
  assert.equal(gone, undefined);
});
