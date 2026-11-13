import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore } from '../public/js/convert.js';
import { rebuildScore, shiftPitch, notePitch } from '../public/js/editor.js';
import { INSTRUMENTS, convertToInstrument, writtenKey, bestOctave, suggestInstrument, pitchName } from '../public/js/instruments.js';

const m = alphaTab.model;
const settings = () => new alphaTab.Settings();

/** A 5-string bass part (G D A E B, Songsterr order: highest string first). */
function bassScore(beats) {
  const bundle = {
    title: 'Test',
    tracks: [
      {
        meta: { title: 'Bass', instrumentId: 33 },
        data: {
          name: 'Bass',
          instrumentId: 33,
          tuning: [43, 38, 33, 28, 23],
          measures: beats.map((bar, i) => ({ ...(i === 0 ? { signature: [4, 4] } : {}), voices: [{ beats: bar }] })),
          automations: { tempo: [{ measure: 0, position: 0, bpm: 100 }] }
        }
      },
      { meta: { title: 'Guitar', instrumentId: 25 }, data: { name: 'Guitar', instrumentId: 25, tuning: [64, 59, 55, 50, 45, 40], measures: beats.map(() => ({ voices: [{ beats: [{ type: 1, duration: [1, 1], notes: [{ string: 0, fret: 0 }, { string: 1, fret: 1 }] }] }] })) } }
    ]
  };
  return songsterrToScore(alphaTab, bundle).score;
}

const q = (notes, extra = {}) => ({ type: 4, duration: [1, 4], notes, ...extra });
const rest = { type: 4, duration: [1, 4], rest: true, notes: [{ rest: true }] };

function partPitches(score, index) {
  return score.tracks[index].staves[0].bars.map((bar) =>
    bar.voices[0].beats.map((b) => (b.isRest ? 'r' : b.notes.map((n) => pitchName(n.realValue) + (n.isTieDestination ? '~' : '')).join('+')))
  );
}

test('a bass part becomes a tuba part at the same pitch, in bass clef', () => {
  const score = bassScore([
    [q([{ string: 3, fret: 0 }]), q([{ string: 3, fret: 3 }]), q([{ string: 2, fret: 2 }, { string: 1, fret: 2 }]), rest], // E1 G1 B1+E2 (a double stop) rest
    [q([{ string: 4, fret: 0 }]), q([{ string: 2, fret: 0 }]), q([{ string: 2, fret: 0, tie: true }]), q([{ string: 1, fret: 0 }])] // low B0, A1 tied, D2
  ]);
  const report = convertToInstrument(m, score, 0, 'tuba');
  const out = rebuildScore(alphaTab, score, settings());
  const tuba = out.tracks[report.index];
  assert.equal(tuba.name, 'Tuba');
  assert.equal(tuba.playbackInfo.program, 58);
  assert.equal(tuba.staves[0].tuning.length, 0, 'no tablature');
  assert.equal(tuba.staves[0].bars[0].clef, m.Clef.F4);
  assert.equal(tuba.staves[0].displayTranspositionPitch, 0, 'concert pitch');
  assert.notEqual(tuba.playbackInfo.primaryChannel, 9);
  assert.equal(report.octave, 0, 'a bass line stays where it sounds');
  assert.equal(report.chordsReduced, 1);
  assert.equal(report.foldedUp, 1, 'the low B of a 5-string goes up an octave');
  assert.deepEqual(partPitches(out, report.index), [
    ['E1', 'G1', 'B1', 'r'],
    ['B1', 'A1', 'A1~', 'D2']
  ]);
  // The original bass is untouched.
  assert.equal(out.tracks[0].staves[0].tuning.length, 5);
});

test('transposing instruments read in their own key', () => {
  assert.equal(writtenKey(-3, 21), 0); // E-flat tuba: concert E-flat reads C
  assert.equal(writtenKey(0, 2), 2); // B-flat trumpet: concert C reads D
  assert.equal(writtenKey(-4, 2), -2); // concert A-flat reads B-flat
  assert.equal(writtenKey(-3, 7), -2); // horn in F: concert E-flat reads B-flat
  assert.equal(writtenKey(0, 0), 0);
  assert.equal(writtenKey(5, 2), 7); // concert B reads C sharp

  const score = bassScore([[q([{ string: 3, fret: 3 }]), q([{ string: 3, fret: 5 }]), q([{ string: 2, fret: 2 }]), q([{ string: 2, fret: 3 }])]]);
  const report = convertToInstrument(m, score, 0, 'tuba-eb');
  const out = rebuildScore(alphaTab, score, settings());
  const staff = out.tracks[report.index].staves[0];
  assert.equal(staff.bars[0].clef, m.Clef.G2);
  assert.equal(staff.displayTranspositionPitch, -21, 'written an octave and a sixth higher');
  assert.equal(staff.bars[0].keySignature, 3, 'concert C reads A major');
});

test('a part moves by whole octaves only when it has to', () => {
  const bassLine = [28, 31, 33, 35, 36, 38, 40, 43];
  assert.equal(bestOctave(bassLine, INSTRUMENTS.tuba), 0);
  assert.equal(bestOctave(bassLine, INSTRUMENTS.trumpet), 2); // E3 to G4: all playable
  assert.equal(bestOctave(bassLine, INSTRUMENTS.cello), 1);
  assert.equal(bestOctave([76, 79, 81, 84], INSTRUMENTS.tuba), -3); // E2 to C3, the tuba's home
});

test('the right instrument is suggested, and high parts keep the top note', () => {
  const score = bassScore([[q([{ string: 3, fret: 0 }]), rest, rest, rest]]);
  assert.equal(suggestInstrument(score.tracks[0]), 'tuba');
  assert.equal(suggestInstrument(score.tracks[1]), 'trumpet');
  const report = convertToInstrument(m, score, 1, 'flute');
  const out = rebuildScore(alphaTab, score, settings());
  // The guitar's C4+E4 chord: a flute plays the top note.
  assert.deepEqual(partPitches(out, report.index)[0], ['E4']);
});

test('notes of a tuba part can be raised and lowered, ties and all', () => {
  const score = bassScore([[q([{ string: 3, fret: 3 }]), q([{ string: 3, fret: 3, tie: true }]), q([{ string: 3, fret: 5 }]), rest]]);
  const report = convertToInstrument(m, score, 0, 'tuba');
  let out = rebuildScore(alphaTab, score, settings());
  shiftPitch(m, out, { track: report.index, staff: 0, bar: 0, voice: 0, beat: 0 }, 2);
  out = rebuildScore(alphaTab, out, settings());
  assert.deepEqual(partPitches(out, report.index)[0], ['A1', 'A1~', 'A1', 'r']);
  // A rest becomes a note at the pitch before it.
  shiftPitch(m, out, { track: report.index, staff: 0, bar: 0, voice: 0, beat: 3 }, 1);
  out = rebuildScore(alphaTab, out, settings());
  assert.equal(notePitch(out.tracks[report.index].staves[0].bars[0].voices[0].beats[3].notes[0]), 33);
});

test('the new part saves and exports like any other track', () => {
  const score = bassScore([[q([{ string: 3, fret: 0 }]), q([{ string: 3, fret: 2 }]), rest, rest]]);
  const report = convertToInstrument(m, score, 0, 'trumpet');
  const out = rebuildScore(alphaTab, score, settings());
  const bytes = new alphaTab.exporter.Gp7Exporter().export(out, settings());
  assert.ok(bytes.length > 1000);
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings());
  assert.equal(back.tracks[report.index].name, 'Trumpet in B♭');
});
