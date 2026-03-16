import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'
import type { DbInstance } from './db'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string
  slug: string
  name: string
  path: string
  db_path: string
  added_at: string
  last_seen_at: string
}

// ─── Hub DB path ──────────────────────────────────────────────────────────────

export function getHubDbPath(): string {
  return path.join(os.homedir(), '.specrails', 'hub.sqlite')
}

function getProjectDbPath(slug: string): string {
  return path.join(os.homedir(), '.specrails', 'projects', slug, 'jobs.sqlite')
}

// ─── Schema migrations ────────────────────────────────────────────────────────

function applyHubMigrations(db: DbInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version)
  )

  const migrations: Array<() => void> = [
    // Migration 1: projects and hub_settings tables
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id           TEXT PRIMARY KEY,
          slug         TEXT NOT NULL UNIQUE,
          name         TEXT NOT NULL,
          path         TEXT NOT NULL UNIQUE,
          db_path      TEXT NOT NULL,
          added_at     TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
        CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

        CREATE TABLE IF NOT EXISTS hub_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    },
  ]

  for (let i = 0; i < migrations.length; i++) {
    const version = i + 1
    if (!appliedVersions.has(version)) {
      migrations[i]()
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version)
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initHubDb(dbPath: string = getHubDbPath()): DbInstance {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  applyHubMigrations(db)
  return db
}

export function listProjects(db: DbInstance): ProjectRow[] {
  return db.prepare(
    'SELECT * FROM projects ORDER BY added_at ASC'
  ).all() as ProjectRow[]
}

export function getProject(db: DbInstance, id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
}

export function getProjectBySlug(db: DbInstance, slug: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined
}

export function getProjectByPath(db: DbInstance, projectPath: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath) as ProjectRow | undefined
}

export function addProject(
  db: DbInstance,
  project: { id: string; slug: string; name: string; path: string }
): ProjectRow {
  const dbPath = getProjectDbPath(project.slug)
  db.prepare(`
    INSERT INTO projects (id, slug, name, path, db_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(project.id, project.slug, project.name, project.path, dbPath)
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow
}

export function removeProject(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function touchProject(db: DbInstance, id: string): void {
  db.prepare(
    "UPDATE projects SET last_seen_at = datetime('now') WHERE id = ?"
  ).run(id)
}

export function getHubSetting(db: DbInstance, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setHubSetting(db: DbInstance, key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO hub_settings (key, value) VALUES (?, ?)'
  ).run(key, value)
}
