# Deployment Guide

Ship the dashboard, API, and widget as **one Node process**. Build artifacts are static files served by Hono.

---

## Prerequisites

- Node.js ≥ 24
- Persistent disk for SQLite + screenshot uploads
- Domain / TLS terminator in front of port 8000 (or your platform's port)

---

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

---

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

---

## Run

```bash
cd backend
node server.ts
```

Or use the container (see below). Health check: `GET /api/health` → `{ "status": "ok", … }`.

---

## Persistent volume

Mount durable storage at:

```
backend/databases/
```

Holds:

- `FeedbackAssistant.db` (+ WAL files)
- `uploads/` screenshot blobs

Without a volume, restarts wipe data. Default upload path is `./databases/uploads` relative to the backend CWD.

---

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

---

## Post-deploy checklist

1. Open dashboard → sign up → create an app
2. Copy embed snippet; confirm `src` points at your host's `/widget.js`
3. Set **allowed origins** on the app if you want origin lockdown
4. Paste script on a test page → submit feedback → appear under Submissions
5. Optional: pin embed to `/widget/vX.Y.Z.js` + SRI from `GET /api/widget-integrity`

---

## Stripe (optional)

If payments are enabled:

1. Webhook URL: `https://your-host/api/payment`
2. Events: `customer.subscription.created|updated|deleted`
3. Set `STRIPE_KEY` and `STRIPE_ENDPOINT_SECRET`

Omit Stripe vars to leave billing inactive.

---

## Ops notes

- Prefer `/widget.js` for embeds that should track deploys; use versioned URL + SRI for freeze/CSP
- Rotate `public_key` from the dashboard if a key leaks — old embeds break until updated
- Backup: copy the SQLite file and `uploads/` directory together
- Logs: server uses structured logger; watch 401/403 spikes on `/v1` for abuse
