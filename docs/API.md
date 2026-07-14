# API Reference

Two surfaces on the same Hono server:

| Surface | Prefix | Auth | Use |
|---------|--------|------|-----|
| Dashboard | `/api/*` | Cookie session + CSRF on mutations | Admin SPA |
| Widget | `/v1/*` | `X-Project-Key: pk_…` | Embed on customer sites |

Widget static assets: `/widget.js`, `/widget/v<version>.js`, `/widget/html2canvas-v1.js`.

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

## Widget static assets

| URL | Cache | Notes |
|-----|--------|--------|
| `/widget.js` | Short (~5 min) | Always latest build — default embed |
| `/widget/v<version>.js` | Immutable | Pin + SRI for strict CSP |
| `/widget/html2canvas-v1.js` | Immutable | Lazy-loaded by the widget for screenshots |

---

## Rate limiting

| Layer | Limit | Applies to |
|-------|--------|------------|
| IP token bucket | 60 req/min (refill 1/s) | `/v1/submissions`, `/v1/screenshots` |
| Project daily budget | `Projects.daily_budget` (default 1000) | Submissions only (DB `DailyIngest`) |
| Auth (Skateboard) | Login lockout after failed attempts | `/api/signin` |
| Global / payments | Skateboard middleware | Checkout, portal, general API |

---

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

---

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
