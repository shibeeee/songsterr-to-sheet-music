import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSongsterrUrl, extractStateFromHtml, fetchSongsterrSong } from '../lib/songsterr.js';

test('parses Songsterr links and bare ids', () => {
  assert.equal(parseSongsterrUrl('https://www.songsterr.com/a/wsa/some-band-some-song-tab-s12345').songId, 12345);
  assert.equal(parseSongsterrUrl('https://www.songsterr.com/a/wsa/some-band-some-song-tab-s12345t2?x=1#y').songId, 12345);
  assert.equal(parseSongsterrUrl('songsterr.com/a/wsa/song-tab-s99').songId, 99);
  assert.equal(parseSongsterrUrl('777').songId, 777);
  assert.throws(() => parseSongsterrUrl('https://example.com/tab-s1'), /songsterr\.com/);
  assert.throws(() => parseSongsterrUrl('https://www.songsterr.com/a/wsa/no-id-here'), /song id/);
  assert.throws(() => parseSongsterrUrl('not a url at all'), /link/);
});

test('reads embedded page state', () => {
  const current = { songId: 5, revisionId: 10, image: 'abc', title: 'T', artist: 'A', tracks: [] };
  const html = `<html><script id="state" type="application/json">${JSON.stringify({ meta: { current } })}</script></html>`;
  assert.deepEqual(extractStateFromHtml(html), current);
  assert.equal(extractStateFromHtml('<html></html>'), null);
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    return typeof body === 'string'
      ? new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
      : Response.json(body);
  };
  fn.calls = calls;
  return fn;
}

const track = (name) => ({ name, instrumentId: 25, tuning: [64, 59, 55, 50, 45, 40], measures: [{ voices: [{ beats: [] }] }] });

test('fetches tracks using the page state', async () => {
  const link = 'https://www.songsterr.com/a/wsa/artist-song-tab-s42';
  const current = { songId: 42, revisionId: 7, image: 'img', title: 'Song', artist: 'Artist', tracks: [{ partId: 0, title: 'Lead' }, { partId: 1, title: 'Rhythm' }] };
  const fetch = fakeFetch({
    [link]: `<script id="state">${JSON.stringify({ meta: { current } })}</script>`,
    'https://dqsljvtekg760.cloudfront.net/42/7/img/0.json': track('Lead'),
    'https://dqsljvtekg760.cloudfront.net/42/7/img/1.json': track('Rhythm')
  });
  const song = await fetchSongsterrSong(link, { fetch });
  assert.equal(song.title, 'Song');
  assert.equal(song.artist, 'Artist');
  assert.deepEqual(song.tracks.map((t) => t.meta.title), ['Lead', 'Rhythm']);
  assert.deepEqual(song.warnings, []);
});

test('falls back to the metadata API and probes tracks when needed', async () => {
  const fetch = fakeFetch({
    'https://www.songsterr.com/api/meta/42': { songId: 42, revisionId: 8, image: 'img2', title: 'Song' },
    'https://dqsljvtekg760.cloudfront.net/42/8/img2/0.json': track('One'),
    'https://dqsljvtekg760.cloudfront.net/42/8/img2/1.json': track('Two')
  });
  const song = await fetchSongsterrSong('https://www.songsterr.com/a/wsa/artist-song-tab-s42', { fetch });
  assert.deepEqual(song.tracks.map((t) => t.data.name), ['One', 'Two']);
});

test('uses the mirror CDN when the first one refuses', async () => {
  const link = 'https://www.songsterr.com/a/wsa/x-tab-s3';
  const current = { songId: 3, revisionId: 1, image: 'i', title: 'S', tracks: [{ partId: 0 }] };
  const routes = {
    [link]: `<script id="state">${JSON.stringify({ meta: { current } })}</script>`,
    'https://d3d3l6a6rcgkaf.cloudfront.net/3/1/i/0.json': track('Mirror')
  };
  const fetch = async (url) => {
    if (url.startsWith('https://dqsljvtekg760')) return new Response('nope', { status: 403 });
    return fakeFetch(routes)(url);
  };
  const song = await fetchSongsterrSong(link, { fetch });
  assert.equal(song.tracks[0].data.name, 'Mirror');
});

test('reports a clear error when nothing can be found', async () => {
  await assert.rejects(fetchSongsterrSong('https://www.songsterr.com/a/wsa/x-tab-s1', { fetch: fakeFetch({}) }), /Could not load song 1/);
});
