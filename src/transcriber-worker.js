// Web worker that turns audio into notes with Spotify's Basic Pitch model
// (Apache-2.0). Bundled with esbuild by scripts/bundle-transcriber.js into
// vendor/transcriber/transcriber-worker.js.
//
// Messages in:
//   { type: 'transcribe', id, audio: Float32Array (mono, 22050 Hz), modelUrl }
//   { type: 'notes', id, settings }    re-reads notes with other settings
// Messages out:
//   { type: 'progress', id, value }    0..1
//   { type: 'notes', id, notes, onsetEnvelope, fps, backend }
//   { type: 'error', id, message }

import * as tf from '@tensorflow/tfjs';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';

const FPS = 22050 / 256; // the model's frames per second
let model = null;
let backend = null;
const results = new Map(); // id -> { frames, onsets }

async function ready(modelUrl) {
  if (!backend) {
    // The GPU (through an offscreen canvas) is many times faster; plain JS works everywhere.
    for (const name of ['webgl', 'cpu']) {
      try {
        if (await tf.setBackend(name)) {
          await tf.ready();
          backend = name;
          break;
        }
      } catch {
        // try the next one
      }
    }
  }
  if (!model) model = new BasicPitch(tf.loadGraphModel(modelUrl));
  return model;
}

function readNotes(frames, onsets, settings = {}) {
  const {
    onsetThreshold = 0.5,
    frameThreshold = 0.3,
    minNoteFrames = 6, // about 0.07 s: fast sixteenths still count
    minPitch = null,
    maxPitch = null
  } = settings;
  const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
  const events = outputToNotesPoly(
    frames,
    onsets,
    onsetThreshold,
    frameThreshold,
    minNoteFrames,
    true,
    maxPitch == null ? null : midiToHz(maxPitch + 0.5),
    minPitch == null ? null : midiToHz(minPitch - 0.5),
    true
  );
  return noteFramesToTime(events).map((n) => ({
    start: n.startTimeSeconds,
    duration: n.durationSeconds,
    pitch: n.pitchMidi,
    velocity: n.amplitude
  }));
}

/** How strongly notes start in each frame: the basis for finding the beat. */
function onsetEnvelope(onsets) {
  const out = new Float32Array(onsets.length);
  onsets.forEach((row, i) => {
    let sum = 0;
    for (const v of row) sum += v;
    out[i] = sum;
  });
  return out;
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'transcribe') {
      const basicPitch = await ready(data.modelUrl);
      const frames = [];
      const onsets = [];
      await basicPitch.evaluateModel(
        data.audio,
        (f, o) => {
          frames.push(...f);
          onsets.push(...o);
        },
        (value) => self.postMessage({ type: 'progress', id, value })
      );
      results.clear(); // one recording at a time keeps memory in check
      results.set(id, { frames, onsets });
      self.postMessage({ type: 'notes', id, notes: readNotes(frames, onsets, data.settings), onsetEnvelope: onsetEnvelope(onsets), fps: FPS, backend });
    } else if (type === 'notes') {
      const result = results.get(id);
      if (!result) throw new Error('That recording is no longer loaded. Transcribe it again.');
      self.postMessage({ type: 'notes', id, notes: readNotes(result.frames, result.onsets, data.settings), fps: FPS, backend });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
