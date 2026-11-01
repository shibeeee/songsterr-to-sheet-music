// Web worker that turns audio into notes with Spotify's Basic Pitch model
// (Apache-2.0). Bundled with esbuild by scripts/bundle-transcriber.js into
// vendor/transcriber/transcriber-worker.js.
//
// Audio can arrive all at once (a file) or bit by bit while it is recorded;
// the model listens to each 2-second window as soon as it is complete, so a
// live recording is mostly transcribed by the time it ends.
//
// Messages in:
//   { type: 'start', id, modelUrl, settings, live }   begins a recording
//   { type: 'audio', id, samples, sampleRate }         more sound (any rate, mono)
//   { type: 'end', id }                                no more sound
//   { type: 'transcribe', id, audio, modelUrl, settings }  start + audio + end (mono, 22050 Hz)
//   { type: 'notes', id, settings }                    re-reads notes with other settings
// Messages out:
//   { type: 'progress', id, value, seconds }           value 0..1 once the length is known
//   { type: 'partial', id, notes, from }               notes heard so far, from `from` seconds on
//   { type: 'notes', id, notes, features, seconds, backend, audio }  audio when settings.returnAudio
//   { type: 'error', id, message }

import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { modelNotes } from '../public/js/model-notes.js';
import { spectralFlux, harmonyFeatures, modelFrameTime } from '../public/js/analysis.js';

const RATE = 22050;
const HOP = 256;
const WINDOW = RATE * 2 - HOP; // samples the model hears at once
const OVERLAP = 30 * HOP; // windows overlap; the edges of each are dropped
const STEP = WINDOW - OVERLAP;
const EDGE = 15; // frames dropped at each end of a window
const LEAD = OVERLAP / 2; // silence before the recording, so its start is heard fully
const MODEL_FPS = Math.floor(RATE / HOP);
const PITCHES = 88;
const BATCH = 4; // windows per model run when several are waiting

let model = null;
let backend = null;
let session = null;
let lastResult = null; // { id, frames, onsets, n } for re-reading notes

let loading = null;

/** How long the model takes for one window on the current backend (after its first run). */
async function timeWindow() {
  const run = () => {
    const out = tf.tidy(() => model.execute(tf.zeros([1, WINDOW, 1]), ['Identity_1', 'Identity_2']));
    return out[0].data().then(() => out.forEach((t) => t.dispose()));
  };
  await run(); // the first run prepares the programs
  const started = performance.now();
  await run();
  return performance.now() - started;
}

async function use(name) {
  try {
    if (!(await tf.setBackend(name))) return false;
    await tf.ready();
    return true;
  } catch {
    return false;
  }
}

/** A software stand-in for a GPU is slower than WebAssembly. */
function realGpu() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2') || new OffscreenCanvas(1, 1).getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    return !!gl && !/swiftshader|llvmpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

/**
 * Loads the model once, on the fastest way this computer has: the GPU (through
 * an offscreen canvas) or WebAssembly, timed against each other, with plain
 * JavaScript as the last resort.
 */
function ready(modelUrl) {
  loading ||= (async () => {
    setWasmPaths(new URL('../', modelUrl).href);
    const timings = [];
    for (const name of [...(realGpu() ? ['webgl'] : []), 'wasm']) {
      if (!(await use(name))) continue;
      model ||= await tf.loadGraphModel(modelUrl);
      try {
        timings.push({ name, ms: await timeWindow() });
      } catch {
        // this backend can't run the model
      }
      // A quick GPU needs no comparison.
      if (name === 'webgl' && timings.at(-1)?.ms < 120) break;
    }
    const best = timings.sort((a, b) => a.ms - b.ms)[0];
    if (best) await use(best.name);
    else {
      await use('cpu');
      model ||= await tf.loadGraphModel(modelUrl);
    }
    backend = tf.getBackend();
    return model;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** A Float32Array that grows as values are appended. */
class Growing {
  constructor(size = 1 << 16) {
    this.data = new Float32Array(size);
    this.length = 0;
  }
  push(values) {
    if (this.length + values.length > this.data.length) {
      let size = this.data.length;
      while (size < this.length + values.length) size *= 2;
      const next = new Float32Array(size);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    this.data.set(values, this.length);
    this.length += values.length;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

/** Streaming resampler to 22050 Hz (windowed sinc), keeping its place between pieces. */
class Resampler {
  constructor(from) {
    this.ratio = from / RATE;
    this.cutoff = Math.min(1, RATE / from) * 0.92;
    this.taps = 16;
    this.buffer = new Float32Array(0);
    this.base = 0; // input index of buffer[0]
    this.pos = 0; // input position of the next output sample
  }
  push(input, final = false) {
    const joined = new Float32Array(this.buffer.length + input.length);
    joined.set(this.buffer);
    joined.set(input, this.buffer.length);
    const end = this.base + joined.length;
    const out = [];
    const { taps, cutoff } = this;
    while (final ? this.pos < end : this.pos + taps < end) {
      const centre = Math.floor(this.pos);
      let sum = 0;
      for (let k = centre - taps + 1; k <= centre + taps; k++) {
        const j = k - this.base;
        if (j < 0 || j >= joined.length) continue;
        const x = this.pos - k;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (taps + 1));
        const arg = Math.PI * x * cutoff;
        sum += joined[j] * (arg === 0 ? cutoff : (Math.sin(arg) / arg) * cutoff) * w;
      }
      out.push(sum);
      this.pos += this.ratio;
    }
    const keep = Math.max(this.base, Math.floor(this.pos) - taps);
    this.buffer = joined.slice(keep - this.base);
    this.base = keep;
    return Float32Array.from(out);
  }
}

function newSession(id, settings, live, modelUrl) {
  const audio = new Growing(RATE * 60);
  audio.push(new Float32Array(LEAD));
  return {
    id,
    modelUrl,
    settings: settings || {},
    live,
    audio,
    resampler: null,
    flux: { all: [], low: [], state: null },
    frames: new Growing(MODEL_FPS * 60 * PITCHES),
    onsets: new Growing(MODEL_FPS * 60 * PITCHES),
    windows: 0,
    ended: false,
    pumping: null,
    lastPartial: 0
  };
}

function addAudio(s, samples) {
  s.audio.push(samples);
  const f = spectralFlux(samples, s.flux.state);
  s.flux.state = f.state;
  s.flux.all.push(...f.all);
  s.flux.low.push(...f.low);
}

const heardSeconds = (s) => (s.audio.length - LEAD) / RATE;

/** Runs the model on every complete window (all of them once the sound has ended). */
async function pump(s) {
  for (;;) {
    if (session !== s) return; // cancelled or replaced
    const length = s.audio.length;
    const available = s.ended ? Math.max(1, Math.ceil(length / STEP)) : Math.max(0, Math.floor((length - WINDOW) / STEP) + 1);
    if (s.windows >= available) break;
    const count = Math.min(BATCH, available - s.windows);
    const input = new Float32Array(count * WINDOW);
    const all = s.audio.view();
    for (let b = 0; b < count; b++) {
      const from = (s.windows + b) * STEP;
      input.set(all.subarray(from, Math.min(from + WINDOW, all.length)), b * WINDOW);
    }
    const [framesT, onsetsT] = tf.tidy(() => model.execute(tf.tensor3d(input, [count, WINDOW, 1]), ['Identity_1', 'Identity_2']));
    const frameRows = framesT.shape[1];
    const [framesData, onsetsData] = await Promise.all([framesT.data(), onsetsT.data()]);
    framesT.dispose();
    onsetsT.dispose();
    if (session !== s) return;
    for (let b = 0; b < count; b++) {
      const from = (b * frameRows + EDGE) * PITCHES;
      const to = (b * frameRows + frameRows - EDGE) * PITCHES;
      s.frames.push(framesData.subarray(from, to));
      s.onsets.push(onsetsData.subarray(from, to));
    }
    s.windows += count;
    const total = s.ended ? available : null;
    self.postMessage({ type: 'progress', id: s.id, value: total ? s.windows / total : null, seconds: Math.min(heardSeconds(s), (s.windows * STEP) / RATE) });
    // Show what has been heard so far (the last few seconds' notes).
    const now = performance.now();
    if (s.live && (!s.ended || s.windows < available) && now - s.lastPartial > 900) {
      s.lastPartial = now;
      postPartial(s);
    }
  }
  if (s.ended && session === s) finish(s);
}

function postPartial(s) {
  const n = s.frames.length / PITCHES;
  const first = Math.max(0, n - MODEL_FPS * 8);
  const notes = modelNotes(
    { frames: s.frames.view().subarray(first * PITCHES), onsets: s.onsets.view().subarray(first * PITCHES), n: n - first },
    { ...s.settings, firstFrame: first }
  );
  self.postMessage({ type: 'partial', id: s.id, notes, from: modelFrameTime(first) });
}

function finish(s) {
  // The model hears whole windows; keep only the frames of the real recording.
  const n = Math.min(s.frames.length / PITCHES, Math.floor(((s.audio.length - LEAD) * MODEL_FPS) / RATE));
  const frames = s.frames.view().slice(0, n * PITCHES);
  const onsets = s.onsets.view().slice(0, n * PITCHES);
  const tail = spectralFlux(new Float32Array(0), s.flux.state, { final: true });
  const flux = Float32Array.from([...s.flux.all, ...tail.all]);
  const low = Float32Array.from([...s.flux.low, ...tail.low]);
  const onsetSums = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let p = 0; p < PITCHES; p++) sum += onsets[i * PITCHES + p];
    onsetSums[i] = sum;
  }
  const harmony = harmonyFeatures(frames, { n });
  lastResult = { id: s.id, frames, onsets, n };
  const notes = modelNotes(lastResult, s.settings);
  session = null;
  // The sound itself, when asked (to play back exactly what was transcribed).
  const audio = s.settings.returnAudio ? s.audio.view().slice(LEAD) : null;
  self.postMessage(
    { type: 'notes', id: s.id, notes, seconds: heardSeconds(s), backend, features: { flux, low, onsetSums, harmony }, audio },
    [flux.buffer, low.buffer, onsetSums.buffer, harmony.times.buffer, harmony.mid.buffer, harmony.bass.buffer, ...(audio ? [audio.buffer] : [])]
  );
}

function run(s) {
  s.pumping = (s.pumping || Promise.resolve())
    .then(() => pump(s))
    .catch((err) => {
      if (session === s) session = null;
      self.postMessage({ type: 'error', id: s.id, message: err?.message || String(err) });
    });
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'start' || type === 'transcribe') {
      session = newSession(id, data.settings, type === 'start' && !!data.live, data.modelUrl);
      const s = session;
      await ready(data.modelUrl);
      if (type === 'transcribe') {
        // A whole file: add it in pieces (for the onset strength), then finish.
        const audio = data.audio;
        for (let i = 0; i < audio.length; i += RATE * 10) addAudio(s, audio.subarray(i, i + RATE * 10));
        s.ended = true;
        s.live = true; // show notes as they are found
      } else if (data.live) s.live = true;
      if (session === s) run(s);
    } else if (type === 'audio') {
      const s = session;
      if (!s || s.id !== id || s.ended) return;
      if (data.sampleRate && data.sampleRate !== RATE) {
        s.resampler ||= new Resampler(data.sampleRate);
        addAudio(s, s.resampler.push(data.samples));
      } else addAudio(s, data.samples);
      if (model) run(s);
    } else if (type === 'end') {
      const s = session;
      if (!s || s.id !== id) return;
      if (s.resampler) addAudio(s, s.resampler.push(new Float32Array(0), true));
      s.ended = true;
      await ready(s.modelUrl);
      run(s);
    } else if (type === 'notes') {
      if (!lastResult || lastResult.id !== id) throw new Error('That recording is no longer loaded. Transcribe it again.');
      self.postMessage({ type: 'notes', id, notes: modelNotes(lastResult, data.settings), backend });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
