// Fetches a song's track data from Songsterr, server side (the browser can't,
// because Songsterr doesn't send CORS headers).
//
// Flow:
//   1. Pull the song id out of the link (".../some-song-tab-s12345").
//   2. Find the current revision: read the JSON state embedded in the tab page,
//      or fall back to Songsterr's metadata endpoints.
//   3. Download each track's JSON from Songsterr's CDN.

const SONGSTERR = 'https://www.songsterr.com';
const CDN_HOSTS = ['https://dqsljvtekg760.cloudfront.net', 'https://d3d3l6a6rcgkaf.cloudfront.net'];
const TIMEOUT_MS = 10000;
const MAX_PROBED_TRACKS = 24;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

export class SongsterrError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Accepts a Songsterr link or a bare song id.
 * @returns {{ songId: number, url: string | null }}
 */
export function parseSongsterrUrl(input) {
  const text = String(input || '').trim();
  if (/^\d+$/.test(text)) return { songId: Number(text), url: null };

  let url;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    throw new SongsterrError('That does not look like a link. Paste a songsterr.com tab URL.', 400);
  }
  if (!/(^|\.)songsterr\.com$/i.test(url.hostname)) {
    throw new SongsterrError('Only songsterr.com links are supported.', 400);
  }
  // e.g. /a/wsa/artist-song-tab-s12345 or ...-s12345t2 (t = selected track)
  const match = url.pathname.match(/-s(\d+)(?:t\d+)?\/?$/) || url.pathname.match(/\/s(\d+)(?:t\d+)?\/?$/);
  if (!match) {
    throw new SongsterrError('Could not find a song id in that link. It should end in something like "-s12345".', 400);
  }
  url.hash = '';
  url.search = '';
  return { songId: Number(match[1]), url: url.toString() };
}

/** Extracts `meta.current` from the JSON state script embedded in a tab page. */
export function extractStateFromHtml(html) {
  const match = String(html).match(/<script[^>]*\bid=["']state["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let state;
  try {
    state = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const current = state?.meta?.current;
  if (!current || !current.revisionId || !current.image) return null;
  return current;
}

async function request(url, fetchImpl, accept) {
  return fetchImpl(url, {
    headers: { ...BROWSER_HEADERS, Accept: accept, Referer: `${SONGSTERR}/` },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

async function getJson(url, fetchImpl) {
  const res = await request(url, fetchImpl, 'application/json, text/plain, */*');
  if (!res.ok) return { ok: false, status: res.status };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, status: res.status };
  }
}

function pickRevision(candidate) {
  if (!candidate) return null;
  const list = Array.isArray(candidate) ? candidate : [candidate];
  return list.find((r) => r && r.revisionId && r.image) || null;
}

async function findRevision(songId, pageUrl, fetchImpl) {
  const errors = [];
  if (pageUrl) {
    try {
      const res = await request(pageUrl, fetchImpl, 'text/html,application/xhtml+xml');
      if (res.ok) {
        const current = extractStateFromHtml(await res.text());
        if (current) return current;
        errors.push('tab page had no song data');
      } else {
        errors.push(`tab page returned ${res.status}`);
      }
    } catch (err) {
      errors.push(`tab page: ${err.message}`);
    }
  }

  for (const path of [`/api/meta/${songId}`, `/api/meta/${songId}/revisions`]) {
    try {
      const res = await getJson(`${SONGSTERR}${path}`, fetchImpl);
      const revision = res.ok && pickRevision(res.data);
      if (revision) return revision;
      errors.push(`${path} ${res.ok ? 'had no revision' : `returned ${res.status}`}`);
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
    }
  }
  throw new SongsterrError(`Could not load song ${songId} from Songsterr (${errors.join('; ')}).`);
}

async function fetchTrack(songId, revisionId, image, partId, fetchImpl) {
  let lastStatus = 0;
  for (const host of CDN_HOSTS) {
    try {
      const res = await getJson(`${host}/${songId}/${revisionId}/${image}/${partId}.json`, fetchImpl);
      if (res.ok) return res.data;
      lastStatus = res.status;
      // 404 on the first host means the part doesn't exist; no point asking the mirror.
      if (res.status === 404) break;
    } catch {
      lastStatus = 0;
    }
  }
  return { missing: true, status: lastStatus };
}

/**
 * Downloads everything needed to render a song.
 * @returns {Promise<{ songId, revisionId, title, artist, tracks: { meta, data }[], warnings: string[] }>}
 */
export async function fetchSongsterrSong(input, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const { songId, url } = parseSongsterrUrl(input);
  const pageUrl = url || `${SONGSTERR}/a/wsa/song-tab-s${songId}`;
  const revision = await findRevision(songId, pageUrl, fetchImpl);
  const { revisionId, image } = revision;
  const warnings = [];

  let metas = Array.isArray(revision.tracks) ? revision.tracks.map((t, i) => ({ ...t, partId: t.partId ?? i })) : [];
  let tracks = [];

  if (metas.length > 0) {
    const payloads = await Promise.all(metas.map((m) => fetchTrack(songId, revisionId, image, m.partId, fetchImpl)));
    payloads.forEach((data, i) => {
      if (data.missing) warnings.push(`Track "${metas[i].title || metas[i].name || i}" could not be downloaded.`);
      else tracks.push({ meta: metas[i], data });
    });
  } else {
    // No track list: probe part ids until one is missing.
    for (let partId = 0; partId < MAX_PROBED_TRACKS; partId++) {
      const data = await fetchTrack(songId, revisionId, image, partId, fetchImpl);
      if (data.missing) break;
      tracks.push({ meta: { partId, instrumentId: data.instrumentId, name: data.name }, data });
    }
  }

  if (tracks.length === 0) {
    throw new SongsterrError('Found the song but none of its tracks could be downloaded.');
  }

  return {
    songId,
    revisionId,
    title: revision.title || 'Untitled',
    artist: revision.artist || '',
    source: url,
    tracks,
    warnings
  };
}
