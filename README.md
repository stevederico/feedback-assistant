<div align="center">
  <p align="center" style="margin-top: 40px; margin-bottom: 5px;">
    <img src="public/icons/icon.png" width="60" height="60" alt="Feedback Assistant logo">
  </p>
  <h1 align="center" style="border-bottom: none; margin-bottom: 0;">Feedback Assistant</h1>
  <h3 align="center" style="margin-top: 0; font-weight: normal;">
    a drop-in feedback widget and dashboard with react, hono, and sqlite
  </h3>
</div>

<br />

Add one `<script>` tag to any web app and your users can send feedback — with an optional screenshot — from any page. Every message lands in a searchable dashboard, and you can publish a **What's New** changelog that shows up right inside the widget. No SDK, no build step, no third-party service.

<br />

## 🚀 Quick Start

```bash
bun install        # or: npm install
bun run start      # or: npm run start
```

This runs three processes at once:

- **Dashboard** (Vite) → `http://localhost:5173`
- **Backend** (Hono) → `http://localhost:8000`
- **Widget** dev server (Vite)

Create `backend/.env` with at least a signing secret before signing in:

```bash
JWT_SECRET=replace-with-a-long-random-string
```

Sign up in the dashboard, create a project, and copy the generated embed snippet into any site.

<br />

## ✨ Features

### 📨 **Drop-in Widget**
- **One script tag** — no SDK or build step; paste the snippet and it renders itself
- **Optional screenshots** via lazily-loaded `html2canvas` (no permission prompt)
- **CSP-safe by construction** — builds DOM nodes (no `innerHTML`) and a Constructable Stylesheet (no inline `<style>`), so it works under strict `Content-Security-Policy` and Trusted Types
- **Auto-updating embed** — default `/widget.js` always serves the latest deploy (optional pin: `/widget/vX.Y.Z.js` + SRI)
- **Cross-origin aware** — defaults its API base from the script origin and posts feedback with an `X-Project-Key`

### 📥 **Submissions Inbox**
- **Searchable dashboard** — filter by status, free-text query, and date range
- **Status workflow** — `new` → `read` → `archived`
- **Full context** on each message — page URL, user agent, app version, and identified end-user (name/email/id)
- **Screenshot viewer** streamed behind auth
- **Empty states** for both "no feedback yet" (with setup instructions) and "no results"

### 🗂️ **Projects & Multi-Tenancy**
- **Org-scoped projects** — every project belongs to one workspace; cross-tenant reads return 404
- **Public keys** (`pk_*`) shown in full once, masked thereafter, with one-click rotation
- **Per-project daily budget** and allowed-origins hygiene
- **Configurable greeting** rendered in the widget bubble

### 📣 **Built-in Changelog**
- **Publish a What's New feed** with Markdown bodies
- **Drag-to-reorder** entries (dnd-kit)
- **Draft vs. published** — only published entries reach the widget

### 🔐 **Auth & Security**
- **JWT in HttpOnly cookies** with CSRF protection on mutations
- **Scrypt password hashing** via `node:crypto` (legacy bcrypt hashes verified and lazily rehashed)
- **Rate limiting** on ingest, auth, and global endpoints
- **Security headers** (CSP, HSTS, X-Frame-Options, and more)

<br />

## ⚙️ Configuration

### Frontend

Customize the app — name, tagline, landing/legal copy, sidebar pages — in `src/constants.json`.

### Backend

Set the database in `backend/config.json` (SQLite is the default):

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

Secrets live in `backend/.env` (never commit it):

```bash
JWT_SECRET=your-long-random-string   # required
CORS_ORIGINS=https://your-dashboard  # production allowlist
FRONTEND_URL=https://your-dashboard  # production redirects
FREE_USAGE_LIMIT=20                  # optional, default 20

# Optional — only when not using SQLite
POSTGRES_URL=postgresql://user:pass@host:5432/db
MONGODB_URL=mongodb+srv://user:pass@cluster/

# Optional — Skateboard payments (disabled unless set)
STRIPE_KEY=sk_live_...
STRIPE_ENDPOINT_SECRET=whsec_...
```

<br />

## 🏗️ Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **React** | 19 | Dashboard UI |
| **Vite** | 7 | Build tool & dev server |
| **Hono** | 4 | Backend server |
| **Tailwind CSS** | 4 | Styling |
| **skateboard-ui** | 4.14 | Application shell, shadcn components, theming |
| **React Router** | 7 | Routing |
| **node:sqlite** | built-in | Default database (Postgres & MongoDB adapters included) |
| **html2canvas** | 1.4 | Widget screenshots |
| **TypeScript** | strict | Dashboard & backend |
| **Node.js** | ≥ 24 | Runtime |

<br />

## 📚 Architecture

A **monorepo** with three parts:

1. **Dashboard** (`src/`) — a React SPA built on Skateboard's application-shell pattern; the shell handles routing, auth, and layout, and `src/main.tsx` just registers the Projects, Submissions, and Changelog views.
2. **Backend** (`backend/`) — a Hono server that bootstraps its own SQLite schema (`Orgs`, `Projects`, `Submissions`, `Screenshots`, `Changelog`, `DailyIngest`) on top of Skateboard's auth tables. It exposes two API surfaces:
   - **Dashboard API** under `/api/*` — cookie session + CSRF, org-scoped CRUD.
   - **Widget ingest** under `/v1/*` — public, keyed by `X-Project-Key`, wide-open CORS, per-IP rate limit and per-project daily budget.
3. **Widget** (`widget/`) — a dependency-free vanilla-JS bundle, built with Vite and served from the backend at a versioned `/widget/v<version>.js` URL.

The embed snippet the dashboard generates looks like this:

```html
<script
  src="https://your-host/widget.js"
  data-project="pk_..."
  data-api="https://your-host/v1"
  defer
></script>
```

See [`docs/`](docs/) for the full [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), and [Schema](docs/SCHEMA.md) references.

<br />

## 🚀 Deployment

See the [Deployment Guide](docs/DEPLOY.md) for step-by-step instructions. In short: build with `npm run prod` (bundles the dashboard and the versioned widget), then serve the backend with a persistent volume for `backend/databases`.

<br />

## 🤝 Contributing

```bash
git clone https://github.com/stevederico/feedback-assistant
cd feedback-assistant
bun install
bun run start
```

Run `npm run test` before opening a PR — it typechecks and runs the backend, frontend, and build test suites.

<br />

## 📬 Community & Support

- **🐦 X**: [@stevederico](https://x.com/stevederico)
- **🐛 Issues**: [GitHub Issues](https://github.com/stevederico/feedback-assistant/issues)

<br />

## 🙏 Acknowledgements

- [React](https://react.dev) — UI library
- [Hono](https://hono.dev) — backend framework
- [Vite](https://vitejs.dev) — build tool & dev server
- [Tailwind CSS](https://tailwindcss.com) — utility-first CSS
- [html2canvas](https://html2canvas.hertzen.com) — client-side screenshots

<br />

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

<br />

---

<div align="center">
  <p>
    Made with <a href="https://github.com/stevederico/skateboard">Skateboard</a> — a React boilerplate with auth and payments
  </p>
  <p>
    <a href="https://github.com/stevederico/feedback-assistant">⭐ Star us on GitHub</a> — it helps!
  </p>
</div>
