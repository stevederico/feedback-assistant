# Feedback Assistant — To Do

Shipped through **3.19.0**. Checkboxes: `[x]` done, `[ ]` remaining.  
Order = priority (top first within each section).

---

## P0 — Correctness & security (do next)

- [x] Enforce per-app origin allowlist on `/v1` (empty = any; non-empty enforces; `*.domain` supported)
- [x] File cleanup on app delete (unlink screenshot files after DB cascade)
- [ ] Load-test widget on a real strict-CSP page — fixture: `scripts/csp-widget-fixture.html` (serve over HTTP; fill `pk_`; confirm Console clean + submit works)
- [x] Live auth test against a real server — runbook: `scripts/live-auth-check.md` (scrypt signup + `/api/me` 200; bcrypt fixture rehashed to `scrypt$`)

## P1 — Pre-launch (business)

**Wedge:** Feedback + What's New in one script tag — not Userback/Marker full suites, not Sentry. Self-serve embed; your inbox/data; changelog closes the loop in-widget.

- [x] Pick the wedge (vs Userback / Marker.io / Sentry)
- [x] Stripe: product copy + `lookup_key` `feedback_unlimited_monthly` in constants (create matching Stripe product + webhook + `STRIPE_KEY` / `STRIPE_ENDPOINT_SECRET` in prod still required)
- [x] Marketing site rewrite (`src/constants.json` landing/pricing)
- [x] Legal draft: SaaS terms/privacy/EULA/subs (no iTunes) — **counsel review still required before treating as final**

## P2 — Product gap (support / reply loop)

- [ ] Widget support contact: app/owner name + email from public config
- [x] Production domain via deploy env + `companyWebsite` (no vendor domain hardcoded in OSS tree)
- [ ] LLM + agent reply (Grok via `XAI_API_KEY`): draft assist, human agent reply pushed to widget thread, visitor id + message history (not auto-triage vapor)

## P3 — Notify & integrate

- [ ] Email digest of new submissions for org admins
- [ ] Generic outbound webhook (Zapier/n8n)
- [ ] GitHub issue creation from submission detail

## P4 — Later / nice-to-have

- [ ] User/org management — invite by email, role admin | member (deferred post-launch)
- [ ] Per-app retention (default 90 days) + auto-purge job
- [ ] Short-lived HMAC URLs for external screenshot sharing
- [ ] Roadmap tab in widget (drag-to-rank)
- [ ] Loom-style guided walkthrough (face-in-corner)

---

## Done

### Deploy
- [x] Widget bundle on `npm run build` (vendors html2canvas)
- [x] Serve at `/widget/v<version>.js` + immutable Cache-Control
- [x] Railway deploy + volume at `/app/backend/databases`
- [x] `JWT_SECRET`, `CORS_ORIGINS` on Railway (`STRIPE_KEY` deferred)
- [x] Prod `pk_*` ingest E2E (text + screenshot + greeting)

### Widget
- [x] Lazy html2canvas; self-hosted `/widget/html2canvas-v1.js`
- [x] Two-step screenshot upload (`screenshotId`)
- [x] SRI + `data-api` + script-origin API base
- [x] Global API (`identify` / `init` / `show`)
- [x] CSP-safe DOM + constructable stylesheet
- [x] Greeting from app config

### Dashboard
- [x] Submissions empty-state + setup snippet
- [x] Landing/legal feedback-specific copy
- [x] App picker; submissions app labels + All-apps inbox
- [x] Changelog always app-scoped
- [x] Call them apps (not projects) in the UI
- [x] Rename DB table Projects → Apps (`app_id` FKs)
