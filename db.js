/**
 * db.js — SQLite database layer
 *
 * Primary store: SQLite (better-sqlite3)
 * File location:
 *   - Local dev : ./dpc-data.db  (persists between restarts)
 *   - Heroku    : /tmp/dpc-data.db (ephemeral — reseeded from frontend on each dyno start)
 *
 * ─────────────────────────────────────────────────────────────
 * POSTGRES STUB — future migration path
 * When you have budget, swap this module for a pg-backed version.
 * All callers use the same interface:
 *   db.getSessions(userKey)
 *   db.upsertSession(userKey, session)
 *   db.deleteSession(userKey, day)
 *   db.getTopicIndex(userKey)
 *   db.upsertTopicIndex(userKey, merged)
 *   db.exportAll(userKey)
 *   db.bulkImport(userKey, sessions, topicIndex)
 *   db.isHealthy()
 * ─────────────────────────────────────────────────────────────
 */

const path  = require('path');
const fs    = require('fs');

// On Heroku /tmp is the only writable dir that survives within a session
// Locally use project root for a persistent dev file
const IS_HEROKU = !!process.env.DYNO;
const DB_PATH   = process.env.SQLITE_PATH ||
  (IS_HEROKU ? '/tmp/dpc-data.db' : path.join(__dirname, 'dpc-data.db'));

let _db = null;

function getDB() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous  = NORMAL');
  _db.pragma('foreign_keys = ON');
  _initSchema(_db);
  console.log(`[db] SQLite ready → ${DB_PATH}`);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      user_key   TEXT    NOT NULL,
      day        INTEGER NOT NULL,
      date       TEXT,
      data       TEXT    NOT NULL,
      updated_at TEXT    DEFAULT (datetime('now')),
      PRIMARY KEY (user_key, day)
    );

    CREATE TABLE IF NOT EXISTS topic_index (
      user_key    TEXT PRIMARY KEY,
      index_data  TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key   TEXT    NOT NULL,
      event      TEXT    NOT NULL,
      detail     TEXT,
      ts         TEXT    DEFAULT (datetime('now'))
    );
  `);
}

// ── Sessions ─────────────────────────────────────────────────

function getSessions(userKey) {
  return getDB()
    .prepare('SELECT data FROM sessions WHERE user_key = ? ORDER BY day ASC')
    .all(userKey)
    .map(r => JSON.parse(r.data));
}

function upsertSession(userKey, session) {
  getDB().prepare(`
    INSERT INTO sessions (user_key, day, date, data, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_key, day) DO UPDATE SET
      data       = excluded.data,
      updated_at = datetime('now')
  `).run(userKey, session.day, session.date || null, JSON.stringify(session));
}

function deleteSession(userKey, day) {
  getDB()
    .prepare('DELETE FROM sessions WHERE user_key = ? AND day = ?')
    .run(userKey, parseInt(day));
}

// ── Topic index ───────────────────────────────────────────────

function getTopicIndex(userKey) {
  const row = getDB()
    .prepare('SELECT index_data FROM topic_index WHERE user_key = ?')
    .get(userKey);
  return row ? JSON.parse(row.index_data) : {};
}

function upsertTopicIndex(userKey, merged) {
  getDB().prepare(`
    INSERT INTO topic_index (user_key, index_data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_key) DO UPDATE SET
      index_data = excluded.index_data,
      updated_at = datetime('now')
  `).run(userKey, JSON.stringify(merged));
}

// ── Bulk import (used for reseed + restore) ───────────────────

function bulkImport(userKey, sessions = [], topicIndex = {}) {
  const db = getDB();
  const upsertSess = db.prepare(`
    INSERT INTO sessions (user_key, day, date, data, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_key, day) DO UPDATE SET
      data = excluded.data, updated_at = datetime('now')
  `);
  const upsertTopic = db.prepare(`
    INSERT INTO topic_index (user_key, index_data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_key) DO UPDATE SET
      index_data = excluded.index_data, updated_at = datetime('now')
  `);

  const run = db.transaction(() => {
    for (const s of sessions) {
      upsertSess.run(userKey, s.day, s.date || null, JSON.stringify(s));
    }
    if (Object.keys(topicIndex).length) {
      upsertTopic.run(userKey, JSON.stringify(topicIndex));
    }
  });
  run();

  // Log the reseed event
  db.prepare("INSERT INTO sync_log (user_key, event, detail) VALUES (?, 'reseed', ?)")
    .run(userKey, `${sessions.length} sessions, ${Object.values(topicIndex).flat().length} topics`);
}

// ── Export ────────────────────────────────────────────────────

function exportAll(userKey) {
  return {
    sessions:    getSessions(userKey),
    topic_index: getTopicIndex(userKey),
  };
}

// ── Health ────────────────────────────────────────────────────

function isHealthy() {
  try {
    getDB().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

// ── Topic merge helper ────────────────────────────────────────

function mergeTopics(existing, incoming) {
  const merged = {};
  for (const k of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
    const combined = [...(existing[k] || []), ...(incoming[k] || [])];
    const seen = new Set();
    merged[k] = combined.filter(item => {
      const n = item.toLowerCase().trim();
      return seen.has(n) ? false : (seen.add(n), true);
    });
  }
  return merged;
}

module.exports = {
  getSessions,
  upsertSession,
  deleteSession,
  getTopicIndex,
  upsertTopicIndex,
  bulkImport,
  exportAll,
  isHealthy,
  mergeTopics,
};
