import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore } from '../public/js/convert.js';
import { rebuildScore } from '../public/js/editor.js';
import { convertToInstrument } from '../public/js/instruments.js';
import { scoreHasKey, detectScoreKey, setScoreKey, concertKey, applySpelling, spellChordName, keyLabel } from '../public/js/keys.js';

const m = alphaTab.model;

/** A guitar part playing E-flat major scale notes and an A-flat chord name, plus a bass. */
function song() {
  const beat = (string, fret, extra = {}) => ({ type: 4, duration: [1, 4], notes: [{ string, fret }], ...extra });
  // High E string first: Eb4 = string 1 (B) fret 4, F4 = string 0 fret 1, G4 = string 0 fret 3, Ab4 = string 0 fret 4, Bb3 = string 2 fret 3
  const bar = [beat(1, 4, { chord: { text: 'G#' } }), beat(0, 1), beat(0, 3), beat(0, 4)];
  const bar2 = [beat(2, 3), beat(1, 1), beat(1, 4), beat(2, 1, { chord: { text: 'C#m/D#' } })]; // Bb3 C4 Eb4 Ab3
  return songsterrToScore(alphaTab, {
    title: 'Key test',
    tracks: [
      { meta: { title: 'Guitar', instrumentId: 25 }, data: { name: 'Guitar', instrumentId: 25, tuning: [64, 59, 55, 50, 45, 40], measures: [{ signature: [4, 4], voices: [{ beats: bar }] }, { voices: [{ beats: bar2 }] }] } },
      { meta: { title: 'Drums', instrumentId: 1024 }, data: { name: 'Drums', instrumentId: 1024, measures: [{ voices: [{ beats: [{ type: 1, duration: [1, 1], notes: [{ fret: 36 }] }] }] }, { voices: [{ beats: [{ type: 1, duration: [1, 1], notes: [{ fret: 36 }] }] }] }] } }
    ]
  }).score;
}

test('a song without a key gets the key its notes are in', () => {
  const score = song();
  assert.equal(scoreHasKey(score), false);
  const key = detectScoreKey(score);
  assert.equal(key.fifths, -3, key.name);
  setScoreKey(m, score, key.fifths);
  assert.equal(scoreHasKey(score), true);
  assert.equal(concertKey(score), -3);
  assert.equal(score.tracks[0].staves[0].bars[1].keySignature, -3);
  assert.equal(score.tracks[1].staves[0].bars[0].keySignature, 0, 'drums have no key');
});

test('each part reads the key for its transposition', () => {
  const score = song();
  convertToInstrument(m, score, 0, 'trumpet');
  convertToInstrument(m, score, 0, 'tuba-eb');
  const out = rebuildScore(alphaTab, score, new alphaTab.Settings());
  setScoreKey(m, out, -3); // concert E-flat
  assert.equal(out.tracks[2].staves[0].bars[0].keySignature, -1, 'B-flat trumpet reads F');
  assert.equal(out.tracks[3].staves[0].bars[0].keySignature, 0, 'E-flat tuba reads C');
  assert.equal(concertKey(out), -3);
});

test('black-key notes outside the key are spelled as chosen', () => {
  const score = song(); // still in C: every black key is outside the key
  const modes = () => score.tracks[0].staves[0].bars[0].voices[0].beats.map((b) => b.notes[0].accidentalMode);
  const { ForceFlat, ForceSharp, Default } = m.NoteAccidentalMode;
  applySpelling(m, score, 'flats');
  assert.deepEqual(modes(), [ForceFlat, Default, Default, ForceFlat]); // Eb F G Ab
  assert.equal(score.tracks[0].staves[0].chords.get('songsterr-G#').name, 'Ab');
  applySpelling(m, score, 'sharps');
  assert.deepEqual(modes(), [ForceSharp, Default, Default, ForceSharp]);
  assert.equal(score.tracks[0].staves[0].chords.get('songsterr-G#').name, 'G#');
  // In E-flat major those notes belong to the key and keep its spelling.
  setScoreKey(m, score, -3);
  applySpelling(m, score, 'sharps');
  assert.deepEqual(modes(), [Default, Default, Default, Default]);
});

test('chord names respelled', () => {
  assert.equal(spellChordName('A#m7', 0, 'flats'), 'Bbm7');
  assert.equal(spellChordName('C#m/D#', 0, 'flats'), 'Dbm/Eb');
  assert.equal(spellChordName('Bb', 0, 'sharps'), 'A#');
  assert.equal(spellChordName('F#', 1, 'flats'), 'F#', 'F sharp belongs to G major');
  assert.equal(spellChordName('Am7', -3, 'flats'), 'Am7');
  assert.equal(keyLabel(-3), 'E♭ major / C minor (3 flats)');
  assert.equal(keyLabel(2), 'D major / B minor (2 sharps)');
});
