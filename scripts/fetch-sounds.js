// Downloads the better-sounding instrument set (FluidR3 Mono, MIT licensed)
// into .cache/sounds/. The build copies it into the site; the local server
// serves it from there. Skips files that are already present.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.cache', 'sounds');
const BASE = 'https://raw.githubusercontent.com/musescore/MuseScore/v3.6.2/share/sound';
const FILES = [
  { name: 'FluidR3Mono_GM.sf3', minBytes: 20_000_000 },
  { name: 'FluidR3Mono_License.md', minBytes: 500 }
];

await mkdir(DIR, { recursive: true });
for (const { name, minBytes } of FILES) {
  const target = join(DIR, name);
  const existing = await stat(target).catch(() => null);
  if (existing && existing.size >= minBytes) {
    console.log(`${name}: already downloaded`);
    continue;
  }
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < minBytes) throw new Error(`${name}: unexpectedly small (${bytes.length} bytes)`);
  await writeFile(target, bytes);
  console.log(`${name}: ${(bytes.length / 1e6).toFixed(1)} MB`);
}
