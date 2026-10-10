// How the browser reaches Songsterr.
//
// 1. Our own server (`npm start`), when the page is served by it.
// 2. Otherwise a `get(url, type)` that tries, in order:
//      - a direct request (works only if Songsterr allows other sites),
//      - a relay configured for this site (config.json) or by the user,
//      - public CORS relays.
//    The route that worked last is tried first next time.
import { ALLOWED_HOSTS, fetchSongsterrSong, parseJsonBytes, searchSongsterr } from './songsterr.js';
import { prefs } from './storage.js';

const asset = (path) => new URL(path, document.baseURI).href;

const PUBLIC_RELAYS = [
  { id: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { id: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  { id: 'corsproxy', wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` }
];

/** Turns "https://relay.example/?url={url}" or "https://relay.example/" into a wrapper. */
function relayFromTemplate(template, id) {
  const t = String(template || '').trim();
  if (!/^https:\/\//i.test(t)) return null;
  const wrap = t.includes('{url}')
    ? (u) => t.replace('{url}', encodeURIComponent(u))
    : (u) => `${t}${t.includes('?') ? '&' : '?'}url=${encodeURIComponent(u)}`;
  return { id, wrap };
}

let siteConfig = null;
async function loadSiteConfig() {
  if (siteConfig) return siteConfig;
  try {
    const res = await fetch(asset('config.json'), { cache: 'no-cache' });
    siteConfig = res.ok ? await res.json() : {};
  } catch {
    siteConfig = {};
  }
  return siteConfig;
}

async function routes() {
  const config = await loadSiteConfig();
  const list = [{ id: 'direct', wrap: (u) => u, timeout: 6000 }];
  const custom = relayFromTemplate(prefs.get('relay', ''), 'custom');
  if (custom) list.push({ ...custom, timeout: 15000 });
  const site = relayFromTemplate(config.relay, 'site');
  if (site) list.push({ ...site, timeout: 15000 });
  list.push(...PUBLIC_RELAYS.map((r) => ({ ...r, timeout: 12000 })));

  const preferred = prefs.get('route', '');
  const index = list.findIndex((r) => r.id === preferred);
  if (index > 0) list.unshift(...list.splice(index, 1));
  return list;
}

async function readBody(res, type) {
  if (type === 'json') return parseJsonBytes(new Uint8Array(await res.arrayBuffer()));
  return res.text();
}

/** The getter used by songsterr.js when there's no server. */
async function browserGet(url, type) {
  if (!ALLOWED_HOSTS.includes(new URL(url).hostname)) throw new Error('blocked host');
  let lastStatus = 0;
  let notFound = 0;
  const list = await routes();
  for (const route of list) {
    let res;
    try {
      res = await fetch(route.wrap(url), { signal: AbortSignal.timeout(route.timeout), credentials: 'omit' });
    } catch {
      continue; // blocked (CORS), offline, or the relay is down
    }
    if (!res.ok) {
      lastStatus = res.status;
      if (res.status === 404) notFound++;
      // A 404 straight from Songsterr is the real answer.
      if (route.id === 'direct' && res.status === 404) return { ok: false, status: 404 };
      continue;
    }
    try {
      const data = await readBody(res, type);
      if (type === 'text' && /^\s*</.test(data) === false) throw new Error('not html');
      prefs.set('route', route.id);
      return { ok: true, data };
    } catch {
      // a relay's own error page rather than Songsterr's content
    }
  }
  if (notFound >= 2) return { ok: false, status: 404 };
  if (lastStatus) return { ok: false, status: lastStatus };
  throw new Error('every route was blocked');
}

let hasServer = null;
async function serverAvailable() {
  if (hasServer !== null) return hasServer;
  try {
    const res = await fetch(asset('api/health'), { cache: 'no-store' });
    hasServer = res.ok && (res.headers.get('content-type') || '').includes('application/json');
  } catch {
    hasServer = false;
  }
  return hasServer;
}

async function serverJson(path) {
  const res = await fetch(asset(path));
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function loadSong(link, onProgress) {
  if (await serverAvailable()) {
    onProgress('Fetching the tab...');
    return serverJson(`api/songsterr?url=${encodeURIComponent(link)}`);
  }
  return fetchSongsterrSong(link, { get: browserGet, onProgress });
}

export async function search(query) {
  if (await serverAvailable()) return serverJson(`api/search?q=${encodeURIComponent(query)}`);
  return searchSongsterr(query, { get: browserGet });
}
