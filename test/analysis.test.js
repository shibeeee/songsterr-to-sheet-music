import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore } from '../public/js/convert.js';
import {
  FPS,
  trackBeats,
  findBars,
  chordsPerBeat,
  harmonyFeatures,
  melodyLine,
  spectralFlux,
  beatPosition,
  analyzeRecording,
  modelFrameTime
} from '../public/js/analysis.js';
import { modelNotes } from '../public/js/model-notes.js';
import { notesToBundle, chordShape, mergeRetriggers } from '../public/js/transcribe.js';

// Synthetic test material ------------------------------------------------------

let seed = 5;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Onset strength with a click on every beat (and quieter eighths), seconds long. */
function clicks(beatTimes, seconds) {
  const env = new Float64Array(Math.ceil(seconds * FPS));
  for (const t of beatTimes) {
    const i = Math.round(t * FPS);
    if (i < env.length) env[i] += 1;
    const half = Math.round((t + 0.25) * FPS);
    if (half < env.length) env[half] += 0.4;
  }
  for (let i = 0; i < env.length; i++) env[i] += random() * 0.1;
  return env;
}

/** Model-style note activations (rows of 88) for chords held between beats. */
function chordFrames(beats, chordPerBeat) {
  const n = Math.ceil((beats[beats.length - 1] + 1) * FPS);
  const frames = Array.from({ length: n }, () => new Array(88).fill(0));
  beats.forEach((b, i) => {
    const pitches = chordPerBeat[i] || [];
    const end = beats[i + 1] ?? b + 0.5;
    for (let f = 0; f < n; f++) {
      const t = modelFrameTime(f);
      if (t >= b && t < end) for (const p of pitches) frames[f][p - 21] = 0.8;
    }
  });
  return frames;
}

const C = [36, 48, 52, 55, 60];
const G = [43, 55, 59, 62, 67];
const Am = [45, 57, 60, 64, 69];
const F = [41, 53, 57, 60, 65];

// Beats and bars ----------------------------------------------------------------

test('follows the beat, including a tempo that drifts', () => {
  const beats = [];
  let t = 0.3;
  for (let i = 0; i < 48; i++) {
    beats.push(t);
    t += 60 / (100 + 7 * Math.sin(i / 8)); // 93 to 107 bpm, like a band without a click
  }
  const found = trackBeats(clicks(beats, t + 1)).beats;
  const hits = beats.filter((b) => found.some((f) => Math.abs(f - b) < 0.05)).length;
  assert.ok(hits / beats.length > 0.9, `found ${hits} of ${beats.length} beats`);
  assert.ok(found.length <= beats.length + 2, `${found.length} beats for ${beats.length}`);
});

test('reports a steady tempo precisely', () => {
  const beats = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.5); // 120 bpm
  const { bpm } = trackBeats(clicks(beats, 21));
  assert.ok(Math.abs(bpm - 120) < 1, `${bpm} bpm`);
});

test('finds where bars start and how many beats they have, from the harmony', () => {
  const beats = Array.from({ length: 32 }, (_, i) => i * 0.5);
  const progression = [C, G, Am, F];
  // 4/4, the first bar line on beat 1 (beat 0 is a pickup)
  const four = beats.map((_, i) => (i < 1 ? C : progression[Math.floor((i - 1) / 4) % 4]));
  const harmony4 = harmonyFeatures(chordFrames(beats, four));
  assert.deepEqual(findBars(beats, { harmony: harmony4 }), { beatsPerBar: 4, downbeat: 1 });
  // 3/4
  const three = beats.map((_, i) => progression[Math.floor(i / 3) % 4]);
  const harmony3 = harmonyFeatures(chordFrames(beats, three));
  const bars3 = findBars(beats, { harmony: harmony3 });
  assert.equal(bars3.beatsPerBar, 3);
  assert.equal(bars3.downbeat % 3, 0);
  // A meter that was chosen stays
  assert.equal(findBars(beats, { harmony: harmony3, meter: 4 }).beatsPerBar, 4);
});

test('names the chords and changes them only when the harmony does', () => {
  const beats = Array.from({ length: 16 }, (_, i) => i * 0.5);
  const per = beats.map((_, i) => [C, G, Am, F][Math.floor(i / 4)]);
  const chords = chordsPerBeat(harmonyFeatures(chordFrames(beats, per)), beats, { beatsPerBar: 4, downbeat: 0 });
  assert.deepEqual(
    chords.map((c) => c?.name),
    ['C', 'C', 'C', 'C', 'G', 'G', 'G', 'G', 'Am', 'Am', 'Am', 'Am', 'F', 'F', 'F', 'F']
  );
});

test('beat positions between and beyond the beats', () => {
  const beats = [1, 1.5, 2, 2.5];
  assert.equal(beatPosition(beats, 1.25), 0.5);
  assert.equal(beatPosition(beats, 2.5), 3);
  assert.equal(beatPosition(beats, 0.5), -1);
  assert.equal(beatPosition(beats, 3), 4);
});

// Notes -------------------------------------------------------------------------

test('reads notes from the model output, quickly', () => {
  const n = 400;
  const frames = new Float32Array(n * 88);
  const onsets = new Float32Array(n * 88);
  // A4 (pitch 69) from frame 50 to 120, then again from 200 to 260 (a new start).
  for (const [from, to] of [[50, 120], [200, 260]]) {
    for (let f = from; f < to; f++) frames[f * 88 + 48] = 0.9;
    onsets[from * 88 + 48] = 0.95;
  }
  const notes = modelNotes({ frames, onsets, n });
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((x) => x.pitch), [69, 69]);
  assert.ok(Math.abs(notes[0].start - modelFrameTime(50)) < 1e-9);
  assert.ok(Math.abs(notes[0].duration - (modelFrameTime(120) - modelFrameTime(50))) < 0.02);
  assert.ok(notes.every((x) => x.onset > 0.9));

  // A three-minute recording takes well under a second.
  const big = 15500;
  const bigFrames = new Float32Array(big * 88);
  const bigOnsets = new Float32Array(big * 88);
  for (let i = 0; i < bigFrames.length; i++) bigFrames[i] = random() < 0.02 ? 0.4 + random() * 0.5 : random() * 0.2;
  for (let i = 0; i < bigOnsets.length; i++) bigOnsets[i] = random() < 0.003 ? 0.6 + random() * 0.4 : 0;
  const started = performance.now();
  modelNotes({ frames: bigFrames, onsets: bigOnsets, n: big });
  assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
});

test('a held note split by vibrato is joined; a played repeat is not', () => {
  const notes = [
    { start: 1, duration: 0.5, pitch: 72, velocity: 0.7, onset: 0.9 },
    { start: 1.5, duration: 0.5, pitch: 72, velocity: 0.7, onset: 0.55 }, // vibrato
    { start: 2, duration: 0.3, pitch: 72, velocity: 0.7, onset: 0.95 }, // played again
    { start: 3, duration: 0.25, pitch: 40, velocity: 0.7, onset: 0.8 },
    { start: 3.25, duration: 0.25, pitch: 40, velocity: 0.7, onset: 0.6 } // legato bass: stays
  ];
  const merged = mergeRetriggers(notes);
  assert.deepEqual(merged.map((n) => [n.start, n.pitch]), [[1, 72], [2, 72], [3, 40], [3.25, 40]]);
  assert.equal(merged[0].duration, 1);
});

test('picks the tune out of chords', () => {
  const notes = [];
  const tune = [72, 74, 76, 77, 79, 77, 76, 74];
  tune.forEach((p, i) => notes.push({ start: i * 0.5, duration: 0.45, pitch: p, velocity: 0.8 }));
  // Strummed chords underneath, on every beat, a little quieter.
  for (let i = 0; i < 8; i++) for (const p of [48, 55, 60, 64]) notes.push({ start: i * 0.5 + 0.01, duration: 0.3, pitch: p, velocity: 0.55 });
  const line = melodyLine(notes);
  assert.deepEqual(line.map((n) => n.pitch), tune);
});

test('spectral flux is the same in pieces as all at once', () => {
  const audio = new Float32Array(22050 * 2);
  for (let i = 0; i < audio.length; i++) audio[i] = (i % 5512 < 300 ? 1 : 0) * Math.sin(i / 3);
  const whole = spectralFlux(audio, null, { final: true }).all;
  let state = null;
  const parts = [];
  for (let i = 0; i < audio.length; i += 3000) {
    const r = spectralFlux(audio.subarray(i, i + 3000), state, { final: i + 3000 >= audio.length });
    state = r.state;
    parts.push(...r.all);
  }
  assert.equal(parts.length, whole.length);
  parts.forEach((v, i) => assert.ok(Math.abs(v - whole[i]) < 1e-3, `frame ${i}`));
});

// Writing it out ----------------------------------------------------------------

test('chord shapes are real guitar shapes', () => {
  const frets = (root, q) => {
    const byString = new Map(chordShape(root, q).map((n) => [n.string, n.fret]));
    return [5, 4, 3, 2, 1, 0].map((s) => (byString.has(s) ? byString.get(s) : 'x')).join('');
  };
  assert.equal(frets(0, ''), 'x32010'); // C
  assert.equal(frets(7, ''), '320003'); // G
  assert.equal(frets(5, ''), '133211'); // F: barre
  assert.equal(frets(10, ''), 'x13331'); // Bb: barre on the A string
  assert.equal(frets(11, 'm'), 'x24432'); // Bm
  assert.equal(frets(4, '5'), '022xxx'); // E5
});

test('follows the beats found in a recording and writes chords to strum', () => {
  // 8 bars of C G Am F at 96 bpm, strummed on every beat, bars starting on beat 0.
  const beatLength = 60 / 96;
  const beats = Array.from({ length: 34 }, (_, i) => 0.4 + i * beatLength);
  const per = beats.map((_, i) => [C, G, Am, F][Math.floor(i / 4) % 4]);
  const notes = [];
  beats.slice(0, 32).forEach((b, i) => {
    for (const p of per[i].slice(1)) notes.push({ start: b + 0.01, duration: beatLength * 0.8, pitch: p, velocity: 0.6 });
    if (i % 4 === 0) notes.push({ start: b, duration: beatLength * 3.5, pitch: per[i][0], velocity: 0.8 });
  });
  const harmony = harmonyFeatures(chordFrames(beats, per));
  const env = clicks(beats, beats.at(-1) + 1);
  const analysis = analyzeRecording({ notes, flux: Array.from(env), onsetSums: [], harmony });
  assert.ok(analysis, 'found a beat');
  assert.equal(analysis.beatsPerBar, 4);
  assert.ok(Math.abs(analysis.bpm - 96) < 1.5, `${analysis.bpm} bpm`);

  const bundle = notesToBundle(notes, { mode: 'chords', analysis });
  const track = bundle.tracks[0].data;
  assert.equal(track.fixedFingering, true);
  assert.equal(bundle.transcription.followsBeats, true);
  const names = track.measures.flatMap((m) => m.voices[0].beats.filter((b) => b.chord).map((b) => b.chord.text));
  assert.deepEqual(names.slice(0, 8), ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F']);
  // The first bar: four strums of a C shape.
  const first = track.measures[0].voices[0].beats.filter((b) => !b.rest);
  assert.equal(first.length, 4);
  assert.deepEqual(first[0].notes.map((n) => `${n.string}:${n.fret}`).sort(), ['0:0', '1:1', '2:0', '3:2', '4:3']);
  for (const m of track.measures) assert.equal(m.voices[0].beats.reduce((s, b) => s + b.duration[0] / b.duration[1], 0), 1);

  // Every mode opens as a score.
  for (const mode of ['chords', 'melody', 'bass', 'guitar', 'band']) {
    const { score } = songsterrToScore(alphaTab, notesToBundle(notes, { mode, analysis }));
    assert.ok(score.masterBars.length >= 8, mode);
  }
  // Half and double tempo follow the same beats.
  assert.equal(notesToBundle(notes, { mode: 'chords', analysis, tempoScale: 0.5 }).transcription.bpm, Math.round(analysis.bpm / 2));
  assert.equal(notesToBundle(notes, { mode: 'chords', analysis, tempoScale: 2 }).transcription.bpm, Math.round(analysis.bpm * 2));
});

test('finds the key and spells chords for it', async () => {
  const { findKey, spellChord } = await import('../public/js/analysis.js');
  const beats = Array.from({ length: 16 }, (_, i) => i * 0.5);
  const Ab = [44, 56, 60, 63, 68];
  const Db = [37, 49, 53, 56, 61];
  const Eb = [39, 51, 55, 58, 63];
  const Fm = [41, 53, 56, 60, 65];
  const per = beats.map((_, i) => [Ab, Db, Eb, Fm][Math.floor(i / 4)]);
  const key = findKey(harmonyFeatures(chordFrames(beats, per)));
  assert.equal(key.name, 'Ab major');
  assert.equal(key.fifths, -4);
  assert.equal(spellChord({ root: 1, quality: '' }, key), 'Db');
  assert.equal(spellChord({ root: 6, quality: 'm' }, { fifths: 2 }), 'F#m');
  // G D Em C is G major (one sharp), not C major.
  const G = [43, 55, 59, 62, 67];
  const D = [38, 50, 54, 57, 62];
  const Em = [40, 52, 55, 59, 64];
  const per2 = beats.map((_, i) => [G, D, Em, C][Math.floor(i / 4)]);
  assert.equal(findKey(harmonyFeatures(chordFrames(beats, per2))).fifths, 1);
});

test('a song name and artist from a YouTube title', async () => {
  const { songFromVideoTitle } = await import('../public/js/audio-input.js');
  const cases = [
    ['Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley', 'Never Gonna Give You Up', 'Rick Astley'],
    ['The Beatles - The Beatles - Let It Be (Official Music Video) [Remastered 2015]', 'The Beatles', 'Let It Be', 'The Beatles'],
    ['Numb (Official Music Video) [4K UPGRADE] – Linkin Park', 'Linkin Park', 'Numb', 'Linkin Park'],
    ['Let It Be - The Beatles (acoustic cover)', 'Some Singer', 'Let It Be', 'The Beatles'],
    ['Wonderwall', 'OasisVEVO', 'Wonderwall', 'Oasis'],
    ['Oasis - Live Forever', 'Oasis', 'Live Forever', 'Oasis']
  ];
  for (const [title, channel, name, artist] of cases) assert.deepEqual(songFromVideoTitle(title, channel), { name, artist }, title);
});

test('strummed chords need no ties', () => {
  // Off-beat strums and a chord held across a bar line.
  const beatLength = 0.5;
  const beats = Array.from({ length: 20 }, (_, i) => i * beatLength);
  const per = beats.map((_, i) => (i < 8 ? C : G));
  const notes = [];
  for (const b of [0, 0.75, 1.25, 2.25, 3.5, 5.25]) for (const p of [48, 52, 55]) notes.push({ start: b, duration: 0.6, pitch: p + (b > 4 ? 7 : 0), velocity: 0.6 });
  const harmony = harmonyFeatures(chordFrames(beats, per));
  const analysis = { beats, bpm: 120, beatsPerBar: 4, downbeat: 0, harmony, key: { fifths: 0, minor: false, name: 'C major' } };
  const bundle = notesToBundle(notes, { mode: 'chords', analysis });
  const ties = bundle.tracks[0].data.measures.flatMap((m) => m.voices[0].beats).filter((b) => b.notes.some((n) => n.tie));
  assert.equal(ties.length, 0);
  assert.equal(bundle.key.name, 'C major');
});
