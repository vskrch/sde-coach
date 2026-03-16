/**
 * server.js — SDE Coach API
 *
 * AI proxy supports any OpenAI-compatible endpoint OR Anthropic.
 * Detection is automatic based on the base URL provided.
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────
function requireKey(req, res, next) {
  const key = req.headers['x-user-key'];
  if (!key || key.length < 8)
    return res.status(401).json({ error: 'Missing or invalid x-user-key header' });
  req.userKey = key;
  next();
}

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: db.isHealthy(), ts: new Date().toISOString(), version: '2.0.0', storage: 'sqlite' });
});

// ── AI Proxy ──────────────────────────────────────────────────
// Accepts from request body:
//   apiKey   — the provider API key
//   baseUrl  — e.g. https://api.openai.com or https://api.groq.com/openai
//              defaults to Anthropic if not provided
//   model    — e.g. gpt-4o, llama3-70b-8192, claude-sonnet-4-20250514
//   system   — system prompt string
//   userMsg  — user message string
//   maxTokens
//
// Falls back to ANTHROPIC_API_KEY env var if no apiKey in body.

app.post('/api/generate', requireKey, async (req, res) => {
  const {
    apiKey:   bodyKey,
    baseUrl:  bodyBase,
    model:    bodyModel,
    system,
    userMsg,
    maxTokens = 4000,
  } = req.body;

  const apiKey  = bodyKey  || process.env.ANTHROPIC_API_KEY;
  const baseUrl = (bodyBase || 'https://api.anthropic.com').replace(/\/$/, '');
  const model   = bodyModel || process.env.MODEL || 'claude-sonnet-4-20250514';

  if (!apiKey) {
    return res.status(500).json({ error: 'No API key provided. Set one in the app settings or set ANTHROPIC_API_KEY on the server.' });
  }

  const isAnthropic = baseUrl.includes('anthropic.com');

  try {
    let upstreamRes, data;

    if (isAnthropic) {
      // ── Anthropic messages format ──────────────────────────
      upstreamRes = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
      data = await upstreamRes.json();
      // Normalise to { text } for frontend
      const text = (data.content || []).map(c => c.text || '').join('');
      res.status(upstreamRes.status).json({ text, raw: data });

    } else {
      // ── OpenAI-compatible chat completions format ──────────
      // Works with: OpenAI, Groq, Together, Mistral, Ollama, LM Studio,
      //             Anyscale, Fireworks, Perplexity, etc.
      upstreamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: userMsg },
          ],
        }),
      });
      data = await upstreamRes.json();
      // Normalise to { text } for frontend
      const text = data.choices?.[0]?.message?.content || '';
      res.status(upstreamRes.status).json({ text, raw: data });
    }

  } catch (err) {
    console.error('AI proxy error:', err.message);
    res.status(502).json({ error: 'AI API error: ' + err.message });
  }
});

// ── Sessions ──────────────────────────────────────────────────
app.get('/api/sessions', requireKey, (req, res) => {
  try { res.json(db.getSessions(req.userKey)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sessions', requireKey, (req, res) => {
  const session = req.body;
  if (!session?.day) return res.status(400).json({ error: 'day is required' });
  try { db.upsertSession(req.userKey, session); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/sessions/:day', requireKey, (req, res) => {
  try { db.deleteSession(req.userKey, req.params.day); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Topic index ───────────────────────────────────────────────
app.get('/api/topics', requireKey, (req, res) => {
  try { res.json(db.getTopicIndex(req.userKey)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/topics', requireKey, (req, res) => {
  try {
    const merged = db.mergeTopics(db.getTopicIndex(req.userKey), req.body);
    db.upsertTopicIndex(req.userKey, merged);
    res.json({ ok: true, total: Object.values(merged).flat().length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reseed ────────────────────────────────────────────────────
app.post('/api/reseed', requireKey, (req, res) => {
  const { sessions = [], topic_index = {} } = req.body;
  if (!sessions.length && !Object.keys(topic_index).length)
    return res.json({ ok: true, reseeded: 0 });
  try {
    db.bulkImport(req.userKey, sessions, topic_index);
    res.json({ ok: true, reseeded: sessions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Export / Import ───────────────────────────────────────────
app.get('/api/export', requireKey, (req, res) => {
  try { res.json({ exported_at: new Date().toISOString(), ...db.exportAll(req.userKey) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/import', requireKey, (req, res) => {
  const { sessions = [], topic_index = {} } = req.body;
  try { db.bulkImport(req.userKey, sessions, topic_index); res.json({ ok: true, sessions_imported: sessions.length }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Catch-all → frontend ──────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SDE Coach running on :${PORT}`));