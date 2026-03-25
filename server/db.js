const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function getDb() {
  if (db) return db;

  const dataDir = process.env.DATA_DIR || './data';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'thumbnails'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });

  const dbPath = path.join(dataDir, 'longbox.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      folder_path TEXT UNIQUE NOT NULL,
      thumbnail_path TEXT,
      issue_count INTEGER DEFAULT 0,
      comicvine_id INTEGER,
      description TEXT,
      publisher TEXT,
      start_year TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT UNIQUE NOT NULL,
      file_size INTEGER DEFAULT 0,
      page_count INTEGER DEFAULT 0,
      issue_number REAL,
      thumbnail_path TEXT,
      comicvine_id INTEGER,
      description TEXT,
      cover_date TEXT,
      characters TEXT,
      creators TEXT,
      story_arcs TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      current_page INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
      UNIQUE(user_id, issue_id)
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (list_id) REFERENCES reading_lists(id) ON DELETE CASCADE,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
      UNIQUE(list_id, issue_id)
    );

    CREATE INDEX IF NOT EXISTS idx_issues_series ON issues(series_id);
    CREATE INDEX IF NOT EXISTS idx_progress_user ON reading_progress(user_id);
    CREATE INDEX IF NOT EXISTS idx_progress_issue ON reading_progress(issue_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
  `);

  // Add display_name and avatar_path columns if they don't exist
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('display_name')) {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  }
  if (!cols.includes('avatar_path')) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_path TEXT");
  }
}

module.exports = { getDb };
