import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../relay/worker.js';

const call = (path, init) => worker.fetch(new Request(`https://relay.example${path}`, init));

test('answers CORS preflight', async () => {
  const res = await call('/?url=x', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('only relays Songsterr addresses', async () => {
  assert.equal((await call('/?url=' + encodeURIComponent('https://example.com/'))).status, 403);
  assert.equal((await call('/?url=' + encodeURIComponent('http://www.songsterr.com/'))).status, 403);
  assert.equal((await call('/?url=not-a-url')).status, 400);
  assert.equal((await call('/', { method: 'POST' })).status, 405);
});

test('forwards to Songsterr with browser headers and adds CORS', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, init });
    return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const target = 'https://www.songsterr.com/api/meta/42';
  const res = await call('/?url=' + encodeURIComponent(target));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.equal(seen[0].url, target);
  assert.match(seen[0].init.headers['User-Agent'], /Mozilla/);
});

test('passes upstream errors through', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
  const res = await call('/?url=' + encodeURIComponent('https://dqsljvtekg760.cloudfront.net/1/2/i/0.json'));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
