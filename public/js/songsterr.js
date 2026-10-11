// Songsterr access, shared by the Node server and the browser.
//
// The functions here don't call fetch themselves. They take a `get(url, type)`
// function that performs one request and resolves to
//   { ok: true, data }            (data is parsed JSON or text)
//   { ok: false, status }         (HTTP error)
// and rejects only when the request could not be made at all. The server
// passes a plain fetch with browser-like headers; the browser passes a getter
// that tries several routes (direct, relays).
//
// Where the data lives:
//   https://www.songsterr.com/api/meta/{songId}      current revision, image token, track list
//   (the tab page's <script id="state"> holds the same as meta.current)
//   {cdn}/{songId}/{revisionId}/{image}/{partId}.json  one track's notes
//   https://www.songsterr.com/api/songs?pattern=...    search

export const SONGSTERR = 'https://www.songsterr.com';
export const CDN_HOSTS = ['https://dqsljvtekg760.cloudfront.net', 'https://d3d3l6a6rcgkaf.cloudfront.net'];
export const ALLOWED_HOSTS = ['www.songsterr.com', 'songsterr.com', ...CDN_HOSTS.map((h) => new URL(h).hostname)];
const MAX_PROBED_TRACKS = 24;

export class SongsterrError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** True when the text looks like a link to a Songsterr song (or a bare id). */
export function isSongsterrLink(text) {
  const value = String(text || '').trim();
  return /^\d+$/.test(value) || /songsterr\.com\//i.test(value);
}

/**
 * Accepts a Songsterr link or a bare song id.
 * @returns {{ songId: number, url: string | null, trackIndex: number | null, revisionId: number | null }}
 */
export function parseSongsterrUrl(input) {
  const text = String(input || '').trim();
  if (/^\d+$/.test(text)) return { songId: Number(text), url: null, trackIndex: null, revisionId: null };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new SongsterrError('That does not look like a link. Paste a songsterr.com tab URL.', 400);
  }
  if (!/(^|\.)songsterr\.com$/i.test(url.hostname)) {
    throw new SongsterrError('Only songsterr.com links are supported.', 400);
  }
  // e.g. /a/wsa/artist-song-tab-s12345
  //      ...-s12345t2            (t = selected track)
  //      ...-s12345/r4525144     (r = a specific revision of the tab)
  //      ...-s12345t2/r4525144
  const match = url.pathname.match(/(?:-|\/)s(\d+)(?:t(\d+))?(?:\/r(\d+)(?:t(\d+))?)?\/?$/);
  if (!match) {
    throw new SongsterrError('Could not find a song id in that link. It should contain something like "-s12345".', 400);
  }
  url.hash = '';
  url.search = '';
  const track = match[2] ?? match[4];
  return {
    songId: Number(match[1]),
    url: url.toString(),
    trackIndex: track ? Number(track) : null,
    revisionId: match[3] ? Number(match[3]) : null
  };
}

/** Builds a canonical tab page link. */
export function songUrl({ songId, artist = '', title = '' }) {
  const slug = `${artist} ${title}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${SONGSTERR}/a/wsa/${slug ? `${slug}-` : ''}tab-s${songId}`;
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
  return pickRevision(state?.meta?.current);
}

/**
 * Reads a response body as JSON. The CDN serves gzip; normally the transport
 * decodes it, but some paths (relays, odd headers) hand over the raw bytes.
 */
export async function readJsonBody(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseJsonBytes(bytes);
}

export async function parseJsonBytes(bytes) {
  let data = bytes;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
    data = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(data));
}

function pickRevision(candidate) {
  if (!candidate) return null;
  const list = Array.isArray(candidate) ? candidate : [candidate];
  return list.find((r) => r && r.revisionId && r.image) || null;
}

async function tryGet(get, url, type, errors, label) {
  try {
    const res = await get(url, type);
    if (res.ok) return res.data;
    errors.push(`${label} returned ${res.status}`);
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
  }
  return null;
}

/** Finds the revision the link asks for, from the tab page or the revision list. */
async function findSpecificRevision(songId, revisionId, pageUrl, get, errors) {
  const html = await tryGet(get, pageUrl, 'text', errors, 'tab page');
  const fromPage = html && extractStateFromHtml(html);
  if (fromPage && Number(fromPage.revisionId) === revisionId) return fromPage;

  const list = await tryGet(get, `${SONGSTERR}/api/meta/${songId}/revisions`, 'json', errors, 'revision list');
  const entries = Array.isArray(list) ? list : list?.revisions || [];
  const match = entries.find((r) => r && Number(r.revisionId) === revisionId && r.image);
  if (match) {
    // Revision entries may lack the song details; borrow them from the current meta.
    const meta = fromPage || (await tryGet(get, `${SONGSTERR}/api/meta/${songId}`, 'json', errors, 'song info'));
    return { ...(meta || {}), ...match, tracks: match.tracks || meta?.tracks };
  }
  return null;
}

async function findRevision(songId, pageUrl, get, wantedRevision = null) {
  const errors = [];
  if (wantedRevision) {
    const specific = await findSpecificRevision(songId, wantedRevision, pageUrl, get, errors);
    if (specific) return specific;
  }
  const meta = await tryGet(get, `${SONGSTERR}/api/meta/${songId}`, 'json', errors, 'song info');
  const fromMeta = pickRevision(meta);
  if (fromMeta) return fromMeta;

  const html = await tryGet(get, pageUrl, 'text', errors, 'tab page');
  const fromPage = html && extractStateFromHtml(html);
  if (fromPage) return fromPage;
  if (html) errors.push('tab page had no song data');

  const revisions = await tryGet(get, `${SONGSTERR}/api/meta/${songId}/revisions`, 'json', errors, 'revision list');
  const fromRevisions = pickRevision(revisions);
  if (fromRevisions) return { ...(meta || {}), ...fromRevisions };

  const notFound = errors.every((e) => /returned 404/.test(e));
  throw new SongsterrError(
    notFound ? `Songsterr has no song with id ${songId}.` : `Could not reach Songsterr (${errors.join('; ')}).`,
    notFound ? 404 : 502
  );
}

async function fetchTrack(songId, revisionId, image, partId, get) {
  for (const host of CDN_HOSTS) {
    try {
      const res = await get(`${host}/${songId}/${revisionId}/${image}/${partId}.json`, 'json');
      if (res.ok && res.data && Array.isArray(res.data.measures)) return res.data;
      // 404 on the first host means the part doesn't exist; no point asking the mirror.
      if (!res.ok && res.status === 404) return null;
    } catch {
      // try the mirror
    }
  }
  return null;
}

/**
 * Downloads everything needed to render a song.
 * @param {string} input link or song id
 * @param {{ get: Function, onProgress?: (message: string) => void }} options
 */
export async function fetchSongsterrSong(input, { get, onProgress = () => {} }) {
  const { songId, url, trackIndex, revisionId: wantedRevision } = parseSongsterrUrl(input);
  const pageUrl = url || `${SONGSTERR}/a/wsa/tab-s${songId}`;

  onProgress('Finding the song...');
  const revision = await findRevision(songId, pageUrl, get, wantedRevision);
  const { revisionId, image } = revision;
  const warnings = [];
  if (wantedRevision && Number(revisionId) !== wantedRevision) {
    warnings.push(`Revision ${wantedRevision} from the link wasn't available, so this is the latest version of the tab.`);
  }
  const tracks = [];
  const metas = Array.isArray(revision.tracks) ? revision.tracks.map((t, i) => ({ ...t, partId: t.partId ?? i })) : [];

  if (metas.length > 0) {
    let done = 0;
    onProgress(`Downloading ${metas.length} track${metas.length === 1 ? '' : 's'}...`);
    const payloads = await Promise.all(
      metas.map(async (m) => {
        const data = await fetchTrack(songId, revisionId, image, m.partId, get);
        done++;
        onProgress(`Downloading tracks (${done} of ${metas.length})...`);
        return data;
      })
    );
    payloads.forEach((data, i) => {
      if (data) tracks.push({ meta: metas[i], data });
      else warnings.push(`Track "${metas[i].title || metas[i].name || i + 1}" could not be downloaded.`);
    });
  } else {
    // No track list: probe part ids until one is missing.
    for (let partId = 0; partId < MAX_PROBED_TRACKS; partId++) {
      onProgress(`Downloading track ${partId + 1}...`);
      const data = await fetchTrack(songId, revisionId, image, partId, get);
      if (!data) break;
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
    artist: typeof revision.artist === 'string' ? revision.artist : revision.artist?.name || '',
    source: url || songUrl({ songId, artist: revision.artist, title: revision.title }),
    trackIndex,
    tracks,
    warnings
  };
}

/**
 * Searches Songsterr by artist or title.
 * @returns {Promise<{ songId: number, title: string, artist: string, instruments: string[], url: string }[]>}
 */
export async function searchSongsterr(query, { get, limit = 20 }) {
  const q = String(query || '').trim();
  if (!q) return [];
  const errors = [];
  const pattern = encodeURIComponent(q);
  const data =
    (await tryGet(get, `${SONGSTERR}/api/songs?pattern=${pattern}&size=${limit}`, 'json', errors, 'search')) ??
    (await tryGet(get, `${SONGSTERR}/a/ra/songs.json?pattern=${pattern}`, 'json', errors, 'search'));
  if (!data) throw new SongsterrError(`Search failed (${errors.join('; ')}).`);

  const list = Array.isArray(data) ? data : data.songs || data.records || [];
  return list
    .map((s) => {
      const songId = Number(s.songId ?? s.id);
      const artist = typeof s.artist === 'string' ? s.artist : s.artist?.name || '';
      const title = s.title || s.name || 'Untitled';
      const instruments = (s.tracks || [])
        .map((t) => t.instrument || t.name || t.title)
        .filter(Boolean);
      return { songId, title, artist, instruments, url: songUrl({ songId, artist, title }) };
    })
    .filter((s) => Number.isFinite(s.songId) && s.songId > 0)
    .slice(0, limit);
}

/** A getter for Node/server use: plain fetch with browser-like headers. */
export function createServerGetter(fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 10000) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${SONGSTERR}/`
  };
  return async (url, type) => {
    const res = await fetchImpl(url, {
      headers: { ...headers, Accept: type === 'json' ? 'application/json, */*' : 'text/html,*/*' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, status: res.status };
    try {
      return { ok: true, data: type === 'json' ? await readJsonBody(res) : await res.text() };
    } catch {
      return { ok: false, status: 502 };
    }
  };
}
