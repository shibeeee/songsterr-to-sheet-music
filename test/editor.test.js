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
