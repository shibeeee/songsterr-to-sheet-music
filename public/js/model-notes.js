// Reads notes from the transcription model's output: the same method as
// Spotify Basic Pitch's outputToNotesPoly (Apache-2.0), rewritten to run in
// time proportional to the recording's length. The original searches the
// whole recording again for every leftover note, which took most of a minute
// on a three-minute song.
//
// frames and onsets are flat Float32Arrays of n rows of 88 pitches (MIDI 21
// to 108), one row per model frame.

import { modelFrameTime } from './analysis.js';

const PITCHES = 88;
const MIDI_OFFSET = 21;
const ENERGY_TOLERANCE = 11;

/**
 * Note starts inferred from rising frame activations, merged with the
 * model's own onsets (as Basic Pitch's inferOnsets does).
 */
function inferredOnsets(frames, onsets, n) {
  const diff = new Float32Array(n * PITCHES);
  let diffMax = 0;
  let onsetMax = 0;
  for (let i = 0; i < n * PITCHES; i++) onsetMax = Math.max(onsetMax, onsets[i]);
  for (let r = 2; r < n; r++) {
    for (let c = 0; c < PITCHES; c++) {
      const v = frames[r * PITCHES + c];
      const d = Math.max(0, Math.min(v - frames[(r - 1) * PITCHES + c], v - frames[(r - 2) * PITCHES + c]));
      diff[r * PITCHES + c] = d;
      if (d > diffMax) diffMax = d;
    }
  }
  const out = new Float32Array(n * PITCHES);
  const scale = diffMax ? onsetMax / diffMax : 0;
  for (let i = 0; i < n * PITCHES; i++) out[i] = Math.max(onsets[i], diff[i] * scale);
  return out;
}

/**
 * @param {{ frames: Float32Array, onsets: Float32Array, n: number }} output
 * @param {{ onsetThreshold?: number, frameThreshold?: number, minNoteFrames?: number,
 *   firstFrame?: number }} settings firstFrame offsets the times (for pieces of a recording)
 * @returns {Array<{ start: number, duration: number, pitch: number, velocity: number, onset: number }>}
 */
export function modelNotes({ frames, onsets, n }, settings = {}) {
  const { onsetThreshold = 0.5, frameThreshold = 0.3, minNoteFrames = 6, firstFrame = 0 } = settings;
  if (n < 3) return [];
  const inferred = inferredOnsets(frames, onsets, n);
  const remaining = frames.slice(0, n * PITCHES);
  const events = [];

  const clear = (row, f) => {
    remaining[row * PITCHES + f] = 0;
    if (f < PITCHES - 1) remaining[row * PITCHES + f + 1] = 0;
    if (f > 0) remaining[row * PITCHES + f - 1] = 0;
  };
  const amplitude = (from, to, f) => {
    let sum = 0;
    for (let r = from; r < to; r++) sum += frames[r * PITCHES + f];
    return sum / (to - from);
  };

  // Note starts: peaks in time of the inferred onsets, above the threshold,
  // handled from the end of the recording backwards (as the original does).
  const starts = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < PITCHES; c++) {
      const v = inferred[r * PITCHES + c];
      if (v <= onsetThreshold) continue;
      if (r > 0 && !(v > inferred[(r - 1) * PITCHES + c])) continue;
      if (r < n - 1 && !(v > inferred[(r + 1) * PITCHES + c])) continue;
      starts.push(r * PITCHES + c);
    }
  }
  for (let s = starts.length - 1; s >= 0; s--) {
    const start = Math.floor(starts[s] / PITCHES);
    const f = starts[s] % PITCHES;
    if (start >= n - 1) continue;
    let i = start + 1;
    let k = 0;
    while (i < n - 1 && k < ENERGY_TOLERANCE) {
      if (remaining[i * PITCHES + f] < frameThreshold) k++;
      else k = 0;
      i++;
    }
    i -= k;
    if (i - start <= minNoteFrames) continue;
    for (let j = start; j < i; j++) clear(j, f);
    events.push({ startFrame: start, durationFrames: i - start, f, amplitude: amplitude(start, i, f) });
  }

  // Leftover energy that never had a clear start (the "melodia trick"):
  // repeatedly take the strongest remaining cell and follow it both ways.
  // Cells only ever drop to zero, so visiting them strongest first, skipping
  // cleared ones, finds the same maximum each time without searching again.
  const cells = [];
  for (let i = 0; i < n * PITCHES; i++) if (remaining[i] > frameThreshold) cells.push(i);
  // Ties: the earliest frame, then the highest pitch (as the original picks them).
  cells.sort((a, b) => remaining[b] - remaining[a] || Math.floor(a / PITCHES) - Math.floor(b / PITCHES) || (b % PITCHES) - (a % PITCHES));
  const value = Float32Array.from(cells, (i) => remaining[i]);
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (remaining[cell] !== value[c] || remaining[cell] <= frameThreshold) continue;
    const mid = Math.floor(cell / PITCHES);
    const f = cell % PITCHES;
    remaining[cell] = 0;
    let i = mid + 1;
    let k = 0;
    while (i < n - 1 && k < ENERGY_TOLERANCE) {
      if (remaining[i * PITCHES + f] < frameThreshold) k++;
      else k = 0;
      clear(i, f);
      i++;
    }
    const end = i - 1 - k;
    i = mid - 1;
    k = 0;
    while (i > 0 && k < ENERGY_TOLERANCE) {
      if (remaining[i * PITCHES + f] < frameThreshold) k++;
      else k = 0;
      clear(i, f);
      i--;
    }
    const start = i + 1 + k;
    if (end - start <= minNoteFrames) continue;
    events.push({ startFrame: start, durationFrames: end - start, f, amplitude: amplitude(start, end, f) });
  }

  return events.map((e) => {
    let onset = 0;
    for (let r = e.startFrame - 1; r <= e.startFrame + 1; r++) if (r >= 0 && r < n) onset = Math.max(onset, onsets[r * PITCHES + e.f]);
    const t0 = modelFrameTime(firstFrame + e.startFrame);
    return {
      start: t0,
      duration: modelFrameTime(firstFrame + e.startFrame + e.durationFrames) - t0,
      pitch: e.f + MIDI_OFFSET,
      velocity: e.amplitude,
      onset
    };
  });
}
