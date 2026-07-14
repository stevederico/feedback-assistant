# Architecture

Feedback Assistant is a monorepo built on **Skateboard** (application shell) with three runtime pieces: dashboard, API, and embeddable widget.

---

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

---

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
└── docs/
```

Workspaces: root (dashboard), `backend`, `widget`. Scripts: `npm run start` runs all three; `npm run prod` builds dashboard + widget.

---

## Application shell (dashboard)

Skateboard-ui owns routing shell, auth pages, layout, theme, and `apiRequest`.

App code only registers views (`src/main.tsx`):

| Path | Component | Role |
|------|-----------|------|
| `apps` | `ProjectsView` | Create/manage apps, embed snippet |
| `submissions` | `SubmissionsView` | Org inbox + filters |
| `changelog` | `ChangelogView` | Per-app What's New editor |

Default route: `apps`. `CommandMenu` overlays the shell layout (Cmd+K).

---

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

Mount order (relevant bits):

1. `bootstrapFeedbackSchema(rawDb)`
2. `app.route('/v1', createWidgetApi(…))`
3. `app.route('/api', createFeedbackDashboardApi(…))` (plus auth routes already on `/api`)
4. `/widget.js` + versioned bundles
5. `serveStatic` for dashboard `dist/` + SPA fallback

---

## Multi-tenancy

1. Signup creates a user and an **Org**; `Users.org_id` points at it
2. **Projects** belong to one org; dashboard always scopes by org
3. Widget never sees org IDs — only `public_key`
4. Cross-org IDs fail closed (404) so tenants cannot probe each other

---

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

---

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

---

## Data flow: feedback message

1. End user opens widget → optional `GET /v1/projects/:pk/widget` (greeting) + changelog
2. Optional screenshot → `POST /v1/screenshots` → `screenshotId`
3. `POST /v1/submissions` with message + context → row status `new`
4. Owner opens Submissions → `GET /api/submissions` → mark read / archive / delete
5. Screenshot view → `GET /api/screenshots/:id` (org-gated stream)

---

## Build & runtime

| Mode | What runs |
|------|-----------|
| Dev | Vite :5173 (proxy/CORS to API), Hono :8000, widget Vite HMR |
| Prod | Single Node process serves API + widget JS + dashboard static from `dist/` |

Production image: multi-stage `Dockerfile` (Node 24), copies `dist/`, `widget/dist/`, `backend/`. Persist `backend/databases`.

See [DEPLOY.md](./DEPLOY.md), [API.md](./API.md), [SCHEMA.md](./SCHEMA.md).
