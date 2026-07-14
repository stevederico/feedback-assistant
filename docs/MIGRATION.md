# Migration Guide

For **Feedback Assistant** app upgrades and Skateboard-ui bumps. Boilerplate-only history from the original Skateboard template is not repeated here.

---

## App version upgrades

1. Read root `CHANGELOG.md` for the versions you are jumping
2. `git pull` / install deps (`bun install` or `npm install`)
3. Run `npm run test` before deploy
4. Deploy with a **volume-preserving** strategy so `backend/databases` is not wiped
5. Schema: `bootstrapFeedbackSchema` runs on startup — new columns/tables are additive (`IF NOT EXISTS` / guarded `ALTER`). No manual SQL for normal upgrades.

### Notable recent app changes

| Version | Impact |
|---------|--------|
| 3.10 | UI renames "projects" → "apps"; API paths stay `/projects` |
| 3.8 | Default embed `/widget.js` auto-updates |
| 3.7 | Origin allowlist enforced; screenshots cleaned on delete |
| 3.6 | Submissions list shows project name; org-wide inbox filter |
| 3.3+ | Versioned widget, SRI, CSP-safe widget, greeting from config |

---

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

---

## Database

### SQLite (default)

- Path: `backend/databases/FeedbackAssistant.db` (from `config.json`)
- Startup bootstrap creates feedback tables if missing
- `Users.org_id` added via pragma-guarded `ALTER` when absent
- Old users without `org_id` get a workspace on first authenticated dashboard call

### Switching dbType

Adapters support postgres/mongodb for core Users/Auths. Feedback DDL is SQLite-oriented today — treat non-SQLite as unsupported for production feedback tables unless you extend `feedback-schema.ts` and query code.

---

## Widget embed migrations

| From | To | Action |
|------|-----|--------|
| Pinned `/widget/vX.Y.Z.js` | Auto-update | Point `src` at `/widget.js`; drop SRI or refresh after each pin |
| Auto `/widget.js` | Pinned | Use `/widget/v{version}.js` + integrity from `/api/widget-integrity` |
| Key rotation | — | Dashboard **Rotate key**; update every site using the old `pk_` |

After a major widget CSP change, re-test embeds under your site's `Content-Security-Policy` (script-src, connect-src to API host).

---

## Breaking operational notes

- Deleting a project cascades DB rows and unlinks screenshot files
- Rotating a project key invalidates all live embeds immediately
- Changing `allowed_origins` from empty → list blocks unmatched browser Origins on `/v1`
