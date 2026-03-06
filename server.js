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
// GET /api/today  — returns news + commercials for today's M/D across all years
app.get('/api/today', async (req, res) => {
  const now   = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');

  const cacheKey = `today:${month}-${day}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  // Build an OR of every year we want to match for this month+day.
  // Archive.org's Solr index supports date range queries per full ISO date,
  // so we union exact day-windows across decades (1980–2010).
  // This is the most reliable approach — the wildcard date:-MM-DD syntax
  // is NOT supported by Archive's Solr and always returns 0 results.
  const years = [];
  for (let y = 1980; y <= 2010; y++) years.push(y);

  const dateRanges = years
    .map(y => `date:[${y}-${month}-${day}T00:00:00Z TO ${y}-${month}-${day}T23:59:59Z]`)
    .join(' OR ');

  const newsQuery   = `collection:tvnews AND (${dateRanges})`;
  const adQuery     = `collection:tvarchive AND (subject:"commercial" OR subject:"advertisement" OR title:"commercial")`;
  const adFallback  = `subject:"television commercial" OR subject:"TV commercial" OR subject:"vintage commercial"`;

  const FIELDS = 'identifier,title,date,description,subject,year';
  const BASE   = 'https://archive.org/advancedsearch.php';

  const archiveFetch = (q, rows = 20) =>
    fetch(`${BASE}?q=${encodeURIComponent(q)}&fl[]=${FIELDS}&rows=${rows}&output=json&sort[]=date+desc`,
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'AIRDATE/1.0' } }
    ).then(r => r.json()).then(d => d.response?.docs || []);

  try {
    const [newsDocs, adDocs] = await Promise.all([
      archiveFetch(newsQuery, 24),
      archiveFetch(adQuery, 20).then(async docs => {
        if (docs.length < 4) return archiveFetch(adFallback, 20);
        return docs;
      })
    ]);

    console.log(`[today] ${month}-${day}: ${newsDocs.length} news, ${adDocs.length} ads`);

    const result = {
      date: `${month}-${day}`,
      news:        newsDocs,
      commercials: adDocs
    };

    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('today endpoint error:', err.message);
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
