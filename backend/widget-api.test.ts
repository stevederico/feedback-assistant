// Tests for the widget ingest API (mounted at /v1) and the dashboard
// widget-integrity endpoint. Uses node:test + an in-memory node:sqlite DB.
//
// Run via: node --test (see package.json)

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
    'INSERT INTO Projects (id, org_id, name, public_key, daily_budget, greeting, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('proj1', 'org1', 'Proj One', PK, 1000, 'Hey there!', now);
  db.prepare(
    'INSERT INTO Projects (id, org_id, name, public_key, daily_budget, greeting, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
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

test('GET /projects/:id/submissions includes projectId and projectName', async () => {
  const now = Date.now();
  testDb.prepare(
    `INSERT INTO Submissions (id, project_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-list-1', 'proj1', 'hello from list', 'new', now);

  const dash = dashboardForUser('user-org1', 'org1');
  const res = await dash.request('/projects/proj1/submissions');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  const list = body.submissions;
  assert.ok(Array.isArray(list));
  const first = list.find((s) => isRecord(s) && s.id === 'sub-list-1');
  assert.ok(isRecord(first));
  assert.equal(first.projectId, 'proj1');
  assert.equal(first.projectName, 'Proj One');
  assert.equal(first.message, 'hello from list');
});

test('GET /submissions lists org-wide and tags each row with projectName', async () => {
  const now = Date.now();
  // Second project in the same org so org-wide has mixed sources.
  testDb.prepare(
    `INSERT OR IGNORE INTO Projects (id, org_id, name, public_key, daily_budget, greeting, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('proj1b', 'org1', 'Proj One B', 'pk_proj1b0000000000000000000000cc', 1000, null, now);
  testDb.prepare(
    `INSERT INTO Submissions (id, project_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-org-a', 'proj1', 'from A', 'new', now);
  testDb.prepare(
    `INSERT INTO Submissions (id, project_id, message, status, created_at)
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
  assert.equal(byId.get('sub-org-a')?.projectName, 'Proj One');
  assert.equal(byId.get('sub-org-b')?.projectName, 'Proj One B');
});

test('GET /submissions/:id includes projectName', async () => {
  const now = Date.now();
  testDb.prepare(
    `INSERT INTO Submissions (id, project_id, message, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('sub-detail-1', 'proj1', 'detail me', 'new', now);

  const dash = dashboardForUser('user-org1c', 'org1');
  const res = await dash.request('/submissions/sub-detail-1');
  assert.equal(res.status, 200);
  const body = asBody(await res.json());
  assert.equal(body.projectId, 'proj1');
  assert.equal(body.projectName, 'Proj One');
  assert.equal(body.message, 'detail me');
});

test('widget source builds DOM without innerHTML (Trusted-Types safe)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'widget', 'src', 'index.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(src), 'widget/src/index.js must not assign .innerHTML');
});
