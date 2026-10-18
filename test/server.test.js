import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, decodePath } from '../server.js';

test('a malformed path gets 400 and the server keeps running', async (t) => {
  assert.equal(decodePath('/%E0%A4%A'), null);
  assert.equal(decodePath('/vendor/sounds/a%20b.sf2'), '/vendor/sounds/a b.sf2');
  const server = createAppServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/vendor/alphatab/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
