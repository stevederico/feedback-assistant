# Feedback Assistant Guide

Product overview and quick start: root [README.md](../README.md).

1. [Architecture](#architecture)
2. [API](#api)
3. [Schema](#schema)
4. [Deployment](#deployment)
5. [Migration](#migration)

---

# Architecture

Monorepo on **Skateboard** (application shell): dashboard SPA, Hono API, embeddable widget.

## System diagram

```
┌─────────────────────┐     cookie + CSRF      ┌──────────────────────────┐
│  Dashboard SPA      │ ─────────────────────► │  Hono server (:8000)     │
│  React 19 + Vite    │ ◄───────────────────── │                          │
│  skateboard-ui      │        /api/*          │  ┌─ auth + Stripe        │
│  routes: apps,      │                        │  ├─ feedback-dashboard  │
│  submissions,       │                        │  ├─ widget-api (/v1)     │
│  changelog          │                        │  ├─ /widget*.js static   │
└─────────────────────┘                        │  └─ SPA fallback (dist)  │
                                               │            │             │
┌─────────────────────┐   X-Project-Key        │            ▼             │
│  Customer site      │ ─────────────────────► │     SQLite + uploads     │
│  <script widget.js> │ ◄──── /v1 + assets     │  databases/*.db          │
└─────────────────────┘                        └──────────────────────────┘
```

## Monorepo layout

```
feedback-assistant/
├── src/                    # Dashboard SPA
│   ├── main.tsx            # createSkateboardApp + routes
│   ├── constants.json      # App name, nav, landing copy
│   ├── components/         # ProjectsView, SubmissionsView, ChangelogView, …
│   └── util/               # api helpers, embed snippet, types
├── backend/
│   ├── server.ts           # Hono entry: auth, mount APIs, widget assets
│   ├── feedback-schema.ts  # DDL bootstrap
│   ├── feedback-dashboard-api.ts
│   ├── widget-api.ts
│   ├── feedback-rate-limit.ts
│   ├── feedback-uploads.ts
│   ├── feedback-origin.ts
│   ├── adapters/           # sqlite | postgres | mongodb
│   └── databases/          # runtime volume (gitignored data)
├── widget/                 # Vanilla JS embed (separate Vite build)
│   ├── src/index.js
│   └── dist/feedback-assistant.js
└── docs/GUIDE.md
```

Workspaces: root (dashboard), `backend`, `widget`. `npm run start` runs all three; `npm run prod` builds dashboard + widget.

## Application shell (dashboard)

Skateboard-ui owns routing shell, auth pages, layout, theme, and `apiRequest`.

App code only registers views (`src/main.tsx`):

| Path | Component | Role |
|------|-----------|------|
| `apps` | `ProjectsView` | Create/manage apps, embed snippet |
| `submissions` | `SubmissionsView` | Org inbox + filters |
| `changelog` | `ChangelogView` | Per-app What's New editor |

Default route: `apps`. `CommandMenu` overlays the shell layout (Cmd+K).

## Backend modules

| Module | Responsibility |
|--------|----------------|
| `server.ts` | JWT/CSRF/auth routes, Stripe, health, static SPA, mounts below |
| `feedback-schema.ts` | Idempotent feedback DDL on startup |
| `feedback-dashboard-api.ts` | Org-scoped CRUD under `/api` |
| `widget-api.ts` | Public ingest under `/v1` |
| `feedback-rate-limit.ts` | IP bucket + daily budget |
| `feedback-uploads.ts` | Screenshot files on disk |
| `feedback-origin.ts` | CSV allowlist parse + match |
| `adapters/*` | DB provider selection |

Mount order:

1. `bootstrapFeedbackSchema(rawDb)`
2. `app.route('/v1', createWidgetApi(…))`
3. `app.route('/api', createFeedbackDashboardApi(…))` (plus auth routes already on `/api`)
4. `/widget.js` + versioned bundles
5. `serveStatic` for dashboard `dist/` + SPA fallback

## Multi-tenancy

1. Signup creates a user and an **Org**; `Users.org_id` points at it
2. **Projects** belong to one org; dashboard always scopes by org
3. Widget never sees org IDs — only `public_key`
4. Cross-org IDs fail closed (404) so tenants cannot probe each other

## Widget design constraints

- **No framework** in the shipped bundle — vanilla DOM
- **CSP-safe**: no `innerHTML`, Constructable Stylesheet (no inline `<style>`)
- **html2canvas** loaded on demand from `/widget/html2canvas-v1.js`
- API base defaults from the script's origin (`data-api` override)
- Default script URL `/widget.js` auto-updates (short cache); pin `/widget/vX.Y.Z.js` + SRI for freezes

Embed:

```html
<script
  src="https://your-host/widget.js"
  data-project="pk_…"
  data-api="https://your-host/v1"
  defer
></script>
```

## Security layers

| Layer | Mechanism |
|-------|-----------|
| Dashboard session | HttpOnly JWT cookie + CSRF on mutations |
| Passwords | scrypt (`node:crypto`); legacy bcrypt rehash on login |
| Widget auth | `X-Project-Key` only |
| Origin hygiene | Optional per-project allowlist |
| Abuse | IP rate limit + per-project daily budget |
| Screenshots | Auth stream for dashboard; public upload only with valid key |
| Headers | CSP, HSTS, X-Frame-Options (widget routes skip CSP that would break embeds) |

## Data flow: feedback message

1. End user opens widget → optional `GET /v1/projects/:pk/widget` (greeting) + changelog
2. Optional screenshot → `POST /v1/screenshots` → `screenshotId`
3. `POST /v1/submissions` with message + context → row status `new`
4. Owner opens Submissions → `GET /api/submissions` → mark read / archive / delete
5. Screenshot view → `GET /api/screenshots/:id` (org-gated stream)

## Build & runtime

| Mode | What runs |
|------|-----------|
| Dev | Vite :5173 (proxy/CORS to API), Hono :8000, widget Vite HMR |
| Prod | Single Node process serves API + widget JS + dashboard static from `dist/` |

Production image: multi-stage `Dockerfile` (Node 24), copies `dist/`, `widget/dist/`, `backend/`. Persist `backend/databases`.

---

# API

Two surfaces on the same Hono server:

| Surface | Prefix | Auth | Use |
|---------|--------|------|-----|
| Dashboard | `/api/*` | Cookie session + CSRF on mutations | Admin SPA |
| Widget | `/v1/*` | `X-Project-Key: pk_…` | Embed on customer sites |

Widget static assets: `/widget.js`, `/widget/v<version>.js`, `/widget/html2canvas-v1.js`.

## Auth model

### Dashboard (`/api`)

- JWT in HttpOnly `token` cookie (30 days)
- Mutations (POST/PUT/PATCH/DELETE) need `X-CSRF-Token` matching the CSRF cookie
- Send credentials (`credentials: 'include'`); skateboard-ui `apiRequest` does this
- Cross-tenant access returns **404** (no existence leak), not 403

### Widget (`/v1`)

- Header: `X-Project-Key: pk_<32 hex chars>`
- No cookies, no CSRF
- CORS: `Access-Control-Allow-Origin: *` (credentials false)
- When `Projects.allowed_origins` is non-empty, `Origin` must match or request is **403**
- Empty allowlist = allow all origins (including missing `Origin`)

## Dashboard API

All routes below are under `/api`. Auth required unless noted.

### Public / utility

#### GET `/api/health`

```json
{ "status": "ok", "timestamp": 1710000000000 }
```

#### GET `/api/widget-integrity`

Public. Embed snippet SRI metadata.

```json
{ "version": "3.10.0", "integrity": "sha384-…" }
```

`integrity` may be `null` in dev when the bundle is missing.

### Authentication (Skateboard)

#### POST `/api/signup`

```json
{ "name": "Ada", "email": "ada@example.com", "password": "securepassword" }
```

Creates user + default org (`Users.org_id`). Sets `token` + CSRF cookies.

#### POST `/api/signin`

```json
{ "email": "ada@example.com", "password": "securepassword" }
```

#### POST `/api/signout`

Auth required. Clears session cookies.

#### GET `/api/me` · PUT `/api/me`

Current user. PUT body: `{ "name": "…" }` (CSRF).

#### POST `/api/usage`

Optional free-tier usage check/track (Skateboard). Body: `{ "operation": "check" | "track" }`.

#### POST `/api/checkout` · POST `/api/portal` · POST `/api/payment`

Stripe checkout, billing portal, and webhook. Only active when `STRIPE_KEY` / `STRIPE_ENDPOINT_SECRET` are set.

### Projects (apps)

Org-scoped. List keys are **masked** (`pk_ab…wxyz`); full key returned once on create and rotate.

#### GET `/api/projects`

```json
{
  "projects": [{
    "id": "uuid",
    "name": "Marketing site",
    "publicKey": "pk_ab…wxyz",
    "allowedOrigins": "https://example.com",
    "dailyBudget": 1000,
    "greeting": "How can we help?",
    "createdAt": 1710000000000
  }]
}
```

#### POST `/api/projects`

```json
{
  "name": "Marketing site",
  "allowedOrigins": "https://example.com,https://app.example.com",
  "dailyBudget": 1000,
  "greeting": "How can we help?"
}
```

- `name` required, max 200
- `dailyBudget` default 1000, clamped 1…1_000_000
- `greeting` max 500
- **201** — response includes full `publicKey` once

#### PATCH `/api/projects/:id`

Partial update: `name`, `allowedOrigins`, `dailyBudget`, `greeting` (or `null`).

#### DELETE `/api/projects/:id`

Deletes submissions, screenshots (DB + files), changelog, daily ingest, then project.

#### POST `/api/projects/:id/rotate-key`

```json
{ "id": "uuid", "publicKey": "pk_…" }
```

Full new key once. Old embed keys stop working immediately.

### Submissions

Statuses: `new` | `read` | `archived`.

**List query params** (both list endpoints):

| Param | Notes |
|-------|--------|
| `status` | `new` \| `read` \| `archived` |
| `q` | Free-text: message, name, email, url |
| `from` / `to` | Unix ms timestamps |
| `limit` | 1–200, default 50 |
| `offset` | default 0 |
| `projectId` | Org-wide list only — filter to one project |

#### GET `/api/submissions`

Org-wide inbox. Includes `projectName` on each row.

```json
{
  "submissions": [{
    "id": "uuid",
    "projectId": "uuid",
    "projectName": "Marketing site",
    "message": "…",
    "url": "https://…",
    "endUserName": null,
    "endUserEmail": null,
    "screenshotId": null,
    "status": "new",
    "createdAt": 1710000000000
  }],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

#### GET `/api/projects/:id/submissions`

Same shape, single-project scope.

#### GET `/api/submissions/:id`

Detail: list fields plus `userAgent`, `appVersion`, `endUserId`.

#### PATCH `/api/submissions/:id`

```json
{ "status": "read" }
```

#### DELETE `/api/submissions/:id`

Removes submission; deletes screenshot file if no other submission references it.

#### GET `/api/screenshots/:id`

Auth-gated binary stream (`Content-Type` from DB). **403** if not in user's org.

### Changelog (admin)

#### GET `/api/projects/:id/changelog`

All entries (draft + published), ordered by `sortOrder`.

```json
{
  "changelog": [{
    "id": "uuid",
    "title": "New search",
    "body": "Markdown…",
    "sortOrder": 1,
    "publishedAt": 1710000000000,
    "createdAt": 1710000000000
  }]
}
```

`publishedAt: null` = draft (widget does not see it).

#### POST `/api/projects/:id/changelog`

```json
{ "title": "…", "body": "…", "publish": true }
```

- `title` required, max 200; `body` max 50_000
- Appended at end of `sortOrder`

#### PATCH `/api/changelog/:id`

`title`, `body`, and/or `publish` (boolean — sets or clears `publishedAt`).

#### DELETE `/api/changelog/:id`

#### POST `/api/projects/:id/changelog/reorder`

```json
{ "items": [{ "id": "uuid", "sortOrder": 0 }, { "id": "uuid", "sortOrder": 1 }] }
```

Ids not owned by the project are ignored.

## Widget API (`/v1`)

### POST `/v1/submissions`

Headers: `Content-Type: application/json`, `X-Project-Key`.

```json
{
  "message": "Button broken on checkout",
  "url": "https://app.example.com/checkout",
  "userAgent": "…",
  "appVersion": "1.2.3",
  "endUserId": "u_123",
  "endUserName": "Ada",
  "endUserEmail": "ada@example.com",
  "screenshotId": "uuid-from-screenshots"
}
```

| Field | Rules |
|-------|--------|
| `message` | Required, max 5000 |
| `url` | Optional, max 2000 |
| `userAgent` | Optional, max 500 |
| `appVersion` | Optional, max 64 |
| `endUser*` | Optional, truncated |
| `screenshotId` | Must exist for this project |

**200:** `{ "ok": true, "submissionId": "uuid" }`

Errors: **401** bad key, **403** origin, **413** message too long, **429** IP rate limit or daily budget.

### POST `/v1/screenshots`

Multipart form field `file` (JPEG or PNG). Max size: `MAX_SCREENSHOT_BYTES` (default 2 MiB).

**200:** `{ "screenshotId": "uuid" }`

Errors: **415** wrong MIME, **413** too large.

### GET `/v1/projects/:pk/widget`

Public config. Unknown keys return `{ "greeting": null }` (no leak). Cache: 60s.

```json
{ "greeting": "How can we help?" }
```

Path is `/widget` not `/config` (Cloudflare WAF blocks paths containing `config`).

### GET `/v1/projects/:pk/changelog`

Published entries only (`published_at IS NOT NULL`), by `sort_order`.

```json
{
  "changelog": [{
    "id": "uuid",
    "title": "…",
    "body": "…",
    "publishedAt": 1710000000000
  }]
}
```

Unknown keys → `{ "changelog": [] }`.

## Widget static assets

| URL | Cache | Notes |
|-----|--------|--------|
| `/widget.js` | Short (~5 min) | Always latest build — default embed |
| `/widget/v<version>.js` | Immutable | Pin + SRI for strict CSP |
| `/widget/html2canvas-v1.js` | Immutable | Lazy-loaded by the widget for screenshots |

## Rate limiting

| Layer | Limit | Applies to |
|-------|--------|------------|
| IP token bucket | 60 req/min (refill 1/s) | `/v1/submissions`, `/v1/screenshots` |
| Project daily budget | `Projects.daily_budget` (default 1000) | Submissions only (DB `DailyIngest`) |
| Auth (Skateboard) | Login lockout after failed attempts | `/api/signin` |
| Global / payments | Skateboard middleware | Checkout, portal, general API |

## Errors

```json
{ "error": "human-readable message" }
```

| Code | Meaning |
|------|---------|
| 400 | Bad input |
| 401 | Missing/invalid session or project key |
| 403 | CSRF, origin allowlist, or forbidden resource |
| 404 | Not found (also used for cross-tenant) |
| 413 | Payload too large |
| 415 | Unsupported media type |
| 429 | Rate limit / daily budget |
| 500 | Server error |

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `JWT_SECRET` | Yes | Session signing |
| `CORS_ORIGINS` | Prod | Comma-separated dashboard origins |
| `FRONTEND_URL` | Prod | Redirects |
| `PORT` | No | Default 8000 |
| `FREE_USAGE_LIMIT` | No | Default 20 |
| `MAX_SCREENSHOT_BYTES` | No | Default 2 097 152 |
| `UPLOADS_DIR` | No | Default `./databases/uploads` |
| `STRIPE_KEY` | No | Enables payments |
| `STRIPE_ENDPOINT_SECRET` | No | Webhook verify |
| `POSTGRES_URL` / `MONGODB_URL` | No | Non-SQLite adapters |

---

# Schema

Default store: **SQLite** via `node:sqlite` (`backend/config.json` → `FeedbackAssistant.db`).

Postgres and MongoDB adapters exist from Skateboard for Users/Auths; **feedback tables are bootstrapped for SQLite** in `backend/feedback-schema.ts` on every server start (idempotent `IF NOT EXISTS` + guarded `ALTER`).

## Entity model

```
Orgs 1──* Users          (Users.org_id)
Orgs 1──* Projects
Projects 1──* Submissions
Projects 1──* Screenshots
Projects 1──* Changelog
Projects 1──* DailyIngest  (composite PK: project_id + day_utc)
```

Screenshots are files under `UPLOADS_DIR` (default `backend/databases/uploads/<uuid>`); metadata only in DB.

## Skateboard base tables

### Users

| Column | Type | Notes |
|--------|------|--------|
| `_id` | TEXT PK | UUID |
| `email` | TEXT UNIQUE | |
| `name` | TEXT | |
| `created_at` | BIGINT | Unix ms |
| `subscription_*` | … | Stripe fields (flattened) |
| `usage_count` / `usage_reset_at` | … | Free-tier usage |
| `org_id` | TEXT | **Feedback addition** — workspace link (nullable until backfill) |

### Auths

| Column | Type | Notes |
|--------|------|--------|
| `email` | TEXT PK | |
| `password` | TEXT | scrypt (legacy bcrypt verified + rehashed on sign-in) |
| `userID` | TEXT | → Users._id |

## Feedback tables

Created by `bootstrapFeedbackSchema(db)`.

### Orgs

```sql
CREATE TABLE Orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
```

One workspace per signed-up user (created on signup or lazy-backfilled on first dashboard call).

### Projects

```sql
CREATE TABLE Projects (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  public_key      TEXT UNIQUE NOT NULL,  -- pk_ + 32 hex
  allowed_origins TEXT NOT NULL DEFAULT '',  -- CSV origins; empty = allow all
  daily_budget    INTEGER NOT NULL DEFAULT 1000,
  greeting        TEXT,                   -- widget bubble text
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES Orgs(id)
);
CREATE INDEX idx_projects_org ON Projects(org_id);
CREATE INDEX idx_projects_public_key ON Projects(public_key);
```

UI label: **Apps**. API still uses `projects`.

### Submissions

```sql
CREATE TABLE Submissions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  message         TEXT NOT NULL,
  url             TEXT,
  user_agent      TEXT,
  app_version     TEXT,
  end_user_id     TEXT,
  end_user_name   TEXT,
  end_user_email  TEXT,
  screenshot_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'new',  -- new | read | archived
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES Projects(id)
);
CREATE INDEX idx_submissions_project_created
  ON Submissions(project_id, created_at DESC);
CREATE INDEX idx_submissions_project_status
  ON Submissions(project_id, status);
```

### Screenshots

```sql
CREATE TABLE Screenshots (
  id            TEXT PRIMARY KEY,  -- same UUID as file name on disk
  project_id    TEXT NOT NULL,
  content_type  TEXT NOT NULL,      -- image/jpeg | image/png
  size_bytes    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES Projects(id)
);
```

### Changelog

```sql
CREATE TABLE Changelog (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  sort_order   INTEGER NOT NULL,
  published_at INTEGER,            -- NULL = draft
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES Projects(id)
);
CREATE INDEX idx_changelog_project_sort
  ON Changelog(project_id, sort_order);
```

### DailyIngest

```sql
CREATE TABLE DailyIngest (
  project_id TEXT NOT NULL,
  day_utc    TEXT NOT NULL,  -- YYYY-MM-DD
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day_utc)
);
```

Incremented when a widget submission is accepted; enforces `Projects.daily_budget`.

## Config

`backend/config.json`:

```json
{
  "client": "http://localhost:5173",
  "database": {
    "db": "FeedbackAssistant",
    "dbType": "sqlite",
    "connectionString": "./databases/FeedbackAssistant.db"
  }
}
```

Production: mount a **persistent volume** on `backend/databases` (DB + uploads). Do not commit runtime `.db` files.

## Tenancy rules

1. Every project has exactly one `org_id`
2. Dashboard queries always join/filter on the signed-in user's `Users.org_id`
3. Widget resolves project by `public_key` only — no org cookie
4. Cross-org resource access → 404/403 as documented in [API](#api)

---

# Deployment

Ship the dashboard, API, and widget as **one Node process**. Build artifacts are static files served by Hono.

## Prerequisites

- Node.js ≥ 24
- Persistent disk for SQLite + screenshot uploads
- Domain / TLS terminator in front of port 8000 (or your platform's port)

## Environment

Create `backend/.env` (or inject env vars in the host):

```bash
# Required
JWT_SECRET=long-random-string

# Production
CORS_ORIGINS=https://your-dashboard.example.com
FRONTEND_URL=https://your-dashboard.example.com
PORT=8000
NODE_ENV=production

# Optional
FREE_USAGE_LIMIT=20
MAX_SCREENSHOT_BYTES=2097152
UPLOADS_DIR=./databases/uploads

# Optional Stripe (Skateboard payments)
STRIPE_KEY=sk_live_…
STRIPE_ENDPOINT_SECRET=whsec_…
```

`CORS_ORIGINS` must list every browser origin that loads the dashboard. Widget ingest uses open CORS + per-project origin allowlist instead.

Full env table: [Environment variables](#environment-variables).

## Build

From repo root:

```bash
npm install          # or: bun install
npm run prod         # vite build + widget build
```

Outputs:

- `dist/` — dashboard SPA
- `widget/dist/feedback-assistant.js` (+ html2canvas asset as configured)
- Backend reads root `package.json` version for `/widget/v<version>.js`

## Run

```bash
cd backend
node server.ts
```

Or use the container (see below). Health check: `GET /api/health` → `{ "status": "ok", … }`.

## Persistent volume

Mount durable storage at:

```
backend/databases/
```

Holds:

- `FeedbackAssistant.db` (+ WAL files)
- `uploads/` screenshot blobs

Without a volume, restarts wipe data. Default upload path is `./databases/uploads` relative to the backend CWD.

## Docker

`Dockerfile` multi-stage:

1. **builder** — `npm install`, `npm run build`
2. **runtime** — Node 24 alpine, copies `dist/`, `widget/dist/`, `package.json`, `backend/`; `CMD ["node", "server.ts"]` with `WORKDIR /app/backend`

```bash
docker build -t feedback-assistant .
docker run -p 8000:8000 \
  -e JWT_SECRET=… \
  -e CORS_ORIGINS=https://your-host \
  -e FRONTEND_URL=https://your-host \
  -v fa-data:/app/backend/databases \
  feedback-assistant
```

Image runs as root so volume mounts owned by root remain writable (documented in Dockerfile).

Healthcheck hits `http://localhost:8000/api/health`.

## Post-deploy checklist

1. Open dashboard → sign up → create an app
2. Copy embed snippet; confirm `src` points at your host's `/widget.js`
3. Set **allowed origins** on the app if you want origin lockdown
4. Paste script on a test page → submit feedback → appear under Submissions
5. Optional: pin embed to `/widget/vX.Y.Z.js` + SRI from `GET /api/widget-integrity`

## Stripe (optional)

If payments are enabled:

1. Webhook URL: `https://your-host/api/payment`
2. Events: `customer.subscription.created|updated|deleted`
3. Set `STRIPE_KEY` and `STRIPE_ENDPOINT_SECRET`

Omit Stripe vars to leave billing inactive.

## Ops notes

- Prefer `/widget.js` for embeds that should track deploys; use versioned URL + SRI for freeze/CSP
- Rotate `public_key` from the dashboard if a key leaks — old embeds break until updated
- Backup: copy the SQLite file and `uploads/` directory together
- Logs: server uses structured logger; watch 401/403 spikes on `/v1` for abuse

---

# Migration

For **Feedback Assistant** app upgrades and Skateboard-ui bumps. Boilerplate-only history from the original Skateboard template is not repeated here.

## App version upgrades

1. Read root `CHANGELOG.md` for the versions you are jumping
2. `git pull` / install deps (`bun install` or `npm install`)
3. Run `npm run test` before deploy
4. Deploy with a **volume-preserving** strategy so `backend/databases` is not wiped
5. Schema: `bootstrapFeedbackSchema` runs on startup — new columns/tables are additive (`IF NOT EXISTS` / guarded `ALTER`). No manual SQL for normal upgrades.

### Notable recent app changes

| Version | Impact |
|---------|--------|
| 3.19 | Neutral defaults for OSS (no vendor domain in constants/fixtures) |
| 3.14 | Drop changelog drag-reorder UI; drop sonner + dnd-kit deps |
| 3.10 | UI renames "projects" → "apps"; API paths stay `/projects` |
| 3.8 | Default embed `/widget.js` auto-updates |
| 3.7 | Origin allowlist enforced; screenshots cleaned on delete |
| 3.6 | Submissions list shows project name; org-wide inbox filter |
| 3.3+ | Versioned widget, SRI, CSP-safe widget, greeting from config |

## Skateboard / skateboard-ui upgrades

This repo tracks:

- `package.json` → `skateboardVersion` (boilerplate lineage)
- dependency `@stevederico/skateboard-ui`

### Safe workflow

1. Compare `skateboardVersion` to [stevederico/skateboard](https://github.com/stevederico/skateboard) releases
2. Bump UI: install the target `@stevederico/skateboard-ui` version (repo uses exact pins)
3. Diff boilerplate files carefully — **do not** overwrite app-specific code
4. Run `npm run verify:ui` / full `npm run test`

### Safe to review from boilerplate

- `backend/server.ts` security/auth changes (merge, don't replace feedback mounts)
- `backend/adapters/*`
- `vite.config.ts`, theme CSS imports

### Never auto-overwrite

- `src/constants.json`, `src/components/*`, `src/main.tsx`
- `backend/feedback-*.ts`, `backend/widget-api.ts`, `widget/*`
- `backend/config.json`

Template drift notes: vendored/scaffold code can lag the package version label — diff against upstream before trusting a bump. See project `AGENTS.md` → "Updating from Skateboard Boilerplate".

## Database

### SQLite (default)

- Path: `backend/databases/FeedbackAssistant.db` (from `config.json`)
- Startup bootstrap creates feedback tables if missing
- `Users.org_id` added via pragma-guarded `ALTER` when absent
- Old users without `org_id` get a workspace on first authenticated dashboard call

### Switching dbType

Adapters support postgres/mongodb for core Users/Auths. Feedback DDL is SQLite-oriented today — treat non-SQLite as unsupported for production feedback tables unless you extend `feedback-schema.ts` and query code.

## Widget embed migrations

| From | To | Action |
|------|-----|--------|
| Pinned `/widget/vX.Y.Z.js` | Auto-update | Point `src` at `/widget.js`; drop SRI or refresh after each pin |
| Auto `/widget.js` | Pinned | Use `/widget/v{version}.js` + integrity from `/api/widget-integrity` |
| Key rotation | — | Dashboard **Rotate key**; update every site using the old `pk_` |

After a major widget CSP change, re-test embeds under your site's `Content-Security-Policy` (script-src, connect-src to API host).

## Breaking operational notes

- Deleting a project cascades DB rows and unlinks screenshot files
- Rotating a project key invalidates all live embeds immediately
- Changing `allowed_origins` from empty → list blocks unmatched browser Origins on `/v1`
