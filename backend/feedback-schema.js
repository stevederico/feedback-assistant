// Feedback Assistant schema bootstrap.
// Called once on server startup. Idempotent — all DDL uses IF NOT EXISTS
// or guarded ALTER for column adds.
//
// Tables added on top of skateboard's Users / Auths / WebhookEvents:
//   Orgs, Projects, Submissions, Screenshots, Changelog, DailyIngest
// Plus: ALTER Users ADD COLUMN org_id (nullable for existing rows).

/**
 * Add org_id column to Users if missing. SQLite has no IF NOT EXISTS for
 * ALTER TABLE, so probe pragma first.
 *
 * @param {Database} db - node:sqlite DatabaseSync instance
 */
function ensureUsersOrgIdColumn(db) {
  const cols = db.prepare('PRAGMA table_info(Users)').all();
  const hasOrgId = cols.some((c) => c.name === 'org_id');
  if (!hasOrgId) {
    db.exec('ALTER TABLE Users ADD COLUMN org_id TEXT');
  }
}

/**
 * Create feedback-assistant tables + indexes if missing.
 *
 * @param {Database} db - node:sqlite DatabaseSync instance
 */
export function bootstrapFeedbackSchema(db) {
  ensureUsersOrgIdColumn(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS Orgs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Projects (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      name            TEXT NOT NULL,
      public_key      TEXT UNIQUE NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '',
      daily_budget    INTEGER NOT NULL DEFAULT 1000,
      greeting        TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (org_id) REFERENCES Orgs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_projects_org ON Projects(org_id);
    CREATE INDEX IF NOT EXISTS idx_projects_public_key ON Projects(public_key);

    CREATE TABLE IF NOT EXISTS Submissions (
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
      status          TEXT NOT NULL DEFAULT 'new',
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES Projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_project_created
      ON Submissions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_project_status
      ON Submissions(project_id, status);

    CREATE TABLE IF NOT EXISTS Screenshots (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      content_type  TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES Projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_screenshots_project ON Screenshots(project_id);

    CREATE TABLE IF NOT EXISTS Changelog (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      title        TEXT NOT NULL,
      body_md      TEXT NOT NULL,
      sort_order   INTEGER NOT NULL,
      published_at INTEGER,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES Projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_changelog_project_sort
      ON Changelog(project_id, sort_order);

    CREATE TABLE IF NOT EXISTS DailyIngest (
      project_id TEXT NOT NULL,
      day_utc    TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, day_utc)
    );
  `);
}
