import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore } from '../public/js/convert.js';
import { estimateTempo, notesToBundle, removeOvertones, splitDuration, placeOnStrings } from '../public/js/transcribe.js';

// Notes the transcription model heard in synthetic plucked-string recordings
// of known music (fixtures/transcription), as [start, duration, pitch, velocity].
const load = (name) =>
  JSON.parse(readFileSync(new URL(`fixtures/transcription/${name}.json`, import.meta.url))).map(([start, duration, pitch, velocity]) => ({ start, duration, pitch, velocity }));
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Each bar as text: note names (chords joined by +), / note value, . for dotted. */
function written(bundle, track = 0) {
  const { tuning, measures } = bundle.tracks[track].data;
  return measures.map((m) =>
    m.voices[0].beats.map((b) => (b.rest ? 'r' : b.notes.map((n) => NAMES[(tuning[n.string] + n.fret) % 12]).join('+')) + '/' + b.type + (b.dots ? '.' : '')).join(' ')
  );
}

const barLength = (measure) => measure.voices[0].beats.reduce((s, b) => s + b.duration[0] / b.duration[1], 0);

test('finds the tempo and the beat', () => {
  for (const [name, bpm] of [['melody', 100], ['chords', 90], ['bass', 110], ['waltz', 120], ['fast', 140]]) {
    const tempo = estimateTempo(removeOvertones(load(name)));
    assert.ok(Math.abs(tempo.bpm - bpm) <= 2, `${name}: ${tempo.bpm} bpm, played at ${bpm}`);
    assert.ok(Math.abs(tempo.beatTime - 0.5) < 0.06, `${name}: first beat at ${tempo.beatTime}`);
  }
});

test('writes a melody exactly as played', () => {
  const bundle = notesToBundle(load('melody'), { mode: 'melody' });
  assert.deepEqual(written(bundle), [
    'C/8 D/8 E/8 F/8 G/4 G/4',
    'A/8 A/8 A/8 A/8 G/2',
    'F/8 F/8 F/8 F/8 E/4 E/4',
    'D/8 D/8 D/8 D/8 C/2'
  ]);
  assert.equal(bundle.transcription.bpm, 100);
});

test('3/4 time with a pickup note', () => {
  const bundle = notesToBundle(load('waltz'), { mode: 'melody', beatsPerBar: 3 });
  assert.deepEqual(written(bundle), ['r/8 G/8 C/4 E/4', 'G/4 E/4 C/4', 'D/4 F/4 A/4', 'G/2.', 'C/4 E/4 G/4', 'C/2.']);
  for (const m of bundle.tracks[0].data.measures) assert.equal(barLength(m), 3 / 4);
});

test('bass: overtones removed, one note at a time, 4-string tuning', () => {
  const bundle = notesToBundle(load('bass'), { mode: 'bass' });
  assert.deepEqual(bundle.tracks[0].data.tuning, [43, 38, 33, 28]);
  assert.deepEqual(written(bundle), ['E/8 E/8 G/8 A/8 E/8 E/8 B/8 A/8', 'E/4 r/4 D/4 E/4']);
});

test('chords keep their notes, one per string', () => {
  const bundle = notesToBundle(load('chords'), { mode: 'guitar' });
  const bars = written(bundle);
  const chord = (text) => new Set(text.split('/')[0].split('+'));
  assert.deepEqual(chord(bars[0].split(' ')[0]), new Set(['C', 'E', 'G']));
  assert.deepEqual(chord(bars[1].split(' ')[0]), new Set(['F', 'A', 'C']));
  assert.deepEqual(chord(bars[1].split(' ').at(-1)), new Set(['G', 'B', 'D']));
  for (const m of bundle.tracks[0].data.measures) {
    for (const b of m.voices[0].beats) {
      const strings = (b.notes || []).filter((n) => !n.rest).map((n) => n.string);
      assert.equal(new Set(strings).size, strings.length);
    }
  }
});

test('guitar and bass: two tracks from one recording', () => {
  const bundle = notesToBundle(load('chords'), { mode: 'band', bpm: 90 });
  assert.equal(bundle.tracks.length, 2);
  const bass = written(bundle, 1);
  assert.equal(bass[0].split(' ')[0], 'C/4'); // the C chord's low C goes to the bass
});

test('every bar adds up, ties join the same string and fret, and it opens as a score', () => {
  for (const [name, mode] of [['fast', 'melody'], ['chords', 'guitar'], ['bass', 'bass'], ['chords', 'band']]) {
    const bundle = notesToBundle(load(name), { mode });
    for (const track of bundle.tracks) {
      const measures = track.data.measures;
      for (const m of measures) assert.equal(barLength(m), 1, `${name} ${mode}: bar length`);
      const beats = measures.flatMap((m) => m.voices[0].beats);
      beats.forEach((b, i) => {
        for (const n of b.notes || []) {
          if (!n.tie) continue;
          const prev = beats[i - 1].notes.find((p) => p.string === n.string);
          assert.ok(prev && prev.fret === n.fret, `${name}: tie continues the same note`);
        }
      });
    }
    const { score } = songsterrToScore(alphaTab, bundle);
    assert.equal(score.tempo, bundle.transcription.bpm);
  }
});

test('rhythm spelling keeps beats visible', () => {
  const units = (parts) => parts.map((p) => `${p.type}${p.dots ? '.' : ''}`);
  assert.deepEqual(units(splitDuration(0, 6)), ['4.']);
  assert.deepEqual(units(splitDuration(2, 4)), ['8', '8']); // off the beat: tied across it
  assert.deepEqual(units(splitDuration(0, 16)), ['1']);
  assert.deepEqual(units(splitDuration(4, 12)), ['2.']);
  assert.deepEqual(units(splitDuration(1, 3)), ['8.']);
});

test('places chords on separate strings and drops what cannot fit', () => {
  const placed = placeOnStrings([40, 45, 50, 55, 59, 64], [64, 59, 55, 50, 45, 40]);
  assert.equal(placed.length, 6);
  assert.ok(placed.every((p) => p.fret === 0));
  assert.equal(placeOnStrings([40, 41, 42], [43, 38, 33, 28]).length, 3);
  assert.equal(placeOnStrings([20], [64, 59, 55, 50, 45, 40]).length, 0);
});

test('recognises YouTube links and reads times', async () => {
  const { youtubeId } = await import('../public/js/audio-input.js');
  const { parseTime } = await import('../public/js/transcribe-ui.js');
  for (const link of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ'
  ]) {
    assert.equal(youtubeId(link), 'dQw4w9WgXcQ', link);
  }
  assert.equal(youtubeId('https://www.songsterr.com/a/wsa/song-tab-s27'), null);
  assert.equal(youtubeId('metallica one'), null);
  assert.equal(parseTime('1:23'), 83);
  assert.equal(parseTime('45'), 45);
  assert.equal(parseTime(''), null);
  assert.ok(Number.isNaN(parseTime('abc')));
});
