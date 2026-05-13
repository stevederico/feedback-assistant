# Feedback Assistant — To Do

## Deploy
- Build widget bundle on `npm run build` (already wired)
- Serve `widget/dist/feedback-assistant.js` from Hono at versioned route `/widget/v<version>.js`
- Add immutable `Cache-Control: public, max-age=31536000, immutable` on versioned widget route
- Deploy backend + frontend to Railway via `railway up`
- Configure Railway persistent volume mount at `/app/backend/databases`
- Set `JWT_SECRET`, `CORS_ORIGINS`, `STRIPE_KEY` (later) on Railway
- Verify production `pk_*` ingestion end-to-end with a real customer page

## Widget polish
- Add `html2canvas` lazy-loaded screenshot path (no permission prompt)
- Generate + publish SRI hash for embed snippet
- Wire greeting bubble copy from project config (currently hardcoded)
- Auto-init via `<script data-project="...">` tested across CSP-strict pages

## Dashboard polish
- User/org management — invite teammates by email, role = admin | member
- Project picker visible only when >1 project (already done) — confirm UX with 2+ projects
- Empty-state "Embed snippet" page when no submissions yet
- Polish landing page copy (scaffold defaults still present)

## Pre-launch decisions
- Pick the wedge (positioning vs Userback / Marker.io / Sentry)
- Buy the domain
- Marketing site rewrite

## Backlog (post-MVP)
- Roadmap tab in widget with drag-to-rank (SortableJS, touch-friendly)
- GitHub issue creation from submission detail
- Email digest of new submissions for org admins
- Generic outbound webhook for Zapier/n8n
- Per-project retention policy (default 90 days) + auto-purge job
- Short-lived HMAC URLs for external screenshot sharing
