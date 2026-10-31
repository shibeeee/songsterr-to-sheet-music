// Bundles the audio transcriber (src/transcriber-worker.js: Spotify's Basic
// Pitch model on TensorFlow.js) into .cache/transcriber/, with the model files
// and licenses. The local server and the static build both serve that folder
// as vendor/transcriber/.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.cache', 'transcriber');
const BASIC_PITCH = join(ROOT, 'node_modules', '@spotify', 'basic-pitch');

export async function bundleTranscriber() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'src', 'transcriber-worker.js')],
    outfile: join(OUT, 'transcriber-worker.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    // It only ever runs in a worker, where there is no window. TensorFlow.js
    // has a check written as `!window`, which throws there instead of being false.
    define: { window: 'undefined' }
  });
  await cp(join(BASIC_PITCH, 'model'), join(OUT, 'model'), { recursive: true });
  await cp(join(BASIC_PITCH, 'LICENSE'), join(OUT, 'LICENSE-basic-pitch.txt'));
  return OUT;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await bundleTranscriber();
  console.log(`Transcriber written to ${out}`);
}
