import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as alphaTab from '@coderline/alphatab';
import { songsterrToScore } from '../public/js/convert.js';
import * as ed from '../public/js/editor.js';

const m = alphaTab.model;
const settings = new alphaTab.Settings();
const demo = JSON.parse(readFileSync(new URL('../public/demo/demo-song.json', import.meta.url)));
const fresh = () => songsterrToScore(alphaTab, demo).score;
const rebuild = (score) => ed.rebuildScore(alphaTab, score, settings);
const first = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0, string: 2 };

test('setting a fret changes or adds a note, and survives a rebuild', () => {
  const score = fresh();
  ed.setFret(m, score, first, 5);
  ed.setFret(m, score, { ...first, string: 6 }, 0);
  const beat = ed.beatOf(rebuild(score), first);
  assert.deepEqual(beat.notes.map((n) => `${n.string}:${n.fret}`).sort(), ['2:5', '6:0']);
});

test('deleting notes and making rests', () => {
  const score = fresh();
  ed.deleteNote(m, score, first);
  assert.equal(ed.beatOf(rebuild(score), first).isRest, true);
  const chord = { ...first, bar: 3, beat: 5 };
  ed.makeRest(m, score, chord);
  assert.equal(ed.beatOf(rebuild(score), chord).isRest, true);
});

test('typing a fret on a rest turns it into a note', () => {
  const score = fresh();
  const sel = { ...first, track: 1, bar: 4, string: 3 }; // bass rest bar
  assert.equal(ed.beatOf(score, sel).isRest, true);
  ed.setFret(m, score, sel, 7);
  const beat = ed.beatOf(rebuild(score), sel);
  assert.equal(beat.isRest, false);
  assert.equal(beat.notes[0].fret, 7);
});

test('techniques toggle on and off', () => {
  const score = fresh();
  for (const effect of Object.keys(ed.NOTE_EFFECTS)) {
    ed.toggleEffect(m, score, first, effect);
    assert.equal(ed.effectState(m, score, first, effect), true, `${effect} on`);
    ed.toggleEffect(m, score, first, effect);
    assert.equal(ed.effectState(m, score, first, effect), false, `${effect} off`);
  }
  ed.toggleEffect(m, score, first, 'bend');
  assert.equal(ed.beatOf(rebuild(score), first).notes[0].hasBend, true);
});

test('rhythm: durations, dots, triplets', () => {
  const score = fresh();
  ed.setDuration(m, score, first, 4);
  ed.toggleDot(m, score, first);
  let beat = ed.beatOf(rebuild(score), first);
  assert.equal(beat.duration, 4);
  assert.equal(beat.dots, 1);
  ed.stepDuration(m, score, first, 1);
  assert.equal(ed.beatOf(score, first).duration, 8);
  ed.toggleTriplet(m, score, first);
  beat = ed.beatOf(rebuild(score), first);
  assert.equal(beat.tupletNumerator, 3);
  ed.toggleTriplet(m, score, first);
  assert.equal(ed.beatOf(rebuild(score), first).hasTuplet, false);
});

test('inserting and deleting beats', () => {
  const score = fresh();
  const count = ed.voiceOf(score, first).beats.length;
  const sel = ed.insertBeat(m, score, first);
  assert.equal(sel.beat, 1);
  let r = rebuild(score);
  assert.equal(ed.voiceOf(r, first).beats.length, count + 1);
  assert.equal(ed.beatOf(r, sel).isRest, true);
  ed.deleteBeat(m, r, sel);
  ed.deleteBeat(m, r, first);
  r = rebuild(r);
  assert.equal(ed.voiceOf(r, first).beats.length, count - 1);
});

test('bars: insert, duplicate, delete keep every track aligned', () => {
  let score = fresh();
  const bars = score.masterBars.length;
  ed.insertBar(m, score, 1);
  score = rebuild(score);
  assert.equal(score.masterBars.length, bars + 1);
  assert.equal(ed.beatOf(score, { ...first, bar: 1 }).isRest, true);

  ed.duplicateBar(m, score, 0);
  score = rebuild(score);
  const a = ed.voiceOf(score, { ...first, bar: 0 }).beats.map((b) => b.notes.map((n) => n.fret).join());
  const b = ed.voiceOf(score, { ...first, bar: 1 }).beats.map((x) => x.notes.map((n) => n.fret).join());
  assert.deepEqual(a, b);

  // Deleting the first bar keeps its tempo and repeat start on the next one.
  ed.deleteBar(m, score, 0);
  score = rebuild(score);
  assert.equal(score.masterBars.length, bars + 1);
  assert.equal(score.masterBars[0].tempoAutomations[0].value, 96);
  assert.equal(score.masterBars[0].isRepeatStart, true);
  for (const track of score.tracks) {
    assert.equal(track.staves[0].bars.length, score.masterBars.length);
    track.staves[0].bars.forEach((bar, i) => assert.equal(bar.index, i));
  }
});

test('bar settings: section, tempo, time signature, repeats', () => {
  let score = fresh();
  ed.setSection(m, score, 2, 'Bridge');
  assert.equal(ed.setTempo(m, score, 2, 140), true);
  assert.equal(ed.setTempo(m, score, 2, 5), false);
  assert.equal(ed.setTimeSignature(m, score, 2, 6, 8), true);
  assert.equal(ed.setTimeSignature(m, score, 2, 6, 7), false);
  ed.toggleRepeatStart(m, score, 5);
  ed.setRepeatEnd(m, score, 6, 3);
  score = rebuild(score);
  assert.equal(score.masterBars[2].section.text, 'Bridge');
  assert.equal(ed.tempoAt(score, 3), 140);
  assert.equal(score.masterBars[2].timeSignatureNumerator, 6);
  assert.equal(score.masterBars[5].isRepeatStart, true);
  assert.equal(score.masterBars[6].repeatCount, 3);
  ed.setSection(m, score, 2, '  ');
  assert.equal(score.masterBars[2].section, null);
});

test('selection helpers move across bars and stay in range', () => {
  const score = fresh();
  const last = ed.voiceOf(score, first).beats.length - 1;
  const end = { ...first, beat: last };
  assert.deepEqual(ed.stepBeat(score, end, 1), { ...first, bar: 1, beat: 0 });
  assert.deepEqual(ed.stepBeat(score, { ...first, bar: 1 }, -1), end);
  assert.deepEqual(ed.stepBeat(score, first, -1), first);
  assert.deepEqual(ed.clampSelection(score, { track: 9, bar: 99, beat: 99, string: 99 }).track, 2);
  const sel = ed.selectionForBeat(ed.beatOf(score, first));
  assert.equal(sel.string, 2);
});

test('transposing bars moves frets and skips notes that would go below zero', () => {
  const score = fresh();
  const skipped = ed.transposeBars(m, score, 0, 0, 0, -1);
  assert.ok(skipped > 0); // open strings can't go down
  assert.equal(ed.beatOf(score, first).notes[0].fret, 2);
});

test('song and track details', () => {
  const score = fresh();
  ed.setSongInfo(score, { title: 'New title', artist: 'Me' });
  ed.renameTrack(score, 1, 'Electric Bass');
  const r = rebuild(score);
  assert.equal(r.title, 'New title');
  assert.equal(r.artist, 'Me');
  assert.equal(r.tracks[1].name, 'Electric Bass');
});

test('undo snapshots restore the earlier score', () => {
  const score = fresh();
  const snap = ed.snapshot(alphaTab, score);
  ed.setFret(m, score, first, 9);
  const restored = ed.restore(alphaTab, snap, settings);
  assert.equal(ed.beatOf(restored, first).notes[0].fret, 3);
});

test('copying a bar and pasting it over another', () => {
  let score = fresh();
  const clip = ed.copyBar(m, score, 0, 1);
  const skipped = ed.pasteBar(m, score, 0, 2, clip);
  assert.equal(skipped, 0);
  score = rebuild(score);
  const frets = (bar) => ed.voiceOf(score, { ...first, bar }).beats.map((b) => b.notes.map((n) => `${n.string}:${n.fret}`).join());
  assert.deepEqual(frets(2), frets(1));
  // Pasting a 6-string guitar bar onto the 4-string bass keeps only notes that fit.
  const guitarBar = ed.copyBar(m, score, 0, 3);
  const dropped = ed.pasteBar(m, score, 1, 3, guitarBar);
  assert.ok(dropped > 0);
  score = rebuild(score);
  for (const beat of ed.voiceOf(score, { ...first, track: 1, bar: 3 }).beats) for (const n of beat.notes) assert.ok(n.string <= 4);
  // Drums and stringed parts don't mix.
  assert.ok(ed.pasteBar(m, score, 2, 0, clip) > 0);
});

/** A one-track score from Songsterr-style bars: each bar is a list of beats, a beat is [type, notes]. */
function small(bars, { tuning = [64, 59, 55, 50, 45, 40], automations, extra = [] } = {}) {
  const measures = bars.map((beats, i) => ({
    ...(i === 0 ? { signature: [4, 4] } : {}),
    ...(extra[i] || {}),
    voices: [{ beats: beats.map(([type, notes]) => ({ type, duration: [1, type], notes })) }]
  }));
  return songsterrToScore(alphaTab, { tracks: [{ data: { tuning, automations, measures } }] }).score;
}

test('removing the start of a tie, hammer-on or slide still rebuilds', () => {
  // Bar 1: tie on the G string, then a hammer-on and a slide; bar 2 is where they land.
  const make = () =>
    small([
      [[4, [{ string: 2, fret: 5 }]], [4, [{ string: 2, fret: 5, tie: true }]], [4, [{ string: 1, fret: 3, hp: true }]], [4, [{ string: 0, fret: 5, slide: 'legato' }]]],
      [[2, [{ string: 0, fret: 7 }]], [2, [{ string: 1, fret: 5 }]]]
    ]);
  const at = (beat, string = 4) => ({ track: 0, staff: 0, bar: 0, voice: 0, beat, string });
  const edits = {
    deleteNote: (s) => ed.deleteNote(m, s, at(0)),
    makeRest: (s) => ed.makeRest(m, s, at(0)),
    deleteBeat: (s) => ed.deleteBeat(m, s, at(0)),
    deleteBar: (s) => ed.deleteBar(m, s, 0),
    pasteBar: (s) => ed.pasteBar(m, s, 0, 0, ed.copyBar(m, s, 0, 1))
  };
  for (const [name, edit] of Object.entries(edits)) {
    for (const earlier of [false, true]) {
      let score = make();
      if (earlier) score = rebuild(score);
      edit(score);
      assert.doesNotThrow(() => (score = rebuild(score)), name);
      for (const bar of score.tracks[0].staves[0].bars) {
        for (const beat of bar.voices[0].beats) {
          for (const n of beat.notes) if (n.isTieDestination) assert.ok(n.tieOrigin, `${name}: a tied note has its origin`);
        }
      }
    }
  }
  // The note that was tied to the deleted one is a note of its own now.
  const score = make();
  ed.deleteNote(m, score, at(0));
  const second = ed.beatOf(rebuild(score), at(1)).notes[0];
  assert.equal(second.isTieDestination, false);
  assert.equal(second.fret, 5);
});

test('duplicating a bar ties the next bar to the copy', () => {
  let score = small([
    [[2, [{ string: 2, fret: 2 }]], [2, [{ string: 4, fret: 7 }]]],
    [[2, [{ string: 4, fret: 7, tie: true }]], [2, [{ string: 4, fret: 5 }]]]
  ]);
  for (const earlier of [false, true]) {
    if (earlier) score = rebuild(score);
    ed.duplicateBar(m, score, 0);
    score = rebuild(score);
    const last = score.tracks[0].staves[0].bars.length - 1;
    const tied = ed.beatOf(score, { ...first, bar: last, beat: 0 }).notes[0];
    assert.equal(tied.isTieDestination, true);
    assert.equal(tied.tieOrigin.beat.voice.bar.index, last - 1);
    assert.equal(tied.tieOrigin.tieDestination, tied);
  }
});

test('deleting the bar with the repeat sign moves the sign back one bar', () => {
  const bars = [0, 1, 2, 3].map((f) => [[1, [{ string: 0, fret: f }]]]);
  let score = small(bars, { extra: [{ repeatStart: true }, {}, { repeat: 2 }] });
  ed.deleteBar(m, score, 2);
  score = rebuild(score);
  assert.equal(score.masterBars[0].isRepeatStart, true);
  assert.equal(score.masterBars[1].repeatCount, 2);
  // A repeat of just that one bar goes with it.
  score = small(bars, { extra: [{}, { repeatStart: true, repeat: 3 }] });
  ed.deleteBar(m, score, 1);
  score = rebuild(score);
  assert.deepEqual(score.masterBars.map((mb) => mb.repeatCount), [0, 0, 0]);
});

test('tempo: the last change of a bar carries on, and inserting a first bar keeps the start tempo', () => {
  const bars = [[[1, [{ string: 0, fret: 0 }]]], [[1, [{ string: 0, fret: 1 }]]], [[1, [{ string: 0, fret: 2 }]]]];
  let score = small(bars, {
    automations: { tempo: [{ measure: 0, position: 0, bpm: 100 }, { measure: 0, position: 0.5, bpm: 160 }, { measure: 2, position: 0.5, bpm: 80 }] }
  });
  assert.equal(ed.tempoAt(score, 0), 100);
  assert.equal(ed.tempoAt(score, 1), 160);
  assert.equal(ed.tempoAt(score, 2), 160); // its change comes later in the bar

  ed.insertBar(m, score, 0);
  score = rebuild(score);
  assert.equal(ed.tempoAt(score, 0), 100);
  assert.equal(score.tempo, 100);
  assert.deepEqual(score.masterBars[1].tempoAutomations.map((a) => a.value), [160]);

  // Deleting a bar hands the tempo it ended with to the next one.
  ed.deleteBar(m, score, 1);
  score = rebuild(score);
  assert.equal(ed.tempoAt(score, 1), 160);
  assert.deepEqual(score.masterBars[1].tempoAutomations.map((a) => [a.ratioPosition, a.value]), [[0, 160]]);
});

test('pasting onto a track with other strings keeps every pitch', () => {
  const pitch = (staff, n) => staff.tuning[staff.tuning.length - n.string] + n.fret;
  const chord = [{ string: 5, fret: 0 }, { string: 4, fret: 2 }, { string: 3, fret: 2 }, { string: 0, fret: 0 }];
  const bar = [[4, [{ string: 5, fret: 0 }]], [4, [{ string: 0, fret: 0 }]], [2, chord]];
  let score = songsterrToScore(alphaTab, {
    tracks: [
      { data: { tuning: [64, 59, 55, 50, 45, 40], measures: [{ signature: [4, 4], voices: [{ beats: bar.map(([type, notes]) => ({ type, duration: [1, type], notes })) }] }] } },
      { data: { tuning: [64, 59, 55, 50, 45, 40, 35], measures: [{ voices: [{ beats: [{ type: 1, duration: [1, 1], rest: true, notes: [] }] }] }] } },
      { data: { tuning: [43, 38, 33, 28, 23], measures: [{ voices: [{ beats: [{ type: 1, duration: [1, 1], rest: true, notes: [] }] }] }] } }
    ]
  }).score;
  const sounding = (s, t) => {
    const staff = s.tracks[t].staves[0];
    return staff.bars[0].voices[0].beats.map((b) => b.notes.map((n) => pitch(staff, n)).sort((a, c) => a - c));
  };
  const clip = ed.copyBar(m, score, 0, 0);
  assert.equal(ed.pasteBar(m, score, 1, 0, clip), 0);
  assert.equal(ed.pasteBar(m, score, 2, 0, clip), 0);
  score = rebuild(score);
  const source = sounding(score, 0);
  assert.deepEqual(sounding(score, 1), source);
  assert.deepEqual(sounding(score, 2), source);
  // On the 7-string the strings stay the same counted from the top, so the frets don't change.
  const seven = score.tracks[1].staves[0].bars[0].voices[0].beats.map((b) => b.notes.map((n) => `${n.string}:${n.fret}`).sort());
  const six = score.tracks[0].staves[0].bars[0].voices[0].beats.map((b) => b.notes.map((n) => `${n.string + 1}:${n.fret}`).sort());
  assert.deepEqual(seven, six);
  for (const beat of score.tracks[2].staves[0].bars[0].voices[0].beats) {
    assert.equal(new Set(beat.notes.map((n) => n.string)).size, beat.notes.length, 'one note per string');
  }
});

test('switching a hammer-on or slide off unlinks the next note', () => {
  let score = songsterrToScore(alphaTab, {
    title: 't',
    tracks: [{ data: { tuning: [64, 59, 55, 50, 45, 40], measures: [{ signature: [4, 4], voices: [{ beats: [
      { type: 4, duration: [1, 4], notes: [{ string: 2, fret: 5, hp: true }] },
      { type: 4, duration: [1, 4], notes: [{ string: 2, fret: 7 }] },
      { type: 4, duration: [1, 4], notes: [{ string: 2, fret: 5, slide: 'legato' }] },
      { type: 4, duration: [1, 4], notes: [{ string: 2, fret: 9 }] }
    ] }] }] } }]
  }).score;
  const at = (beat) => ({ track: 0, staff: 0, bar: 0, voice: 0, beat, string: 4 });
  ed.toggleEffect(m, score, at(0), 'hammer');
  ed.toggleEffect(m, score, at(2), 'slide');
  score = rebuild(score);
  const beats = ed.voiceOf(score, at(0)).beats;
  assert.equal(beats[1].notes[0].isHammerPullDestination, false);
  assert.equal(beats[3].notes[0].slideOrigin, null);
});
