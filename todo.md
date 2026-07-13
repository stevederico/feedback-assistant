# Feedback Assistant — To Do

Shipped 3.2.1 → 3.4.0 (no-dash = done, - dash = remaining).

## Post-skateboard-4 verification (before deploy)
- Live auth test: JWT byte-compat, legacy-bcrypt login, scrypt-rehash against a real prior token (4.0.0 upgrade + TS conversion are build/test-verified only, not runtime-exercised)

## Deploy
Build widget bundle on `npm run build` (wired; vendors html2canvas)
Serve `widget/dist/feedback-assistant.js` at `/widget/v<version>.js`
Immutable `Cache-Control: public, max-age=31536000, immutable` on widget route
Deploy backend + frontend to Railway via `railway up`
Railway persistent volume mounted at `/app/backend/databases`
`JWT_SECRET`, `CORS_ORIGINS` set on Railway (`STRIPE_KEY` still deferred)
Verified production `pk_*` ingestion end-to-end (text + screenshot persist; greeting config returns)

## Widget polish
Lazy-loaded html2canvas screenshot path (no permission prompt); self-hosted at `/widget/html2canvas-v1.js`
Fixed screenshot persistence bug (was sending ignored `screenshotDataUrl`; now two-step multipart `screenshotId`)
SRI hash published via `/api/widget-integrity`; embed snippet emits `integrity` + `crossorigin`
Greeting bubble copy wired from project config (`GET /v1/projects/:pk/widget`)
Embed snippet now sets `data-api`; widget defaults API base from its script origin (cross-origin embeds fixed)
Fixed widget global API (default export) so `window.FeedbackAssistant.identify/init/show` work
CSP-safe by construction: Constructable Stylesheet (no inline `<style>`) + DOM build (no `innerHTML`)
- Load-test the widget on an actual strict-CSP customer page (verified CSP-safe locally; live cross-origin run blocked by Cloudflare bot challenge in headless)

## Dashboard polish
Empty-state "set up widget" page in Submissions when a project has no feedback (distinct from filtered-empty)
Landing + legal copy: real company identity + feedback-specific feature copy in constants.json
Project picker visible only when >1 project (code + data layer verified)
- User/org management — invite teammates by email, role = admin | member (DEFERRED post-launch; design in plan Appendix)

## Pre-launch decisions
- Pick the wedge (positioning vs Userback / Marker.io / Sentry)
- Buy a dedicated domain (currently feedback-assistant.dottie.ai subdomain)
- Marketing site rewrite
- Real legal review (boilerplate terms/privacy are mobile/iTunes-flavored)
- Stripe: real product + `lookup_key` (constants.json still has `my_lookup_key`)

## Backlog (post-MVP)
- Roadmap tab in widget with drag-to-rank (SortableJS, touch-friendly)
- GitHub issue creation from submission detail
- Email digest of new submissions for org admins
- Generic outbound webhook for Zapier/n8n
- Per-project retention policy (default 90 days) + auto-purge job
- Short-lived HMAC URLs for external screenshot sharing
- File cleanup on project delete (DB rows cascade; screenshot files not yet unlinked)
- Loom-style guided walkthrough: record with face-in-corner, guides users through the product
