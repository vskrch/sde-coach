/**
 * server.js — Daily Prep Coach API
 *
 * Storage: SQLite via db.js
 * On Heroku: SQLite lives in /tmp (ephemeral per dyno session).
 * The frontend detects an empty backend on load and calls POST /api/reseed
 * to repopulate from its localStorage — so progress is never lost.
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
require('dotenv').config();

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));

// Serve the frontend HTML from /public
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────────
function requireKey(req, res, next) {
  const key = req.headers['x-user-key'];
  if (!key || key.length < 8)
    return res.status(401).json({ error: 'Missing or invalid x-user-key header' });
  req.userKey = key;
  next();
}

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok:      db.isHealthy(),
    ts:      new Date().toISOString(),
    version: '2.0.0',
    storage: 'sqlite',
  });
});

// ── Sessions ─────────────────────────────────────────────────

// GET all sessions
app.get('/api/sessions', requireKey, (req, res) => {
  try {
    res.json(db.getSessions(req.userKey));
  } catch (err) {
    console.error('GET /api/sessions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST upsert one session
app.post('/api/sessions', requireKey, (req, res) => {
  const session = req.body;
  if (!session?.day) return res.status(400).json({ error: 'day is required' });
  try {
    db.upsertSession(req.userKey, session);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/sessions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE one session
app.delete('/api/sessions/:day', requireKey, (req, res) => {
  try {
    db.deleteSession(req.userKey, req.params.day);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Topic index ───────────────────────────────────────────────

// GET topic index
app.get('/api/topics', requireKey, (req, res) => {
  try {
    res.json(db.getTopicIndex(req.userKey));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST merge new topics in
app.post('/api/topics', requireKey, (req, res) => {
  try {
    const existing = db.getTopicIndex(req.userKey);
    const merged   = db.mergeTopics(existing, req.body);
    db.upsertTopicIndex(req.userKey, merged);
    res.json({ ok: true, total: Object.values(merged).flat().length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reseed — called by frontend after a dyno restart ─────────
// Frontend sends its full localStorage state; backend repopulates SQLite.
app.post('/api/reseed', requireKey, (req, res) => {
  const { sessions = [], topic_index = {} } = req.body;
  if (!sessions.length && !Object.keys(topic_index).length) {
    return res.json({ ok: true, reseeded: 0, message: 'nothing to reseed' });
  }
  try {
    db.bulkImport(req.userKey, sessions, topic_index);
    console.log(`[reseed] user=${req.userKey.slice(0,8)}… sessions=${sessions.length}`);
    res.json({ ok: true, reseeded: sessions.length });
  } catch (err) {
    console.error('POST /api/reseed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Export — full backup ──────────────────────────────────────
app.get('/api/export', requireKey, (req, res) => {
  try {
    const data = db.exportAll(req.userKey);
    res.json({ exported_at: new Date().toISOString(), ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk import — restore from JSON backup ────────────────────
app.post('/api/import', requireKey, (req, res) => {
  const { sessions = [], topic_index = {} } = req.body;
  try {
    db.bulkImport(req.userKey, sessions, topic_index);
    res.json({ ok: true, sessions_imported: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all → serve frontend ────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DPC server running on :${PORT}`));
