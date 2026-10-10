// Builds a static copy of the app into dist/ for GitHub Pages (or any static
// host): the public/ folder plus the alphaTab files it needs.
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'dist');
const ALPHATAB = join(ROOT, 'node_modules', '@coderline', 'alphatab', 'dist');
const VENDOR = join(OUT, 'vendor', 'alphatab');

await rm(OUT, { recursive: true, force: true });
await cp(join(ROOT, 'public'), OUT, { recursive: true });

await mkdir(VENDOR, { recursive: true });
// Only the ES module build is used: alphaTab.mjs, its core, worker and worklet.
for (const file of await readdir(ALPHATAB)) {
  if (/^alphaTab\.(core\.|worker\.|worklet\.)?mjs$/.test(file)) await cp(join(ALPHATAB, file), join(VENDOR, file));
}
await cp(join(ALPHATAB, 'font'), join(VENDOR, 'font'), { recursive: true });
await mkdir(join(VENDOR, 'soundfont'), { recursive: true });
for (const file of ['sonivox.sf2', 'LICENSE', 'README.md']) {
  await cp(join(ALPHATAB, 'soundfont', file), join(VENDOR, 'soundfont', file));
}

// Tell GitHub Pages not to run Jekyll over the files.
await writeFile(join(OUT, '.nojekyll'), '');

// Site settings read by the page. RELAY_URL points at an optional relay
// (see relay/worker.js) that lets the site fetch from Songsterr reliably.
const relay = (process.env.RELAY_URL || '').trim();
await writeFile(join(OUT, 'config.json'), JSON.stringify({ relay }, null, 2));
console.log(`Static site written to ${OUT}`);
