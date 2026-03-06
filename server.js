/**
 * AIRDATE — Backend Proxy Server
 * Node.js / Express
 *
 * Proxies requests to archive.org to avoid CORS issues,
 * adds caching so you don't hammer the Archive API,
 * and will serve your static frontend files.
 *
 * Run: node server.js
 * Requires: node >= 18
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────────────────
// In production, lock this down to your own domain
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://yourdomain.com', 'https://www.yourdomain.com']
    : '*'
}));

// ── SIMPLE IN-MEMORY CACHE ───────────────────────────────────────────────────
// Caches Archive API responses for 1 hour so repeat loads are instant
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Prevent unbounded growth
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
}

// ── ARCHIVE.ORG SEARCH PROXY ─────────────────────────────────────────────────
// GET /api/search?q=...&rows=12&mediatype=movies
app.get('/api/search', async (req, res) => {
  const { q, rows = 12, mediatype = 'movies' } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });

  const cacheKey = `search:${q}:${rows}:${mediatype}`;
  const cached = getCached(cacheKey);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    const archiveUrl = new URL('https://archive.org/advancedsearch.php');
    archiveUrl.searchParams.set('q', q);
    archiveUrl.searchParams.set('fl[]', 'identifier,title,date,description,subject,mediatype,year');
    archiveUrl.searchParams.set('rows', rows);
    archiveUrl.searchParams.set('page', '1');
    archiveUrl.searchParams.set('output', 'json');
    archiveUrl.searchParams.set('mediatype', mediatype);

    const response = await fetch(archiveUrl.toString(), {
      headers: { 'User-Agent': 'AIRDATE-StreamingApp/1.0' },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Archive.org returned ' + response.status });
    }

    const data = await response.json();
    const docs = data.response?.docs || [];
    setCached(cacheKey, docs);
    res.set('X-Cache', 'MISS');
    res.json(docs);
  } catch (err) {
    console.error('Archive fetch error:', err.message);
    res.status(504).json({ error: 'Archive.org timeout or unreachable', detail: err.message });
  }
});

// ── ARCHIVE ITEM METADATA ─────────────────────────────────────────────────────
// GET /api/item/:identifier  — full metadata for a single item
app.get('/api/item/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const cacheKey = `item:${identifier}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await fetch(`https://archive.org/metadata/${identifier}`, {
      signal: AbortSignal.timeout(6000)
    });
    const data = await response.json();
    setCached(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(504).json({ error: 'Archive.org timeout', detail: err.message });
  }
});

// ── THIS DAY ENDPOINT ─────────────────────────────────────────────────────────
// GET /api/today  — convenience endpoint that returns news + commercials for today's M/D
app.get('/api/today', async (req, res) => {
  const now   = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  const datePattern = `-${month}-${day}`;

  const cacheKey = `today:${datePattern}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Run news + commercial queries in parallel
    const [newsRes, adRes] = await Promise.all([
      fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(
        `date:${datePattern} AND (subject:"news" OR subject:"television" OR collection:tvarchive) AND mediatype:movies`
      )}&fl[]=identifier,title,date,description,subject,year&rows=20&output=json`),
      fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(
        `collection:classic_tv_commercials`
      )}&fl[]=identifier,title,date,description,subject,year&rows=20&output=json`)
    ]);

    const newsData = await newsRes.json();
    const adData   = await adRes.json();

    const result = {
      date: `${month}-${day}`,
      news:        newsData.response?.docs || [],
      commercials: adData.response?.docs   || []
    };

    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ error: 'Archive.org timeout', detail: err.message });
  }
});

// ── SERVE STATIC FRONTEND ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 AIRDATE server running on http://localhost:${PORT}`);
  console.log(`   Proxying to archive.org with 1-hour cache`);
  console.log(`   Put your frontend in the ./public folder\n`);
});
