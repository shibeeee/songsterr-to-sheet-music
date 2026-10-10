import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  parseSongsterrUrl,
  isSongsterrLink,
  songUrl,
  extractStateFromHtml,
  fetchSongsterrSong,
  searchSongsterr,
  parseJsonBytes,
  createServerGetter
} from '../public/js/songsterr.js';

const CDN = 'https://dqsljvtekg760.cloudfront.net';
const MIRROR = 'https://d3d3l6a6rcgkaf.cloudfront.net';

test('parses Songsterr links and bare ids', () => {
  const full = parseSongsterrUrl('https://www.songsterr.com/a/wsa/some-band-some-song-tab-s12345');
  assert.equal(full.songId, 12345);
  assert.equal(full.trackIndex, null);
  const withTrack = parseSongsterrUrl('https://www.songsterr.com/a/wsa/some-band-some-song-tab-s12345t2?x=1#y');
  assert.equal(withTrack.songId, 12345);
  assert.equal(withTrack.trackIndex, 2);
  assert.equal(withTrack.url, 'https://www.songsterr.com/a/wsa/some-band-some-song-tab-s12345t2');
  assert.equal(parseSongsterrUrl('songsterr.com/a/wsa/song-tab-s99').songId, 99);
  assert.equal(parseSongsterrUrl('777').songId, 777);
  assert.throws(() => parseSongsterrUrl('https://example.com/tab-s1'), /songsterr\.com/);
  assert.throws(() => parseSongsterrUrl('https://www.songsterr.com/a/wsa/no-id-here'), /song id/);
});

test('tells links from search text', () => {
  assert.equal(isSongsterrLink('https://www.songsterr.com/a/wsa/x-tab-s1'), true);
  assert.equal(isSongsterrLink('songsterr.com/a/wsa/x-tab-s1'), true);
  assert.equal(isSongsterrLink('12345'), true);
  assert.equal(isSongsterrLink('blackbird beatles'), false);
});

test('builds canonical song links', () => {
  assert.equal(songUrl({ songId: 5, artist: 'Some Band', title: 'Café Song!' }), 'https://www.songsterr.com/a/wsa/some-band-cafe-song-tab-s5');
  assert.equal(songUrl({ songId: 5 }), 'https://www.songsterr.com/a/wsa/tab-s5');
});

test('reads embedded page state', () => {
  const current = { songId: 5, revisionId: 10, image: 'abc', title: 'T', artist: 'A', tracks: [] };
  const html = `<html><script id="state" type="application/json">${JSON.stringify({ meta: { current } })}</script></html>`;
  assert.deepEqual(extractStateFromHtml(html), current);
  assert.equal(extractStateFromHtml('<html></html>'), null);
});

test('decodes gzip and plain JSON bodies', async () => {
  const value = { measures: [1, 2, 3] };
  assert.deepEqual(await parseJsonBytes(new Uint8Array(gzipSync(JSON.stringify(value)))), value);
  assert.deepEqual(await parseJsonBytes(new TextEncoder().encode(JSON.stringify(value))), value);
});

/** A fake `get` serving a fixed set of URLs; everything else is a 404. */
function fakeGet(routes) {
  const calls = [];
  const get = async (url, type) => {
    calls.push(url);
    const value = routes[url];
    if (value === undefined) return { ok: false, status: 404 };
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return { ok: false, status: value };
    return { ok: true, data: type === 'text' ? String(value) : value };
  };
  get.calls = calls;
  return get;
}

const track = (name) => ({ name, instrumentId: 25, tuning: [64, 59, 55, 50, 45, 40], measures: [{ voices: [{ beats: [] }] }] });

test('fetches a song through the metadata API', async () => {
  const get = fakeGet({
    'https://www.songsterr.com/api/meta/42': {
      songId: 42, revisionId: 7, image: 'img', title: 'Song', artist: 'Artist',
      tracks: [{ partId: 0, title: 'Lead' }, { partId: 1, title: 'Rhythm' }]
    },
    [`${CDN}/42/7/img/0.json`]: track('Lead'),
    [`${CDN}/42/7/img/1.json`]: track('Rhythm')
  });
  const progress = [];
  const song = await fetchSongsterrSong('https://www.songsterr.com/a/wsa/artist-song-tab-s42t1', {
    get,
    onProgress: (m) => progress.push(m)
  });
  assert.equal(song.title, 'Song');
  assert.equal(song.artist, 'Artist');
  assert.equal(song.trackIndex, 1);
  assert.deepEqual(song.tracks.map((t) => t.meta.title), ['Lead', 'Rhythm']);
  assert.deepEqual(song.warnings, []);
  assert.ok(progress.some((m) => /2 of 2/.test(m)));
  assert.ok(!get.calls.some((u) => u.includes('/a/wsa/')), 'page not needed when the API answers');
});

test('falls back to the tab page, then probes tracks', async () => {
  const link = 'https://www.songsterr.com/a/wsa/x-tab-s9';
  const current = { songId: 9, revisionId: 3, image: 'i', title: 'Paged' };
  const get = fakeGet({
    'https://www.songsterr.com/api/meta/9': 503,
    [link]: `<script id="state">${JSON.stringify({ meta: { current } })}</script>`,
    [`${CDN}/9/3/i/0.json`]: track('One'),
    [`${CDN}/9/3/i/1.json`]: track('Two')
  });
  const song = await fetchSongsterrSong(link, { get });
  assert.equal(song.title, 'Paged');
  assert.deepEqual(song.tracks.map((t) => t.data.name), ['One', 'Two']);
});

test('uses the mirror CDN when the first one refuses', async () => {
  const get = fakeGet({
    'https://www.songsterr.com/api/meta/3': { songId: 3, revisionId: 1, image: 'i', title: 'S', tracks: [{ partId: 0 }] },
    [`${CDN}/3/1/i/0.json`]: 403,
    [`${MIRROR}/3/1/i/0.json`]: track('Mirror')
  });
  const song = await fetchSongsterrSong('3', { get });
  assert.equal(song.tracks[0].data.name, 'Mirror');
});

test('reports missing tracks as warnings', async () => {
  const get = fakeGet({
    'https://www.songsterr.com/api/meta/4': { songId: 4, revisionId: 1, image: 'i', tracks: [{ partId: 0, title: 'Ok' }, { partId: 1, title: 'Gone' }] },
    [`${CDN}/4/1/i/0.json`]: track('Ok')
  });
  const song = await fetchSongsterrSong('4', { get });
  assert.equal(song.tracks.length, 1);
  assert.match(song.warnings[0], /Gone/);
});

test('says "no such song" for 404s and "could not reach" for network errors', async () => {
  await assert.rejects(fetchSongsterrSong('1', { get: fakeGet({}) }), (err) => err.status === 404 && /no song/.test(err.message));
  const offline = async () => {
    throw new Error('offline');
  };
  await assert.rejects(fetchSongsterrSong('1', { get: offline }), (err) => err.status === 502 && /Could not reach/.test(err.message));
});

test('searches and normalises results', async () => {
  const get = fakeGet({
    'https://www.songsterr.com/api/songs?pattern=some%20song&size=20': [
      { songId: 11, title: 'Some Song', artist: 'Band', tracks: [{ instrument: 'Guitar' }, { instrument: 'Bass' }] },
      { id: 12, title: 'Other', artist: { name: 'Other Band' } },
      { title: 'no id' }
    ]
  });
  const results = await searchSongsterr('some song', { get });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    songId: 11, title: 'Some Song', artist: 'Band', instruments: ['Guitar', 'Bass'],
    url: 'https://www.songsterr.com/a/wsa/band-some-song-tab-s11'
  });
  assert.equal(results[1].artist, 'Other Band');
  assert.deepEqual(await searchSongsterr('   ', { get }), []);
});

test('the server getter sends browser headers and decodes gzip', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init.headers;
    return new Response(gzipSync(JSON.stringify({ ok: 1 })), { status: 200 });
  };
  const get = createServerGetter(fetchImpl);
  assert.deepEqual(await get(`${CDN}/x.json`, 'json'), { ok: true, data: { ok: 1 } });
  assert.match(seen['User-Agent'], /Mozilla/);
  const missing = createServerGetter(async () => new Response('', { status: 404 }));
  assert.deepEqual(await missing('https://www.songsterr.com/x', 'text'), { ok: false, status: 404 });
});
