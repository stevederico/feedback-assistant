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
import { bootstrapFeedbackSchema } from './feedback-schema.js';
import { createWidgetApi } from './widget-api.js';
import { createFeedbackDashboardApi } from './feedback-dashboard-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PK = 'pk_testkey0000000000000000000000aa';
const OTHER_PK = 'pk_otherkey0000000000000000000000bb';

let app;

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

  app = createWidgetApi({ logger: { info() {}, warn() {}, error() {} }, db });
  app._db = db;
});

test('GET /v1/projects/:pk/config returns greeting for a valid key', async () => {
  const res = await app.request(`/projects/${PK}/config`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const body = await res.json();
  assert.equal(body.greeting, 'Hey there!');
});

test('GET /v1/projects/:pk/config returns null greeting for an unknown key (no leak)', async () => {
  const res = await app.request('/projects/pk_does_not_exist/config');
  assert.equal(res.status, 200);
  const body = await res.json();
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
  const { screenshotId } = await up.json();
  assert.ok(screenshotId);

  const sub = await app.request('/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project-Key': PK },
    body: JSON.stringify({ message: 'with shot', screenshotId }),
  });
  assert.equal(sub.status, 200);
  const { submissionId } = await sub.json();

  const row = app._db.prepare('SELECT screenshot_id FROM Submissions WHERE id = ?').get(submissionId);
  assert.equal(row.screenshot_id, screenshotId);
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
  const { screenshotId } = await up.json();

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
  const passthrough = (c, next) => next();
  const dash = createFeedbackDashboardApi({
    db: app._db,
    authMiddleware: passthrough,
    csrfProtection: passthrough,
    logger: { info() {}, warn() {}, error() {} },
    widgetVersion: '9.9.9',
    widgetIntegrity: 'sha384-deadbeef',
  });
  const res = await dash.request('/widget-integrity');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, '9.9.9');
  assert.equal(body.integrity, 'sha384-deadbeef');
});

test('widget source builds DOM without innerHTML (Trusted-Types safe)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'widget', 'src', 'index.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(src), 'widget/src/index.js must not assign .innerHTML');
});
