// Listening to the shape of a recording: where the beats and bars are, which
// chords are playing, and which notes make the tune. Pure functions with no
// browser dependencies, used by the transcriber (src/transcriber-worker.js
// computes the features, public/js/transcribe.js writes the score).
//
// All feature series share one clock: FPS frames per second, frame i at
// i / FPS seconds (the model's hop of 256 samples at 22.05 kHz).

export const SAMPLE_RATE = 22050;
export const HOP = 256;
export const FPS = SAMPLE_RATE / HOP;

// The model works in 2-second windows; its frames drift slightly against the
// clock within each window. This is Basic Pitch's own frame-to-time mapping.
const MODEL_FPS = Math.floor(SAMPLE_RATE / HOP);
const MODEL_WINDOW_FRAMES = MODEL_FPS * 2;
const MODEL_WINDOW_OFFSET = (HOP / SAMPLE_RATE) * (MODEL_WINDOW_FRAMES - (SAMPLE_RATE * 2 - HOP) / HOP) + 0.0018;
export const modelFrameTime = (frame) => (frame * HOP) / SAMPLE_RATE - MODEL_WINDOW_OFFSET * Math.floor(frame / MODEL_WINDOW_FRAMES);

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const LOW_SPLIT = 52; // E3: notes below are the bass register

// ---------------------------------------------------------------------------
// Onset strength from the sound itself (drums included)
// ---------------------------------------------------------------------------

const FFT_SIZE = 1024;
let fftTables = null;

function fftSetup() {
  if (fftTables) return fftTables;
  const n = FFT_SIZE;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  fftTables = { rev, cos, sin, window };
  return fftTables;
}

/** Magnitude spectrum (first half) of FFT_SIZE samples starting at `start`. */
function magnitudes(audio, start, re, im, out) {
  const { rev, cos, sin, window } = fftSetup();
  const n = FFT_SIZE;
  for (let i = 0; i < n; i++) {
    const s = start + i;
    re[rev[i]] = s >= 0 && s < audio.length ? audio[s] * window[i] : 0;
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const a = i + j;
        const b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k];
        const ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
}

/**
 * Spectral flux: how much new sound starts in each frame, in two bands (all,
 * and below about 200 Hz where the kick drum and bass live). Can be fed in
 * pieces: pass the state returned by the previous call.
 * Returns { all: number[], low: number[], state }.
 */
export function spectralFlux(audio, state = null, { final = false } = {}) {
  const half = FFT_SIZE / 2;
  // Frame i is centred on sample i * HOP of the whole recording; `base` is the
  // recording position of samples[0], which holds what later frames still need.
  const st = state || { prev: new Float32Array(half), samples: new Float32Array(0), base: 0, next: 0 };
  const joined = new Float32Array(st.samples.length + audio.length);
  joined.set(st.samples);
  joined.set(audio, st.samples.length);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(half);
  const all = [];
  const low = [];
  const lowBins = Math.round((200 / SAMPLE_RATE) * FFT_SIZE);
  const end = st.base + joined.length;
  while (final ? st.next < end : st.next + half <= end) {
    magnitudes(joined, st.next - half - st.base, re, im, mag);
    let a = 0;
    let l = 0;
    for (let i = 1; i < half; i++) {
      const v = Math.log1p(100 * mag[i]);
      const d = v - st.prev[i];
      if (d > 0) {
        a += d;
        if (i <= lowBins) l += d;
      }
      st.prev[i] = v;
    }
    all.push(a);
    low.push(l);
    st.next += HOP;
  }
  // Keep what the next frames still need.
  const keepFrom = Math.max(st.base, st.next - half);
  st.samples = joined.slice(keepFrom - st.base);
  st.base = keepFrom;
  return { all, low, state: st };
}

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

function normalize(env) {
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length || 1;
  let sd = 0;
  for (const v of env) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / (env.length || 1)) || 1;
  return Float64Array.from(env, (v) => Math.max(0, (v - mean) / sd));
}

/** Removes the slowly changing part so only the starts of sounds stand out. */
function highpass(env, width = 16) {
  const out = new Float64Array(env.length);
  let sum = 0;
  const q = [];
  for (let i = 0; i < env.length; i++) {
    q.push(env[i]);
    sum += env[i];
    if (q.length > width) sum -= q.shift();
    out[i] = Math.max(0, env[i] - sum / q.length);
  }
  return out;
}

/** Most songs sit between about 70 and 160 beats per minute. */
function tempoPrior(bpm, centre = 115) {
  const octaves = Math.log2(bpm / centre);
  return Math.exp(-(octaves * octaves) / (2 * 0.5 * 0.5));
}

/**
 * The most likely beat period (in frames) from the onset strength's
 * autocorrelation, with a gentle preference for common tempos and for
 * periods whose double and half also line up (a steady pulse).
 */
export function estimatePeriod(env, fps = FPS, { minBpm = 50, maxBpm = 220 } = {}) {
  const n = env.length;
  const maxLag = Math.min(n - 1, Math.ceil((fps * 60) / minBpm) * 2);
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (n - lag);
  }
  const at = (lag) => {
    const i = Math.floor(lag);
    const f = lag - i;
    return i + 1 <= maxLag ? ac[i] * (1 - f) + ac[i + 1] * f : 0;
  };
  let best = { score: -Infinity, lag: (fps * 60) / 110 };
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    const lag = (fps * 60) / bpm;
    if (lag * 2 > maxLag) continue;
    // A steady pulse also repeats at twice the period, and its eighths line up.
    const score = (at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag / 2)) * tempoPrior(bpm);
    if (score > best.score) best = { score, lag, bpm };
  }
  return best.lag;
}

/**
 * Finds the beats: times (seconds) where a steady pulse lines up with the
 * starts of sounds, allowing the tempo to drift the way players do
 * (dynamic programming, after Ellis 2007).
 * @param {ArrayLike<number>} strength onset strength per frame
 * @returns {{ beats: number[], bpm: number, period: number }}
 */
export function trackBeats(strength, { fps = FPS, period = null, tightness = 120 } = {}) {
  const env = normalize(highpass(strength));
  const n = env.length;
  if (n < fps * 2) return { beats: [], bpm: 100, period: fps * 0.6 };
  const P = period || estimatePeriod(env, fps);
  // Smooth the onsets a little so near misses still count.
  const w = Math.max(1, Math.round(P / 16));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * Math.exp(-0.5 * ((k / w) * 2) ** 2);
    }
    local[i] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(P / 2);
  const hi = Math.round(P * 2);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let arg = -1;
    for (let prev = i - hi; prev <= i - lo; prev++) {
      if (prev < 0) continue;
      const v = score[prev] - tightness * Math.log((i - prev) / P) ** 2;
      if (arg < 0 || v > best) {
        best = v;
        arg = prev;
      }
    }
    score[i] = local[i] + (arg >= 0 ? Math.max(0, best) : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }
  // The last beat: the best-scoring frame within the final period.
  let end = n - 1;
  for (let i = Math.max(0, n - Math.round(P)); i < n; i++) if (score[i] > score[end]) end = i;
  const frames = [];
  for (let i = end; i >= 0; i = back[i]) frames.push(i);
  frames.reverse();
  // Trim weak beats at the start and end (silence or ring-out).
  const strong = (f) => local[f] > 0.2;
  while (frames.length > 2 && !strong(frames[0]) && !strong(frames[1])) frames.shift();
  while (frames.length > 2 && !strong(frames[frames.length - 1])) frames.pop();
  const beats = frames.map((f) => f / fps);
  return { beats, bpm: averageBpm(beats) || (60 * fps) / P, period: P };
}

/** The overall tempo of a run of beats (a straight-line fit, so it is not rounded to frames). */
export function averageBpm(beats) {
  const n = beats.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  const my = beats.reduce((s, b) => s + b, 0) / n;
  let num = 0;
  let den = 0;
  beats.forEach((b, i) => {
    num += (i - mx) * (b - my);
    den += (i - mx) ** 2;
  });
  return num > 0 ? (60 * den) / num : null;
}

/**
 * Extends the beats backwards and forwards with the local beat length so
 * every note has beats around it.
 */
export function extendBeats(beats, from, to) {
  if (beats.length < 2) return beats;
  const out = beats.slice();
  const head = out[1] - out[0];
  while (out[0] - head > from - head) out.unshift(out[0] - head);
  const tail = out[out.length - 1] - out[out.length - 2];
  while (out[out.length - 1] < to + tail) out.push(out[out.length - 1] + tail);
  return out;
}

/** Where `time` falls in beats: beat index plus the fraction to the next. */
export function beatPosition(beats, time) {
  let lo = 0;
  let hi = beats.length - 1;
  if (time <= beats[0]) return (time - beats[0]) / (beats[1] - beats[0]);
  if (time >= beats[hi]) return hi + (time - beats[hi]) / (beats[hi] - beats[hi - 1]);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo + (time - beats[lo]) / (beats[lo + 1] - beats[lo]);
}

// ---------------------------------------------------------------------------
// Harmony: chroma per beat and chord names
// ---------------------------------------------------------------------------

/**
 * Compact harmony features from the model's note activations: for each model
 * frame, pitch-class energy in the middle register (chords and tunes) and in
 * the bass register. `frames` is either an array of rows or a flat
 * Float32Array of n rows of 88 pitches (MIDI 21 to 108).
 * Returns { times: Float64Array, mid: Float32Array(n*12), bass: Float32Array(n*12) }.
 */
export function harmonyFeatures(frames, { n = frames.length, frameTime = modelFrameTime, firstFrame = 0 } = {}) {
  const flat = frames instanceof Float32Array;
  const times = new Float64Array(n);
  const mid = new Float32Array(n * 12);
  const bass = new Float32Array(n * 12);
  for (let i = 0; i < n; i++) {
    times[i] = frameTime(firstFrame + i);
    for (let p = 28 - 21; p <= 84 - 21; p++) {
      const v = flat ? frames[i * 88 + p] : frames[i][p];
      const pc = (p + 21) % 12;
      if (p + 21 < LOW_SPLIT) bass[i * 12 + pc] += v;
      if (p + 21 >= 36) mid[i * 12 + pc] += v;
    }
  }
  return { times, mid, bass };
}

/** Joins harmony features computed piece by piece. */
export function joinHarmony(parts) {
  const n = parts.reduce((s, p) => s + p.times.length, 0);
  const out = { times: new Float64Array(n), mid: new Float32Array(n * 12), bass: new Float32Array(n * 12) };
  let o = 0;
  for (const p of parts) {
    out.times.set(p.times, o);
    out.mid.set(p.mid, o * 12);
    out.bass.set(p.bass, o * 12);
    o += p.times.length;
  }
  return out;
}

function firstIndexAt(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Pitch-class energy between two times, from one of the harmony series ('mid', 'bass' or 'both'). */
function chromaBetween(h, which, t0, t1) {
  const c = new Float64Array(12);
  for (let i = firstIndexAt(h.times, t0); i < h.times.length && h.times[i] < t1; i++) {
    for (let k = 0; k < 12; k++) {
      if (which !== 'bass') c[k] += h.mid[i * 12 + k];
      if (which !== 'mid') c[k] += h.bass[i * 12 + k];
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

// How much each scale step sounds in major and minor music (Krumhansl and Kessler).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Sharps (+) or flats (-) in the key signature of each major key, by tonic.
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function correlation(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12;
  const mb = b.reduce((s, v) => s + v, 0) / 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Note names for a key: flats in flat keys, sharps in sharp keys. */
export function namesForKey(key) {
  if (!key || key.fifths === 0) return NAMES;
  return key.fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
}

/**
 * The key of the music, from how much each pitch class sounds overall.
 * Returns { tonic, minor, fifths, name, confidence }.
 */
export function findKey(harmony) {
  const total = new Float64Array(12);
  for (let i = 0; i < harmony.times.length; i++) {
    for (let k = 0; k < 12; k++) total[k] += harmony.mid[i * 12 + k] + harmony.bass[i * 12 + k];
  }
  const sum = total.reduce((a, b) => a + b, 0) || 1;
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const profileScore = (tonic, minor) => {
    const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
    return correlation(total, Array.from({ length: 12 }, (_, k) => profile[(k - tonic + 12) % 12]));
  };
  // The key signature: the major scale that holds the most of what is heard
  // (the profile breaks near-ties).
  let best = null;
  for (let major = 0; major < 12; major++) {
    const inScale = MAJOR_SCALE.reduce((s, step) => s + total[(major + step) % 12], 0) / sum;
    const score = inScale + 0.15 * Math.max(profileScore(major, false), profileScore((major + 9) % 12, true));
    if (!best || score > best.score) best = { score, major, inScale };
  }
  // Major, or its relative minor?
  const relative = (best.major + 9) % 12;
  const minor = profileScore(relative, true) > profileScore(best.major, false);
  const tonic = minor ? relative : best.major;
  const fifths = MAJOR_FIFTHS[best.major];
  const names = fifths < 0 ? FLAT_NAMES : fifths > 0 ? SHARP_NAMES : NAMES;
  return { tonic, minor, fifths, name: `${names[tonic]} ${minor ? 'minor' : 'major'}`, confidence: best.inScale };
}

/** A chord's name spelled for the key (Db rather than C# in A-flat major). */
export function spellChord(chord, key) {
  return namesForKey(key)[chord.root] + chord.quality;
}

/** Chord shapes as pitch classes above the root, with how much each tone counts. */
export const CHORD_QUALITIES = {
  '': { tones: [0, 4, 7], weights: [1, 1, 0.8] },
  m: { tones: [0, 3, 7], weights: [1, 1, 0.8] },
  7: { tones: [0, 4, 7, 10], weights: [1, 1, 0.7, 0.8] },
  m7: { tones: [0, 3, 7, 10], weights: [1, 1, 0.7, 0.8] },
  maj7: { tones: [0, 4, 7, 11], weights: [1, 1, 0.7, 0.8] },
  sus4: { tones: [0, 5, 7], weights: [1, 1, 0.8] },
  sus2: { tones: [0, 2, 7], weights: [1, 1, 0.8] },
  dim: { tones: [0, 3, 6], weights: [1, 1, 1] },
  5: { tones: [0, 7], weights: [1, 1] }
};
// Simple chords first: a richer name has to fit clearly better to be used.
const QUALITY_BIAS = { '': 0.04, m: 0.04, 5: -0.02, 7: -0.03, m7: -0.03, maj7: -0.05, sus4: -0.05, sus2: -0.06, dim: -0.08 };

const CHORDS = [];
for (let root = 0; root < 12; root++) {
  for (const [quality, { tones, weights }] of Object.entries(CHORD_QUALITIES)) {
    const t = new Float64Array(12);
    tones.forEach((tone, k) => (t[(root + tone) % 12] = weights[k]));
    const norm = Math.hypot(...t);
    CHORDS.push({ root, quality, name: NAMES[root] + quality, template: t.map((v) => v / norm), tones: new Set(tones.map((tone) => (root + tone) % 12)) });
  }
}

export function chordName(root, quality) {
  return NAMES[root] + quality;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
  }
  return na ? dot / Math.sqrt(na) : 0;
}

/**
 * Names the chord on each beat, then smooths the sequence so chords change
 * only when the music clearly does, preferring changes on strong beats.
 * Returns one entry per beat: { root, quality, name } or null for no chord.
 */
export function chordsPerBeat(harmony, beats, { beatsPerBar = 4, downbeat = 0 } = {}) {
  if (beats.length < 2) return [];
  const spans = beats.map((b, i) => [b, beats[i + 1] ?? b + (b - beats[i - 1])]);
  const chroma = spans.map(([t0, t1]) => chromaBetween(harmony, 'mid', t0, t1));
  const bass = spans.map(([t0, t1]) => chromaBetween(harmony, 'bass', t0, t1));
  const energy = chroma.map((c) => c.reduce((s, v) => s + v, 0));
  const loud = [...energy].sort((a, b) => a - b)[Math.floor(energy.length * 0.9)] || 1;
  // Emission scores per beat for each chord, plus "no chord".
  const K = CHORDS.length;
  const emit = chroma.map((c, i) => {
    const b = bass[i];
    const bassTotal = b.reduce((s, v) => s + v, 0) || 1;
    const row = new Float64Array(K + 1);
    for (let k = 0; k < K; k++) {
      const ch = CHORDS[k];
      // The bass usually plays the root; a chord tone in the bass is fine too.
      const bassFit = (b[ch.root] + 0.4 * [...ch.tones].reduce((s, pc) => s + (pc === ch.root ? 0 : b[pc]), 0)) / bassTotal;
      row[k] = cosine(c, ch.template) + 0.45 * bassFit + QUALITY_BIAS[ch.quality];
    }
    row[K] = energy[i] < loud * 0.08 ? 1.2 : 0.3; // silence
    return row;
  });
  // Viterbi: staying costs nothing, changing costs more off the strong beats.
  const strongBeat = (i) => ((i - downbeat) % beatsPerBar + beatsPerBar) % beatsPerBar;
  const changeCost = (i) => {
    const pos = strongBeat(i);
    if (pos === 0) return 0.12;
    if (beatsPerBar % 2 === 0 && pos === beatsPerBar / 2) return 0.2;
    return 0.32;
  };
  const n = emit.length;
  let prev = emit[0].slice();
  const back = [];
  for (let i = 1; i < n; i++) {
    let bestPrev = 0;
    for (let k = 1; k <= K; k++) if (prev[k] > prev[bestPrev]) bestPrev = k;
    const cost = changeCost(i);
    const cur = new Float64Array(K + 1);
    const ptr = new Int32Array(K + 1);
    for (let k = 0; k <= K; k++) {
      const stay = prev[k];
      const move = prev[bestPrev] - cost;
      if (stay >= move) {
        cur[k] = stay + emit[i][k];
        ptr[k] = k;
      } else {
        cur[k] = move + emit[i][k];
        ptr[k] = bestPrev;
      }
    }
    back.push(ptr);
    prev = cur;
  }
  let k = 0;
  for (let j = 1; j <= K; j++) if (prev[j] > prev[k]) k = j;
  const path = [k];
  for (let i = back.length - 1; i >= 0; i--) {
    k = back[i][k];
    path.push(k);
  }
  path.reverse();
  return path.map((idx) => (idx === K ? null : CHORDS[idx]));
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/**
 * Which beat starts the bars, and how many beats a bar has (when `meter` is
 * null): bars usually start where the harmony changes, the bass plays and
 * the kick drum hits. Returns { beatsPerBar, downbeat } where downbeat is the
 * index of a beat that starts a bar.
 */
export function findBars(beats, { harmony, low = null, notes = [], meter = null }) {
  const n = beats.length;
  if (n < 4) return { beatsPerBar: meter || 4, downbeat: 0 };
  const spans = beats.map((b, i) => [b, beats[i + 1] ?? b + (b - beats[i - 1])]);
  const chroma = spans.map(([t0, t1]) => chromaBetween(harmony, 'both', t0, t1));
  const change = chroma.map((c, i) => {
    if (!i) return 0;
    const a = chroma[i - 1];
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < 12; k++) {
      dot += a[k] * c[k];
      na += a[k] * a[k];
      nb += c[k] * c[k];
    }
    return na && nb ? 1 - dot / Math.sqrt(na * nb) : 0;
  });
  // Bass notes starting near each beat.
  const bassHit = new Float64Array(n);
  for (const note of notes) {
    if (note.pitch >= LOW_SPLIT) continue;
    const pos = beatPosition(beats, note.start);
    const i = Math.round(pos);
    if (i >= 0 && i < n && Math.abs(pos - i) < 0.15) bassHit[i] += note.velocity;
  }
  const kick = new Float64Array(n);
  if (low) {
    for (let i = 0; i < n; i++) {
      const f = Math.round(beats[i] * FPS);
      let m = 0;
      for (let k = f - 3; k <= f + 3; k++) if (k >= 0 && k < low.length) m = Math.max(m, low[k]);
      kick[i] = m;
    }
  }
  const z = (arr) => {
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 1;
    return Array.from(arr, (v) => (v - mean) / sd);
  };
  const cz = z(change);
  const bz = z(bassHit);
  const kz = low ? z(kick) : new Array(n).fill(0);
  const feature = cz.map((v, i) => 1.0 * v + 0.6 * bz[i] + 0.4 * kz[i]);
  let best = { contrast: -Infinity, beatsPerBar: meter || 4, downbeat: 0 };
  for (const B of meter ? [meter] : [4, 3]) {
    for (let phase = 0; phase < B; phase++) {
      let on = 0;
      let count = 0;
      for (let i = phase; i < n; i += B) {
        on += feature[i];
        count++;
      }
      const mean = feature.reduce((s, v) => s + v, 0) / n;
      // Three-beat bars have to fit clearly better before a song counts as a waltz.
      const contrast = on / (count || 1) - mean - (B === 3 ? 0.15 : 0);
      if (contrast > best.contrast) best = { contrast, beatsPerBar: B, downbeat: phase };
    }
  }
  return { beatsPerBar: best.beatsPerBar, downbeat: best.downbeat };
}

// ---------------------------------------------------------------------------
// The tune
// ---------------------------------------------------------------------------

export const MELODY_WEIGHTS = { velocity: 0.3, duration: 0.25, standOut: 0.6, top: 0.06, crowd: 0.15, height: 0.6, skip: 0.4, jump: 0.045, leap: 0.65, overlap: 0.1, ringing: 0.2, register: 0.5 };

/**
 * Picks the melody from everything that was heard: one note at a time,
 * preferring loud, long notes that stand out from the chords around them,
 * and moving smoothly from note to note (a beam search over the note starts).
 */
export function melodyLine(notes, { minPitch = 48, weights = MELODY_WEIGHTS } = {}) {
  const w = { ...MELODY_WEIGHTS, ...weights };
  const sorted = notes.filter((n) => n.pitch >= minPitch).sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  // Overtones of a louder note that is still ringing are not part of the tune.
  const candidates = sorted.filter(
    (n) =>
      !sorted.some(
        (base) =>
          base !== n &&
          [12, 19, 24].includes(n.pitch - base.pitch) &&
          base.start <= n.start + 0.03 &&
          base.start + base.duration > n.start + 0.05 &&
          base.velocity >= n.velocity * 1.15
      )
  );
  if (!candidates.length) return [];
  // Group notes starting together.
  const groups = [];
  for (const n of candidates) {
    const g = groups[groups.length - 1];
    if (g && n.start - g.time < 0.04) g.notes.push(n);
    else groups.push({ time: n.start, notes: [n] });
  }
  const velocities = candidates.map((n) => n.velocity).sort((a, b) => a - b);
  const loud = velocities[Math.floor(velocities.length * 0.95)] || 1;
  // Notes still ringing when a group starts (for "stands out" and overlap).
  const salience = (n, group) => {
    const others = group.notes.filter((m) => m !== n);
    const highest = Math.max(...group.notes.map((m) => m.pitch));
    const crowd = group.notes.length;
    const meanOthers = others.length ? others.reduce((s, m) => s + m.velocity, 0) / others.length : n.velocity - 0.1;
    const standOut = Math.max(-0.1, Math.min(0.3, n.velocity - meanOthers));
    return (
      w.velocity * Math.min(1.2, n.velocity / loud) +
      w.duration * Math.min(1, Math.log1p(n.duration * 4) / Math.log1p(4)) +
      w.standOut * standOut +
      (n.pitch === highest ? w.top : 0) -
      (crowd >= 3 && standOut < 0.05 ? w.crowd : 0) +
      ((n.pitch - 60) / 24) * w.height
    );
  };
  // Beam search: states are (last chosen note, score).
  let beam = [{ last: null, score: 0, path: [] }];
  const BEAM = 12;
  for (const group of groups) {
    const next = [];
    const scores = new Map(group.notes.map((n) => [n, salience(n, group)]));
    const best = Math.max(...scores.values());
    for (const state of beam) {
      // Skip this group (no new tune note here). Cheaper while the last note still rings.
      const ringing = state.last && state.last.start + state.last.duration > group.time + 0.05;
      next.push({ last: state.last, score: state.score - Math.max(0, best) * w.skip * (ringing ? 1 - w.ringing : 1), path: state.path });
      for (const n of group.notes) {
        let s = scores.get(n);
        if (state.last) {
          const jump = Math.abs(n.pitch - state.last.pitch);
          s -= Math.max(0, jump - 2) * w.jump + (jump > 12 ? w.leap : 0);
          // Cutting short a loud note that is still ringing is less likely.
          if (ringing && n.pitch !== state.last.pitch) s -= w.overlap;
          // A voice or solo keeps to its range: notes far from the recent ones
          // are more likely another instrument.
          const recent = state.path.slice(-8).map((m) => m.pitch).sort((a, b) => a - b);
          if (recent.length >= 4) {
            const away = Math.abs(n.pitch - recent[recent.length >> 1]);
            if (away > 7) s -= (w.register * (away - 7)) / 12;
          }
        }
        next.push({ last: n, score: state.score + s, path: state.path.concat(n) });
      }
    }
    // Keep the best state per last note, then the best few overall.
    const byLast = new Map();
    for (const st of next) {
      if (!byLast.has(st.last) || byLast.get(st.last).score < st.score) byLast.set(st.last, st);
    }
    beam = [...byLast.values()].sort((a, b) => b.score - a.score).slice(0, BEAM);
  }
  // Monophonic: each note ends when the next one starts. Small gaps (a singer
  // breathing, a note dying away) are joined, as a person would write them.
  const path = beam[0].path;
  return path.map((n, i) => {
    const next = path[i + 1];
    let end = n.start + n.duration;
    if (next) end = next.start - end < 0.35 ? next.start : Math.min(end, next.start);
    return { ...n, duration: Math.max(0.05, end - n.start) };
  });
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/**
 * Onset strength on the FPS clock: the sound's own changes (which include the
 * drums) mixed evenly with the model's note starts (which ignore noise).
 * onsetSums[i] is the model's total onset activation in model frame i.
 */
export function onsetStrength(flux, onsetSums, frameTime = modelFrameTime) {
  const n = Math.max(flux.length, onsetSums.length ? Math.round(frameTime(onsetSums.length - 1) * FPS) + 1 : 0);
  const model = new Float64Array(n);
  for (let i = 0; i < onsetSums.length; i++) {
    const k = Math.round(frameTime(i) * FPS);
    if (k >= 0 && k < n) model[k] += onsetSums[i];
  }
  const scale = (a) => {
    const sorted = Array.from(a).sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length * 0.95)] || 1;
  };
  const fs = scale(flux);
  const ms = scale(model);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * ((flux[i] || 0) / fs) + 0.5 * (model[i] / ms);
  return out;
}

/**
 * Finds the beats and bars of a recording. Returns null when there is no
 * steady pulse to follow (the score then uses a steady grid).
 * @returns {{ beats: number[], bpm: number, beatsPerBar: number, downbeat: number, harmony: object } | null}
 */
export function analyzeRecording({ notes, flux, low = null, onsetSums, harmony, meter = null }) {
  if (!notes.length) return null;
  const { beats: tracked, bpm } = trackBeats(onsetStrength(flux, onsetSums));
  if (tracked.length < 6) return null;
  const first = Math.min(...notes.map((n) => n.start));
  const last = Math.max(...notes.map((n) => n.start + n.duration));
  const beats = extendBeats(tracked, first - 1, last + 1);
  const bars = findBars(beats, { harmony, low, notes, meter });
  return { beats, bpm, beatsPerBar: bars.beatsPerBar, downbeat: bars.downbeat, harmony, key: findKey(harmony) };
}
