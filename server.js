// Small dependency-free web server:
//   /                     the app (public/)
//   /vendor/alphatab/*    alphaTab's browser build, fonts and soundfont
//   /vendor/sounds/*      the better instrument sounds (npm run fetch-sounds)
//   /api/songsterr?url=   fetches a song from Songsterr and returns its tracks as JSON
//   /api/search?q=        searches Songsterr
//   /api/health           lets the page know a server is available
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerGetter, fetchSongsterrSong, searchSongsterr, SongsterrError } from './public/js/songsterr.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const ALPHATAB_DIR = join(ROOT, 'node_modules', '@coderline', 'alphatab', 'dist');
const SOUNDS_DIR = join(ROOT, '.cache', 'sounds'); // filled by `npm run fetch-sounds`
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map();
const get = createServerGetter();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream'
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(body);
}

async function serveFile(res, baseDir, relPath) {
  const target = resolve(baseDir, normalize(relPath).replace(/^([/\\])+/, ''));
  if (target !== baseDir && !target.startsWith(baseDir + sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    const cacheControl = baseDir === ALPHATAB_DIR || baseDir === SOUNDS_DIR ? 'public, max-age=86400' : 'no-cache';
    send(res, 200, body, MIME[extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': cacheControl });
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

async function cached(key, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  const body = JSON.stringify(await produce());
  cache.set(key, { at: Date.now(), body });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return body;
}

async function handleApi(res, key, produce) {
  try {
    send(res, 200, await cached(key, produce));
  } catch (err) {
    const status = err instanceof SongsterrError ? err.status : 502;
    const message = err instanceof SongsterrError ? err.message : `Songsterr request failed: ${err.message}`;
    console.warn(`[songsterr] ${key}: ${message}`);
    send(res, status, JSON.stringify({ error: message }));
  }
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');

    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true }));
    if (url.pathname === '/api/songsterr') {
      const link = url.searchParams.get('url');
      if (!link) return send(res, 400, JSON.stringify({ error: 'Missing ?url=' }));
      return handleApi(res, `song:${link}`, () => fetchSongsterrSong(link, { get }));
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 400, JSON.stringify({ error: 'Missing ?q=' }));
      return handleApi(res, `search:${q.toLowerCase()}`, () => searchSongsterr(q, { get }));
    }
    if (url.pathname.startsWith('/vendor/sounds/')) {
      return serveFile(res, SOUNDS_DIR, decodeURIComponent(url.pathname.slice('/vendor/sounds/'.length)));
    }
    if (url.pathname.startsWith('/vendor/alphatab/')) {
      return serveFile(res, ALPHATAB_DIR, decodeURIComponent(url.pathname.slice('/vendor/alphatab/'.length)));
    }
    return serveFile(res, PUBLIC_DIR, decodeURIComponent(url.pathname));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createAppServer().listen(PORT, HOST, () => {
    console.log(`Songsterr to Sheet Music running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}
