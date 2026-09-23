const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT } = require('./catalog');

const DB_DIR = path.join(ROOT, 'data');
const DEFAULT_DB = path.join(DB_DIR, 'hackalem.sqlite');
const MIGRATION_DIR = path.join(ROOT, 'migrations');

function openDatabase(file = process.env.DATABASE_PATH || DEFAULT_DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const migrations = fs.readdirSync(MIGRATION_DIR).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const name of migrations) {
    const version = Number(name.match(/^\d+/)[0]);
    if (applied.has(version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = { openDatabase, migrate, DEFAULT_DB };
