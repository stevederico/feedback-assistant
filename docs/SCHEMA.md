# Database Schema

Default store: **SQLite** via `node:sqlite` (`backend/config.json` → `FeedbackAssistant.db`).

Postgres and MongoDB adapters exist from Skateboard for Users/Auths; **feedback tables are bootstrapped for SQLite** in `backend/feedback-schema.ts` on every server start (idempotent `IF NOT EXISTS` + guarded `ALTER`).

---

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

---

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

---

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

---

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

---

## Tenancy rules

1. Every project has exactly one `org_id`
2. Dashboard queries always join/filter on the signed-in user's `Users.org_id`
3. Widget resolves project by `public_key` only — no org cookie
4. Cross-org resource access → 404/403 as documented in [API.md](./API.md)
