// Downloads the better-sounding instrument set (GeneralUser GS by S. Christian
// Collins, free to use and redistribute in software) into .cache/sounds/.
// The build copies it into the site; the local server serves it from there.
// Skips files that are already present.
//
// It is an uncompressed SF2 on purpose: compressed (SF3) sets are decoded
// instrument by instrument when playback starts, which delays the first notes
// by a second or more. An SF2 does its work when it loads, which the app does
// in the background while nothing is playing.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.cache', 'sounds');
const BASE = 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main';
const FILES = [
  { name: 'GeneralUser-GS.sf2', from: 'GeneralUser-GS.sf2', minBytes: 30_000_000 },
  { name: 'GeneralUser-GS-License.txt', from: 'documentation/LICENSE.txt', minBytes: 500 }
];

await mkdir(DIR, { recursive: true });
for (const { name, from, minBytes } of FILES) {
  const target = join(DIR, name);
  const existing = await stat(target).catch(() => null);
  if (existing && existing.size >= minBytes) {
    console.log(`${name}: already downloaded`);
    continue;
  }
  const res = await fetch(`${BASE}/${from}`);
  if (!res.ok) throw new Error(`${name}: download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < minBytes) throw new Error(`${name}: unexpectedly small (${bytes.length} bytes)`);
  await writeFile(target, bytes);
  console.log(`${name}: ${(bytes.length / 1e6).toFixed(1)} MB`);
}
