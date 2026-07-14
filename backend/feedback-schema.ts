// Feedback Assistant schema bootstrap.
// Called once on server startup. Idempotent — all DDL uses IF NOT EXISTS
// or guarded ALTER / rename migrations.
//
// Tables: Orgs, Apps (was Projects), Submissions, Screenshots, Changelog, DailyIngest
// Plus: ALTER Users ADD COLUMN org_id (nullable for existing rows).

import type { DatabaseSync } from 'node:sqlite';

/** True when a table exists in the open database. */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return Boolean(row);
}

/** True when a column exists on a table. */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => {
    const name = c && typeof c === 'object' && 'name' in c ? c.name : null;
    return name === column;
  });
}

/**
 * Add org_id column to Users if missing. SQLite has no IF NOT EXISTS for
 * ALTER TABLE, so probe pragma first.
 *
 * @param db node:sqlite DatabaseSync instance
 */
function ensureUsersOrgIdColumn(db: DatabaseSync): void {
  if (!tableExists(db, 'Users')) return;
  if (!columnExists(db, 'Users', 'org_id')) {
    db.exec('ALTER TABLE Users ADD COLUMN org_id TEXT');
  }
}

/**
 * One-time rename Projects → Apps and project_id → app_id on child tables.
 * Safe to re-run: no-ops when already migrated.
 *
 * @param db node:sqlite DatabaseSync instance
 */
function migrateProjectsToApps(db: DatabaseSync): void {
  if (tableExists(db, 'Projects') && !tableExists(db, 'Apps')) {
    db.exec('ALTER TABLE Projects RENAME TO Apps');
  }

  for (const table of ['Submissions', 'Screenshots', 'Changelog', 'DailyIngest'] as const) {
    if (!tableExists(db, table)) continue;
    if (columnExists(db, table, 'project_id') && !columnExists(db, table, 'app_id')) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN project_id TO app_id`);
    }
  }
}

/**
 * Create feedback-assistant tables + indexes if missing (idempotent).
 * Runs Projects→Apps migration first so existing DBs keep data.
 *
 * @param db node:sqlite DatabaseSync instance (the raw bound database handle)
 */
export function bootstrapFeedbackSchema(db: DatabaseSync): void {
  ensureUsersOrgIdColumn(db);
  migrateProjectsToApps(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS Orgs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Apps (
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
    CREATE INDEX IF NOT EXISTS idx_apps_org ON Apps(org_id);
    CREATE INDEX IF NOT EXISTS idx_apps_public_key ON Apps(public_key);

    CREATE TABLE IF NOT EXISTS Submissions (
      id              TEXT PRIMARY KEY,
      app_id          TEXT NOT NULL,
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
      FOREIGN KEY (app_id) REFERENCES Apps(id)
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_app_created
      ON Submissions(app_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_app_status
      ON Submissions(app_id, status);

    CREATE TABLE IF NOT EXISTS Screenshots (
      id            TEXT PRIMARY KEY,
      app_id        TEXT NOT NULL,
      content_type  TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (app_id) REFERENCES Apps(id)
    );
    CREATE INDEX IF NOT EXISTS idx_screenshots_app ON Screenshots(app_id);

    CREATE TABLE IF NOT EXISTS Changelog (
      id           TEXT PRIMARY KEY,
      app_id       TEXT NOT NULL,
      title        TEXT NOT NULL,
      body_md      TEXT NOT NULL,
      sort_order   INTEGER NOT NULL,
      published_at INTEGER,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY (app_id) REFERENCES Apps(id)
    );
    CREATE INDEX IF NOT EXISTS idx_changelog_app_sort
      ON Changelog(app_id, sort_order);

    CREATE TABLE IF NOT EXISTS DailyIngest (
      app_id  TEXT NOT NULL,
      day_utc TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, day_utc)
    );
  `);
}
