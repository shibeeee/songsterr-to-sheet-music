import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore, normalizeTracks, applyDuration } from '../public/js/convert.js';

const demo = JSON.parse(readFileSync(new URL('../public/demo/demo-song.json', import.meta.url)));
const m = alphaTab.model;

test('demo converts with every bar filled to its time signature', () => {
  const { score, warnings } = songsterrToScore(alphaTab, demo);
  assert.deepEqual(warnings, []);
  assert.equal(score.title, 'Demo Exercise in C');
  assert.deepEqual(score.tracks.map((t) => t.name), ['Acoustic Guitar', 'Bass', 'Drums']);
  for (const track of score.tracks) {
    const bars = track.staves[0].bars;
    assert.equal(bars.length, score.masterBars.length);
    for (const bar of bars) {
      assert.equal(bar.voices[0].calculateDuration(), bar.masterBar.calculateDuration(), `${track.name} bar ${bar.index + 1}`);
    }
  }
});

test('strings, tuning and pitches map correctly', () => {
  const { score } = songsterrToScore(alphaTab, demo);
  const guitar = score.tracks[0].staves[0];
  assert.deepEqual(guitar.tuning, [64, 59, 55, 50, 45, 40]);
  // Songsterr string 4 (A string), fret 3 = C3
  const first = guitar.bars[0].voices[0].beats[0].notes[0];
  assert.equal(first.string, 2);
  assert.equal(first.fret, 3);
  assert.equal(first.realValue, 48);
  assert.equal(score.tracks[1].staves[0].bars[0].clef, m.Clef.F4);
  assert.equal(score.tracks[2].staves[0].isPercussion, true);
});

test('structure: tempo, repeats, sections, signatures', () => {
  const { score } = songsterrToScore(alphaTab, demo);
  const bars = score.masterBars;
  assert.equal(bars[0].tempoAutomations[0].value, 96);
  assert.equal(bars[4].tempoAutomations[0].value, 100);
  assert.equal(bars[0].isRepeatStart, true);
  assert.equal(bars[3].repeatCount, 2);
  assert.deepEqual(bars.filter((b) => b.section).map((b) => b.section.text), ['Intro', 'Run', 'Outro']);
  assert.equal(bars[6].timeSignatureNumerator, 3);
  assert.equal(bars[7].timeSignatureNumerator, 4);
});

test('techniques survive conversion', () => {
  const { score } = songsterrToScore(alphaTab, demo);
  const bars = score.tracks[0].staves[0].bars;
  const run = bars[4].voices[0].beats;
  assert.equal(run[0].tupletNumerator, 3);
  assert.equal(run[0].tupletDenominator, 2);
  assert.equal(run[6].notes[0].isHammerPullOrigin, true);
  assert.ok(run[6].notes[0].hammerPullDestination);
  const lick = bars[5].voices[0].beats;
  assert.equal(lick[0].notes[0].isPalmMute, true);
  assert.equal(lick[2].notes[0].slideOutType, m.SlideOutType.Shift);
  assert.ok(lick[4].notes[0].hasBend);
  assert.equal(lick[4].notes[0].maxBendPoint.value, 4); // full step = 4 quarter tones
  assert.equal(bars[0].voices[0].beats[0].chord.name, 'C');
});

test('durations: dotted, tuplets, and missing type', () => {
  const beat = () => new m.Beat();
  let b = beat();
  applyDuration(m, b, { type: 4, dots: 1, duration: [3, 8] });
  assert.equal(b.duration, m.Duration.Quarter);
  assert.equal(b.dots, 1);

  b = beat();
  applyDuration(m, b, { type: 16, tuplet: 6, duration: [1, 24] });
  assert.equal(b.tupletNumerator, 6);
  assert.equal(b.tupletDenominator, 4);

  b = beat();
  applyDuration(m, b, { duration: [3, 16] });
  assert.equal(b.duration, m.Duration.Eighth);
  assert.equal(b.dots, 1);
});

test('accepts a bare track payload or an array of payloads', () => {
  const payload = demo.tracks[0].data;
  assert.equal(normalizeTracks(payload).length, 1);
  assert.equal(normalizeTracks([payload, demo.tracks[1].data]).length, 2);
  const { score } = songsterrToScore(alphaTab, payload);
  assert.equal(score.tracks.length, 1);
});

test('rest-only and short tracks still produce full bars', () => {
  const bundle = {
    title: 'Rests',
    tracks: [
      { data: { tuning: [64, 59, 55, 50, 45, 40], measures: [{ signature: [3, 4], rest: true, voices: [{ rest: true, beats: [] }] }, { voices: [] }] } },
      { data: { tuning: [43, 38, 33, 28], measures: [{ voices: [] }] } }
    ]
  };
  const { score } = songsterrToScore(alphaTab, bundle);
  assert.equal(score.masterBars.length, 2);
  for (const track of score.tracks) {
    assert.equal(track.staves[0].bars.length, 2);
    for (const bar of track.staves[0].bars) assert.equal(bar.voices[0].beats[0].isRest, true);
  }
});

test('exports to Guitar Pro, alphaTex and MIDI', () => {
  const { score } = songsterrToScore(alphaTab, demo);
  const settings = new alphaTab.Settings();
  const gp = new alphaTab.exporter.Gp7Exporter().export(score, settings);
  const reloaded = alphaTab.importer.ScoreLoader.loadScoreFromBytes(gp, settings);
  assert.deepEqual(reloaded.tracks.map((t) => t.name), ['Acoustic Guitar', 'Bass', 'Drums']);
  assert.equal(reloaded.masterBars.length, 8);

  const tex = new alphaTab.exporter.AlphaTexExporter().exportToString(score);
  assert.match(tex, /Demo Exercise in C/);

  const midi = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(midi, true)).generate();
  assert.ok(midi.toBinary().length > 1000);
});

test('mixes tracks by instrument: drums and bass centred, guitars spread', async () => {
  const { defaultMix, instrumentFamily } = await import('../public/js/convert.js');
  assert.equal(instrumentFamily(25), 'guitar');
  assert.equal(instrumentFamily(30), 'drive-guitar');
  assert.equal(instrumentFamily(33), 'bass');
  assert.equal(instrumentFamily(0), 'keys');
  const g1 = defaultMix('guitar', 0);
  const g2 = defaultMix('guitar', 1);
  assert.ok(g1.balance < 8 && g2.balance > 8, 'two guitars go left and right');
  assert.equal(defaultMix('bass', 0).balance, 8);
  // Songsterr's real settings win over the defaults.
  assert.equal(defaultMix('guitar', 0, 0.5).volume, 7);
  assert.equal(defaultMix('guitar', 0, 1, -1).balance, 0);
  assert.equal(defaultMix('guitar', 0, 1, 0).balance, g1.balance);

  const { score } = songsterrToScore(alphaTab, demo);
  const [guitar, bass, drums] = score.tracks.map((t) => t.playbackInfo);
  assert.equal(bass.balance, 8);
  assert.equal(drums.primaryChannel, 9);
  assert.ok(guitar.volume > drums.volume);
});

test('bass clef for basses only: 7-string and baritone guitars read treble clef', () => {
  const track = (meta, tuning) => ({ meta, data: { tuning, measures: [{ voices: [{ beats: [] }] }] } });
  const { score } = songsterrToScore(alphaTab, {
    tracks: [
      track({ instrumentId: 30 }, [64, 59, 55, 50, 45, 40, 35]),
      track({ instrumentId: 26 }, [59, 54, 50, 45, 40, 35]),
      track({ instrumentId: 33 }, [43, 38, 33, 28]),
      track({}, [43, 38, 33, 28, 23]),
      track({}, [64, 59, 55, 50, 45, 40])
    ]
  });
  const clefs = score.tracks.map((t) => t.staves[0].bars[0].clef);
  assert.deepEqual(clefs, [m.Clef.G2, m.Clef.G2, m.Clef.F4, m.Clef.F4, m.Clef.G2]);
  // A track without an instrument plays with a sound that fits its tuning.
  assert.deepEqual(score.tracks.slice(3).map((t) => t.playbackInfo.program), [33, 25]);
});
