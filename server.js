/**
 * server.js — SDE Coach API
 *
 * AI proxy accepts a full endpoint URL + detects provider format automatically.
 *
 * Supported formats:
 *   Anthropic  → api.anthropic.com          → /v1/messages
 *   Ollama     → ollama.com or /api/chat     → /api/chat  (native Ollama format)
 *   OpenAI-compat → everything else          → /v1/chat/completions
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

// ── Provider detection ────────────────────────────────────────
function detectProvider(endpointUrl) {
  const u = endpointUrl.toLowerCase();
  if (u.includes('anthropic.com'))       return 'anthropic';
  if (u.includes('ollama.com') ||
      u.includes('/api/chat') ||
      u.includes('/api/generate'))        return 'ollama';
  return 'openai'; // OpenAI, Groq, Together, Mistral, LM Studio, etc.
}

// Build request + extract text from response for each provider
function buildRequest(provider, { model, system, userMsg, maxTokens, apiKey }) {
  switch (provider) {

    case 'anthropic':
      return {
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] }),
      };

    case 'ollama':
      return {
        headers: {
          'Content-Type':  'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: userMsg },
          ],
        }),
      };

    case 'openai':
    default:
      return {
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
      };
  }
}

function extractText(provider, data) {
  switch (provider) {
    case 'anthropic':
      return (data.content || []).map(c => c.text || '').join('');
    case 'ollama':
      // /api/chat  → data.message.content
      // /api/generate → data.response
      return data?.message?.content || data?.response || '';
    case 'openai':
    default:
      return data?.choices?.[0]?.message?.content || '';
  }
}

// ── AI Proxy ──────────────────────────────────────────────────
// Body params:
//   endpoint  — full URL e.g. https://ollama.com/api/chat
//               or base URL e.g. https://api.openai.com  (proxy appends path)
//   apiKey    — provider API key (falls back to ANTHROPIC_API_KEY env var)
//   model     — model name
//   system    — system prompt
//   userMsg   — user message
//   maxTokens
app.post('/api/generate', requireKey, async (req, res) => {
  let {
    endpoint,
    apiKey:    bodyKey,
    model,
    system,
    userMsg,
    maxTokens = 4000,
  } = req.body;

  const apiKey = bodyKey || process.env.ANTHROPIC_API_KEY || '';

  // Default endpoint
  if (!endpoint) endpoint = 'https://api.anthropic.com';

  // If user gave a base URL without a path, append the right path
  const hasPath = new URL(endpoint).pathname.length > 1;
  const provider = detectProvider(endpoint);

  if (!hasPath) {
    if (provider === 'anthropic') endpoint += '/v1/messages';
    else if (provider === 'ollama') endpoint += '/api/chat';
    else endpoint += '/v1/chat/completions';
  }

  if (!model) model = provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';

  console.log(`[ai] provider=${provider} endpoint=${endpoint} model=${model}`);

  const { headers, body } = buildRequest(provider, { model, system, userMsg, maxTokens, apiKey });

  try {
    const upstream = await fetch(endpoint, { method: 'POST', headers, body });
    const data     = await upstream.json();

    if (!upstream.ok) {
      const errMsg = data?.error?.message || data?.error || JSON.stringify(data);
      console.error(`[ai] upstream error ${upstream.status}:`, errMsg);
      return res.status(upstream.status).json({ error: errMsg, raw: data });
    }

    const text = extractText(provider, data);
    res.json({ text, provider, model, raw: data });

  } catch (err) {
    console.error('[ai] proxy error:', err.message);
    res.status(502).json({ error: 'AI request failed: ' + err.message });
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
app.listen(PORT, () => console.log(`SDE Coach on :${PORT}`));