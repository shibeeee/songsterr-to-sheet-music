import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore } from '../public/js/convert.js';
import { rebuildScore } from '../public/js/editor.js';
import { optimizeFingering, convertToFourStringBass, canConvertToFourString, notePitch, BASS_4_STANDARD } from '../public/js/fingering.js';

const m = alphaTab.model;
const settings = new alphaTab.Settings();
const GUITAR = [64, 59, 55, 50, 45, 40];
const BASS5 = [43, 38, 33, 28, 23];
const BASS6 = [48, 43, 38, 33, 28, 23];

/** Builds a one-track score. Each bar is a list of beats; a beat is a list of [songsterrString, fret, extra?]. */
function scoreFrom(tuning, bars) {
  const measures = bars.map((beats, i) => ({
    ...(i === 0 ? { signature: [4, 4] } : {}),
    voices: [{ beats: beats.map((notes) => ({ type: 8, duration: [1, 8], notes: notes.map(([string, fret, extra]) => ({ string, fret, ...(extra || {}) })) })) }]
  }));
  return songsterrToScore(alphaTab, { title: 'Test', tracks: [{ data: { tuning, measures } }] }).score;
}

function allNotes(score) {
  const out = [];
  const staff = score.tracks[0].staves[0];
  for (const bar of staff.bars) for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) out.push({ n, staff });
  return out;
}

const pitches = (score) => allNotes(score).map(({ n, staff }) => notePitch(staff, n));

/** Total hand travel: sum of jumps between the lowest fretted fret of consecutive beats. */
function travel(score) {
  let last = null;
  let sum = 0;
  const staff = score.tracks[0].staves[0];
  for (const bar of staff.bars) {
    for (const beat of bar.voices[0].beats) {
      const frets = beat.notes.map((n) => n.fret).filter((f) => f > 0);
      if (!frets.length) continue;
      const pos = Math.min(...frets);
      if (last !== null) sum += Math.abs(pos - last);
      last = pos;
    }
  }
  return sum;
}

test('keeps every pitch and reduces hand travel on a jumpy line', () => {
  // A scale written entirely on the low E string (Songsterr string 5 = low E).
  const frets = [3, 5, 7, 8, 10, 12, 14, 15];
  let score = scoreFrom(GUITAR, [frets.map((f) => [[5, f]])]);
  const before = pitches(score);
  const travelBefore = travel(score);
  const result = optimizeFingering(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  assert.deepEqual(pitches(score), before);
  assert.ok(result.changed > 0);
  assert.ok(travel(score) < travelBefore, `travel ${travel(score)} should be below ${travelBefore}`);
  for (const { n } of allNotes(score)) assert.ok(n.fret >= 0 && n.fret <= 24);
});

test('chords stay playable: one note per string, within reach', () => {
  // A C major shape written high up the neck, then the same chord again.
  const chord = [[0, 8], [1, 8], [2, 9], [3, 10], [4, 10], [5, 8]];
  let score = scoreFrom(GUITAR, [[chord, chord, [[4, 3]], [[3, 2]]]]);
  const before = pitches(score);
  optimizeFingering(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  assert.deepEqual(pitches(score), before);
  for (const beat of score.tracks[0].staves[0].bars[0].voices[0].beats) {
    const strings = beat.notes.map((n) => n.string);
    assert.equal(new Set(strings).size, strings.length, 'one note per string');
    const fretted = beat.notes.map((n) => n.fret).filter((f) => f > 0);
    if (fretted.length) assert.ok(Math.max(...fretted) - Math.min(...fretted) <= 5, 'chord within reach');
  }
});

test('tied notes and hammer-ons stay on one string', () => {
  let score = scoreFrom(GUITAR, [[[[3, 7]], [[3, 7, { tie: true }]], [[2, 5, { hp: true }]], [[2, 7]], [[5, 3]]]]);
  optimizeFingering(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  const beats = score.tracks[0].staves[0].bars[0].voices[0].beats;
  assert.equal(beats[1].notes[0].string, beats[0].notes[0].string);
  assert.equal(beats[1].notes[0].fret, beats[0].notes[0].fret);
  assert.equal(beats[3].notes[0].string, beats[2].notes[0].string);
});

test('only the requested bars change', () => {
  const line = [[5, 12], [5, 14], [5, 15], [5, 17]];
  let score = scoreFrom(GUITAR, [line.map((x) => [x]), line.map((x) => [x])]);
  optimizeFingering(m, score, 0, { fromBar: 1, toBar: 1 });
  score = rebuildScore(alphaTab, score, settings);
  const firstBar = score.tracks[0].staves[0].bars[0].voices[0].beats.map((b) => b.notes[0].fret);
  assert.deepEqual(firstBar, [12, 14, 15, 17]);
});

test('converts a 5-string bass to 4 strings, moving low notes up an octave', () => {
  // Songsterr string 4 is the low B on a 5-string bass.
  let score = scoreFrom(BASS5, [[[[4, 0]], [[4, 3]], [[4, 5]], [[3, 0]], [[2, 2]], [[0, 5]]]]);
  const before = pitches(score);
  assert.equal(canConvertToFourString(score.tracks[0].staves[0]), true);
  const report = convertToFourStringBass(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  const staff = score.tracks[0].staves[0];
  assert.deepEqual(staff.tuning, BASS_4_STANDARD);
  assert.equal(report.octaveUp, 2); // low B and low D are below low E
  const after = pitches(score);
  assert.deepEqual(after, before.map((p) => (p < 28 ? p + 12 : p)));
  for (const { n } of allNotes(score)) assert.ok(n.string >= 1 && n.string <= 4 && n.fret >= 0);
  assert.equal(canConvertToFourString(staff), false);
});

test('renames "5-string" tracks after converting', () => {
  const score = scoreFrom(BASS5, [[[[3, 0]]]]);
  score.tracks[0].name = 'Bass (5-string)';
  convertToFourStringBass(m, score, 0);
  assert.equal(score.tracks[0].name, 'Bass (4-string)');
});

test('converts a 6-string bass, keeping high notes', () => {
  let score = scoreFrom(BASS6, [[[[0, 0]], [[0, 5]], [[5, 0]], [[3, 7]]]]);
  const before = pitches(score);
  const report = convertToFourStringBass(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  assert.equal(report.dropped, 0);
  assert.deepEqual(pitches(score), before.map((p) => (p < 28 ? p + 12 : p)));
});

test('works on the demo guitar with chords, ties and techniques', () => {
  const demo = JSON.parse(readFileSync(new URL('../public/demo/demo-song.json', import.meta.url)));
  let score = songsterrToScore(alphaTab, demo).score;
  const before = pitches(score);
  optimizeFingering(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  assert.deepEqual(pitches(score), before);
  // Drums are left alone.
  assert.deepEqual(optimizeFingering(m, score, 2), { changed: 0, notes: 0 });
});

test('recognises basses by tuning, instrument sound or name, and explains when it cannot convert', async () => {
  const { fourStringBlocker, looksLikeBass } = await import('../public/js/fingering.js');
  // A 6-string bass whose data uses an unusually high tuning but a bass sound.
  const odd = songsterrToScore(alphaTab, {
    title: 't',
    tracks: [
      { meta: { instrumentId: 25, title: 'Guitar' }, data: { tuning: GUITAR, measures: [{ voices: [{ beats: [] }] }] } },
      { meta: { instrumentId: 34, title: 'Six' }, data: { instrumentId: 34, tuning: [60, 55, 50, 45, 40, 35].map((x) => x + 5), measures: [{ voices: [{ beats: [] }] }] } }
    ]
  }).score;
  assert.equal(looksLikeBass(odd.tracks[1].staves[0]), true);
  assert.equal(canConvertToFourString(odd.tracks[1].staves[0]), true);
  assert.equal(fourStringBlocker(odd.tracks[1]), null);
  assert.match(fourStringBlocker(odd.tracks[0]), /guitar part/);
  const four = scoreFrom(BASS_4_STANDARD, [[[[0, 0]]]]);
  assert.match(fourStringBlocker(four.tracks[0]), /already has 4 strings/);
});

test('an unplayable moment does not stop the rest from being optimized', () => {
  // A scale on the low E string with a very wide two-note chord in the middle.
  const line = [3, 5, 7, 8].map((f) => [[5, f]]);
  let score = scoreFrom(GUITAR, [[...line, [[5, 1], [0, 12]], ...[10, 12, 14, 15].map((f) => [[5, f]])]]);
  const before = pitches(score);
  const result = optimizeFingering(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  assert.deepEqual(pitches(score), before);
  assert.ok(result.changed >= 4, `moved ${result.changed}`);
  const last = score.tracks[0].staves[0].bars[0].voices[0].beats.at(-1).notes[0];
  assert.ok(last.fret < 15, 'the end of the line moved to an easier position');
});

test('reduces hand shifts on a long line written at the lowest frets', () => {
  // A two-octave G major scale up and down, every note at its lowest fret.
  const major = [0, 2, 4, 5, 7, 9, 11];
  const degrees = [...Array(15).keys(), ...[...Array(14).keys()].reverse()];
  const notes = degrees.map((d) => 31 + 12 * Math.floor(d / 7) + major[d % 7]);
  const tuning = BASS_4_STANDARD;
  const lowest = (p) => {
    let best = null;
    tuning.forEach((t, s) => {
      const f = p - t;
      if (f >= 0 && (!best || f < best[1])) best = [s, f];
    });
    return best;
  };
  const beats = notes.map((p) => [lowest(p)]);
  let score = scoreFrom(tuning, [beats.slice(0, 8), beats.slice(8, 16), beats.slice(16, 24), beats.slice(24)]);
  const shiftsBefore = handShifts(score);
  optimizeFingering(m, score, 0);
  score = rebuildScore(alphaTab, score, settings);
  assert.ok(handShifts(score) <= 2, `shifts ${handShifts(score)} (was ${shiftsBefore})`);
});

/** Fewest position changes needed to play the part, with a four-fret hand. */
function handShifts(score) {
  let layer = new Map([[0, 0]]);
  for (const bar of score.tracks[0].staves[0].bars) {
    for (const beat of bar.voices[0].beats) {
      const fr = beat.notes.map((n) => n.fret).filter((f) => f > 0);
      if (!fr.length) continue;
      const next = new Map();
      for (let h = 1; h <= 21; h++) {
        if (h > Math.min(...fr) || Math.max(...fr) > h + 3) continue;
        let best = Infinity;
        for (const [p, c] of layer) best = Math.min(best, c + (p === 0 || p === h ? 0 : 1));
        next.set(h, best);
      }
      layer = next;
    }
  }
  return Math.min(...layer.values());
}
