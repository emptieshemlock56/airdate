/**
 * AIRDATETV — Backend Proxy Server
 * Node.js / Express
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://airdate.hubbardit.com'] : '*'
}));

// ── CACHE ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
}

// ── SHARED ARCHIVE FETCH ──────────────────────────────────────────────────────
const FIELDS = 'identifier,title,date,description,subject,year,length';
const BASE   = 'https://archive.org/advancedsearch.php';

function archiveFetch(q, rows = 20, sort = 'date+desc') {
  const url = `${BASE}?q=${encodeURIComponent(q)}&fl[]=${FIELDS}&rows=${rows}&output=json&sort[]=${sort}`;
  return fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'AIRDATETV/1.0' } })
    .then(r => r.json())
    .then(d => d.response?.docs || []);
}

// Parse duration string "HH:MM:SS" → seconds
function durationToSeconds(len) {
  if (!len) return 0;
  const parts = String(len).split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return parseInt(len) || 0;
}

// Extract network from Archive title format "Show : NETWORK : Date"
function extractNetwork(title) {
  if (!title) return 'UNKNOWN';
  const parts = title.split(' : ');
  if (parts.length >= 2) {
    const net = parts[1].trim().toUpperCase();
    // Normalize common variants
    const map = {
      'CNN': 'CNN', 'FOXNEWS': 'FOX NEWS', 'FOX NEWS': 'FOX NEWS',
      'MSNBC': 'MSNBC', 'CSPAN': 'C-SPAN', 'CSPAN2': 'C-SPAN',
      'CNBC': 'CNBC', 'HLN': 'HLN', 'WRC': 'NBC', 'WMAR': 'ABC',
      'WETA': 'PBS', 'WHUT': 'PBS', 'WTTG': 'FOX', 'WJLA': 'ABC',
      'WJZ': 'CBS', 'WBAL': 'NBC', 'WBFF': 'FOX', 'KGO': 'ABC',
      'KQED': 'PBS', 'KNBC': 'NBC', 'KABC': 'ABC', 'KCBS': 'CBS',
      'KTTV': 'FOX', 'KCAL': 'CBS', 'WMAQ': 'NBC', 'WLS': 'ABC',
      'WBBM': 'CBS', 'WFLD': 'FOX', 'KDFW': 'FOX', 'WFAA': 'ABC',
      'KXAS': 'NBC', 'KTVT': 'CBS', 'WTVJ': 'NBC', 'WPLG': 'ABC',
      'WFOR': 'CBS', 'WSVN': 'FOX', 'WFDC': 'UNIVISION',
    };
    return map[net] || net;
  }
  return 'UNKNOWN';
}

// Filter non-US content
const NON_US = /\b(BBC|ITV|SKY News|CBC|SBS|TVNZ|RTÉ|Channel 4|ITN|ESPRESO|CCTV|NHK|Al Jazeera|DW|SYRIANNEWS|N1SRP|TTV|SUDAN)\b/i;
function isAmerican(item) {
  return !NON_US.test((item.title||'') + ' ' + (item.identifier||''));
}

// ── /api/search ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, rows = 12 } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });
  const cacheKey = `search:${q}:${rows}`;
  const cached = getCached(cacheKey);
  if (cached) return res.set('X-Cache','HIT').json(cached);
  try {
    const docs = await archiveFetch(q, rows);
    setCached(cacheKey, docs);
    res.set('X-Cache','MISS').json(docs);
  } catch(err) {
    res.status(504).json({ error: err.message });
  }
});

// ── /api/item/:id ─────────────────────────────────────────────────────────────
app.get('/api/item/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const cacheKey = `item:${identifier}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await fetch(`https://archive.org/metadata/${identifier}`, { signal: AbortSignal.timeout(6000) }).then(r=>r.json());
    setCached(cacheKey, data);
    res.json(data);
  } catch(err) {
    res.status(504).json({ error: err.message });
  }
});

// ── /api/today ────────────────────────────────────────────────────────────────
app.get('/api/today', async (req, res) => {
  const now   = new Date();
  const month = String(now.getMonth()+1).padStart(2,'0');
  const day   = String(now.getDate()).padStart(2,'0');
  const cacheKey = `today:${month}-${day}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const dateRanges = [];
  for (let y = 1980; y <= 2015; y++)
    dateRanges.push(`date:[${y}-${month}-${day}T00:00:00Z TO ${y}-${month}-${day}T23:59:59Z]`);

  const newsQuery = `collection:tvnews AND (${dateRanges.join(' OR ')})`;
  const adQuery   = `collection:classic_tv_commercials`;

  try {
    let [newsDocs, adDocs] = await Promise.all([
      archiveFetch(newsQuery, 40),
      archiveFetch(adQuery, 24).then(async docs => {
        if (docs.length < 4) return archiveFetch(`collection:prelinger AND (subject:"advertising" OR subject:"commercials")`, 20);
        return docs;
      })
    ]);

    // Filter to American, prefer full-length (>= 20 min)
    newsDocs = newsDocs.filter(isAmerican);
    const fullLength = newsDocs.filter(d => durationToSeconds(d.length) >= 1200);
    const finalNews  = fullLength.length >= 4 ? fullLength : newsDocs;

    adDocs = adDocs.filter(isAmerican);

    console.log(`[today] ${month}-${day}: ${finalNews.length} news (${fullLength.length} full-length), ${adDocs.length} ads`);

    const result = { date: `${month}-${day}`, news: finalNews, commercials: adDocs };
    setCached(cacheKey, result);
    res.json(result);
  } catch(err) {
    console.error('today error:', err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── /api/guide ────────────────────────────────────────────────────────────────
// Returns broadcasts grouped by network for the program guide view
// GET /api/guide?month=03&day=06
app.get('/api/guide', async (req, res) => {
  const now   = new Date();
  const month = (req.query.month || String(now.getMonth()+1)).padStart(2,'0');
  const day   = (req.query.day   || String(now.getDate())).padStart(2,'0');
  const cacheKey = `guide:${month}-${day}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  // Fetch a large batch — we need enough to populate multiple networks
  const dateRanges = [];
  for (let y = 1980; y <= 2015; y++)
    dateRanges.push(`date:[${y}-${month}-${day}T00:00:00Z TO ${y}-${month}-${day}T23:59:59Z]`);

  const q = `collection:tvnews AND (${dateRanges.join(' OR ')})`;

  try {
    let docs = await archiveFetch(q, 100, 'date+desc');
    docs = docs.filter(isAmerican);

    // Prefer full-length broadcasts
    const withDuration = docs.map(d => ({ ...d, _secs: durationToSeconds(d.length) }));
    const full    = withDuration.filter(d => d._secs >= 1200); // 20+ min
    const useDocs = full.length >= 10 ? full : withDuration;

    // Group by network
    const byNetwork = {};
    useDocs.forEach(item => {
      const net = extractNetwork(item.title);
      if (net === 'UNKNOWN') return;
      if (!byNetwork[net]) byNetwork[net] = [];
      byNetwork[net].push(item);
    });

    // Sort each network's items by date desc, cap at 12 per network
    Object.keys(byNetwork).forEach(net => {
      byNetwork[net] = byNetwork[net]
        .sort((a,b) => new Date(b.date) - new Date(a.date))
        .slice(0, 12);
    });

    // Sort networks by number of items desc
    const networks = Object.entries(byNetwork)
      .sort((a,b) => b[1].length - a[1].length)
      .map(([name, items]) => ({ name, items }));

    const result = { date: `${month}-${day}`, networks, total: docs.length };
    setCached(cacheKey, result);
    console.log(`[guide] ${month}-${day}: ${docs.length} docs → ${networks.length} networks`);
    res.json(result);
  } catch(err) {
    console.error('guide error:', err.message);
    res.status(504).json({ error: err.message });
  }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n📺 AIRDATETV running on http://localhost:${PORT}\n`);
});
