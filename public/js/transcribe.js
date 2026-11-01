// Audio transcription: turning the notes heard in a recording into a score.
//
// The notes come from Spotify's Basic Pitch model (see src/transcriber-worker.js)
// as { start, duration, pitch, velocity } in seconds. This module, which has no
// browser dependencies, cleans them up, finds the tempo and the beat, rounds
// everything to a rhythm grid and writes the result in the same Songsterr-style
// format the rest of the app reads, so a transcription opens like any tab.

import { beatPosition, chordsPerBeat, melodyLine, spellChord } from './analysis.js';

export const TRANSCRIBE_MODES = {
  chords: { label: 'Chords to strum' },
  melody: { label: 'Melody or solo (one note at a time)' },
  bass: { label: 'Bass' },
  guitar: { label: 'Every note (guitar)' },
  band: { label: 'Guitar and bass (two tracks)' }
};

const GUITAR_TUNING = [64, 59, 55, 50, 45, 40]; // high E to low E, Songsterr string 0 first
const BASS_TUNING = [43, 38, 33, 28]; // G D A E
const GUITAR_RANGE = [40, 88]; // E2 to E6 (24 frets)
const BASS_RANGE = [28, 67]; // E1 to G4
const BAND_SPLIT = 52; // E3: the bass takes the lowest note below this
const MAX_FRET = 24;
const GUITAR_PROGRAM = 25; // steel-string acoustic guitar
const BASS_PROGRAM = 33; // fingered electric bass

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/**
 * Removes overtones the model sometimes reports as notes: a quiet note an
 * octave (or an octave and a fifth, or two octaves) above a louder note that
 * starts at the same moment. Real octaves in chords are about as loud as the
 * note below them, so they stay.
 */
export function removeOvertones(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  return sorted.filter((note) =>
    !sorted.some(
      (base) =>
        base !== note &&
        Math.abs(base.start - note.start) < 0.06 &&
        [12, 19, 24].includes(note.pitch - base.pitch) &&
        base.velocity >= note.velocity * 1.35
    )
  );
}

/**
 * Joins a sustained note the model split in two (vibrato or a swell can look
 * like a new start): the same pitch continuing straight on, with only a weak
 * start. Real repeated notes have a clear start (onset near 1). Notes without
 * an `onset` strength are left alone.
 */
export function mergeRetriggers(notes, { weakOnset = 0.72 } = {}) {
  const byPitch = new Map();
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []);
    byPitch.get(n.pitch).push({ ...n });
  }
  const out = [];
  for (const list of byPitch.values()) {
    let held = null;
    for (const n of list) {
      const joined = n.start - (held ? held.start + held.duration : -Infinity) < 0.05;
      // A bass note's start can stutter just after the real one; legato bass
      // notes otherwise start weakly, so they stay separate.
      const weak = n.pitch >= BAND_SPLIT ? n.onset < weakOnset : n.onset < 0.65 && n.start - held?.start < 0.15;
      if (held && n.onset != null && joined && weak) {
        held.duration = Math.max(held.duration, n.start + n.duration - held.start);
        held.velocity = Math.max(held.velocity, n.velocity);
        continue;
      }
      if (held) out.push(held);
      held = n;
    }
    if (held) out.push(held);
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// ---------------------------------------------------------------------------
// Tempo and beat
// ---------------------------------------------------------------------------

/** Note starts that happen together count once, with the loudest note's weight. */
function onsetsOf(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const onsets = [];
  for (const n of sorted) {
    const last = onsets[onsets.length - 1];
    if (last && n.start - last.time < 0.035) last.weight = Math.max(last.weight, n.velocity);
    else onsets.push({ time: n.start, weight: n.velocity });
  }
  return onsets;
}

/**
 * How well the onsets sit on a grid of beats (period seconds, starting at
 * phase): onsets on beats count fully, on eighths a little less, on
 * sixteenths less again.
 */
function gridFit(onsets, period, phase) {
  const sigma = Math.min(0.035, period / 12);
  let score = 0;
  for (const { time, weight } of onsets) {
    const pos = (time - phase) / period;
    const near = (step) => {
      const d = (pos / step - Math.round(pos / step)) * step * period;
      return Math.exp(-(d * d) / (2 * sigma * sigma));
    };
    score += weight * Math.max(near(1), 0.7 * near(0.5), 0.4 * near(0.25));
  }
  return score;
}

/** Most songs sit between about 70 and 160 beats per minute. */
function tempoPrior(bpm) {
  const octaves = Math.log2(bpm / 112);
  return Math.exp(-(octaves * octaves) / (2 * 0.45 * 0.45));
}

function bestPhase(onsets, period) {
  let best = { phase: 0, score: -1 };
  const steps = 48;
  for (let i = 0; i < steps; i++) {
    const phase = (i / steps) * period;
    // Phase is judged on beats and eighths only, so it lands on the beat.
    let score = 0;
    const sigma = Math.min(0.035, period / 12);
    for (const { time, weight } of onsets) {
      const pos = (time - phase) / period;
      const dBeat = (pos - Math.round(pos)) * period;
      const dHalf = (pos * 2 - Math.round(pos * 2)) * (period / 2);
      score += weight * Math.max(Math.exp(-(dBeat * dBeat) / (2 * sigma * sigma)), 0.5 * Math.exp(-(dHalf * dHalf) / (2 * sigma * sigma)));
    }
    if (score > best.score) best = { phase, score };
  }
  return best.phase;
}

/**
 * Finds the tempo (beats per minute) and where the beats fall (the time of a
 * beat, in seconds). Returns { bpm, beatTime, confidence }.
 */
export function estimateTempo(notes) {
  const onsets = onsetsOf(notes);
  if (onsets.length < 4) return { bpm: 100, beatTime: onsets[0]?.time ?? 0, confidence: 0 };
  const total = onsets.reduce((s, o) => s + o.weight, 0);
  const score = (bpm) => {
    const period = 60 / bpm;
    const phase = bestPhase(onsets, period);
    return { bpm, phase, fit: gridFit(onsets, period, phase) / total };
  };
  // Coarse search, then a finer one around the best candidate.
  let best = null;
  for (let bpm = 50; bpm <= 210; bpm += 1) {
    const s = score(bpm);
    s.value = s.fit * tempoPrior(bpm);
    if (!best || s.value > best.value) best = s;
  }
  for (let bpm = best.bpm - 1; bpm <= best.bpm + 1; bpm += 0.1) {
    const s = score(bpm);
    s.value = s.fit * tempoPrior(bpm);
    if (s.value > best.value) best = s;
  }
  const bpm = Math.round(best.bpm);
  const period = 60 / bpm;
  const phase = bestPhase(onsets, period);
  // The first beat at or just before the first note.
  const first = onsets[0].time;
  const beatTime = phase + Math.floor((first - phase + period * 0.25) / period) * period;
  return { bpm, beatTime, confidence: Math.min(1, best.fit) };
}

// ---------------------------------------------------------------------------
// Rhythm grid
// ---------------------------------------------------------------------------

/** Note values (in grid units of a sixteenth) that can be written as one note. */
const VALUES = [
  { units: 16, type: 1, dots: 0 },
  { units: 12, type: 2, dots: 1 },
  { units: 8, type: 2, dots: 0 },
  { units: 6, type: 4, dots: 1 },
  { units: 4, type: 4, dots: 0 },
  { units: 3, type: 8, dots: 1 },
  { units: 2, type: 8, dots: 0 },
  { units: 1, type: 16, dots: 0 }
];

/**
 * Splits a stretch of `length` sixteenths starting at `start` (within the bar)
 * into written note values, breaking at beats when it starts off the beat so
 * the beat stays visible, the way rhythms are usually written.
 */
export function splitDuration(start, length, unitsPerBeat = 4) {
  const parts = [];
  let pos = start;
  let left = length;
  while (left > 0) {
    let room = left;
    if (pos % unitsPerBeat !== 0) room = Math.min(room, unitsPerBeat - (pos % unitsPerBeat));
    const value = VALUES.find((v) => v.units <= room && (v.units < unitsPerBeat * 2 || pos % unitsPerBeat === 0));
    parts.push(value);
    pos += value.units;
    left -= value.units;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Chord shapes
// ---------------------------------------------------------------------------

// Common open shapes, written from the low E string to the high E string.
const OPEN_SHAPES = {
  C: 'x32010', A: 'x02220', G: '320003', E: '022100', D: 'xx0232',
  Am: 'x02210', Em: '022000', Dm: 'xx0231',
  C7: 'x32310', A7: 'x02020', G7: '320001', E7: '020100', D7: 'xx0212', B7: 'x21202',
  Am7: 'x02010', Em7: '022030', Dm7: 'xx0211',
  Cmaj7: 'x32000', Amaj7: 'x02120', Gmaj7: '320002', Dmaj7: 'xx0222', Fmaj7: 'xx3210', Emaj7: '021100',
  Asus4: 'x02230', Dsus4: 'xx0233', Esus4: '022200', Asus2: 'x02200', Dsus2: 'xx0230',
  E5: '022xxx', A5: 'x022xx', D5: 'xx023x'
};
// Movable barre shapes: frets above the root's fret, low E to high E (null = not played).
const E_SHAPES = { '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0], maj7: [0, null, 1, 1, 0, null], sus4: [0, 2, 2, 2, 0, 0], sus2: [0, 2, 4, 4, null, null], 5: [0, 2, 2, null, null, null], dim: [0, 1, 2, 0, null, null] };
const A_SHAPES = { '': [null, 0, 2, 2, 2, 0], m: [null, 0, 2, 2, 1, 0], 7: [null, 0, 2, 0, 2, 0], m7: [null, 0, 2, 0, 1, 0], maj7: [null, 0, 2, 1, 2, 0], sus4: [null, 0, 2, 2, 3, 0], sus2: [null, 0, 2, 2, 0, 0], 5: [null, 0, 2, 2, null, null], dim: [null, 0, 1, 2, 1, null] };

/**
 * A playable guitar shape for a chord: Songsterr-order strings (0 = high E)
 * with frets. Open shapes where they exist, otherwise the lower of the two
 * common barre shapes.
 */
export function chordShape(root, quality) {
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const open = OPEN_SHAPES[NAMES[root] + quality];
  let lowToHigh;
  if (open) lowToHigh = [...open].map((c) => (c === 'x' ? null : Number(c)));
  else {
    const eFret = (root - 4 + 12) % 12 || 12; // root on the low E string
    const aFret = (root - 9 + 12) % 12 || 12; // root on the A string
    const useE = (E_SHAPES[quality] && eFret <= aFret) || !A_SHAPES[quality];
    const shape = useE ? E_SHAPES[quality] : A_SHAPES[quality];
    const base = useE ? eFret : aFret;
    lowToHigh = shape.map((f) => (f == null ? null : base + f));
  }
  const out = [];
  lowToHigh.forEach((fret, i) => {
    if (fret != null) out.push({ string: 5 - i, fret, pitch: GUITAR_TUNING[5 - i] + fret });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

const loudest = (notes) => [notes.reduce((a, b) => (b.velocity > a.velocity || (b.velocity === a.velocity && b.pitch > a.pitch) ? b : a))];
const lowest = (notes) => {
  const top = Math.max(...notes.map((n) => n.velocity));
  const strong = notes.filter((n) => n.velocity >= top * 0.6);
  return [strong.reduce((a, b) => (b.pitch < a.pitch ? b : a))];
};
const chordOf = (notes) => {
  const byPitch = new Map();
  for (const n of notes) if (!byPitch.has(n.pitch) || byPitch.get(n.pitch).velocity < n.velocity) byPitch.set(n.pitch, n);
  return [...byPitch.values()].sort((a, b) => b.velocity - a.velocity).slice(0, 6);
};
const inRange = (notes, range) => notes.filter((n) => n.pitch >= range[0] && n.pitch <= range[1]);

/** Groups notes by the grid slot they start in. */
function bySlot(notes) {
  const groups = new Map();
  for (const n of notes) {
    if (!groups.has(n.slot)) groups.set(n.slot, []);
    groups.get(n.slot).push(n);
  }
  return groups;
}

function eventsFrom(groups, choose) {
  const events = new Map();
  for (const [slot, notes] of groups) {
    const chosen = notes.length ? choose(notes) : [];
    if (chosen.length) events.set(slot, chosen);
  }
  return events;
}

/**
 * The bass line: the lowest strong note at each moment, in the bass register.
 * A single note an octave above the notes around it is usually the octave
 * ringing over a missed low note, so it moves down.
 */
function bassEvents(notes) {
  const events = eventsFrom(bySlot(inRange(notes, [BASS_RANGE[0] - 12, BAND_SPLIT - 1])), lowest);
  const slots = [...events.keys()].sort((a, b) => a - b);
  slots.forEach((slot, i) => {
    const [n] = events.get(slot);
    const before = i > 0 ? events.get(slots[i - 1])[0].pitch : null;
    const after = i + 1 < slots.length ? events.get(slots[i + 1])[0].pitch : null;
    const near = [before, after].filter((p) => p != null);
    if (near.length && n.pitch - 12 >= BASS_RANGE[0] && near.every((p) => p <= n.pitch - 7)) events.set(slot, [{ ...n, pitch: n.pitch - 12 }]);
  });
  // Bass lines are played joined up: a short gap before the next note is no rest.
  slots.forEach((slot, i) => {
    const next = slots[i + 1];
    const [n] = events.get(slot);
    if (next != null && next - n.endSlot <= 2) events.set(slot, [{ ...events.get(slot)[0], endSlot: next }]);
  });
  return events;
}

/**
 * Strummed chords: a chord shape wherever the accompaniment starts several
 * notes together, and wherever the chord changes.
 */
function strumEvents(notes, chordAtSlot, changeSlots, slotsPerBeat, slotsPerBar) {
  const mid = bySlot(inRange(notes, [45, 79]));
  const strums = new Set(changeSlots);
  for (const [slot, list] of mid) if (list.length >= 2 || (list.length === 1 && slot % slotsPerBeat === 0)) strums.add(slot);
  // Write it the way strumming is written: a strum on every beat that has an
  // off-beat strum, and again at each bar line, so no strum needs a tie.
  const ordered = [...strums].sort((a, b) => a - b);
  if (ordered.length) {
    const first = ordered[0];
    for (const slot of ordered) {
      const onBeat = slot - (slot % slotsPerBeat);
      if (onBeat > first) strums.add(onBeat);
    }
    for (let bar = Math.ceil(first / slotsPerBar) * slotsPerBar; bar <= ordered.at(-1); bar += slotsPerBar) strums.add(bar);
  }
  const events = new Map();
  for (const slot of [...strums].sort((a, b) => a - b)) {
    const chord = chordAtSlot(slot);
    if (!chord) continue;
    const shape = chordShape(chord.root, chord.quality);
    // An off-beat strum lasts to the next beat; one on the beat until the next strum.
    const endSlot = slot % slotsPerBeat ? slot - (slot % slotsPerBeat) + slotsPerBeat : slot + slotsPerBar;
    events.set(slot, shape.map((p) => ({ ...p, velocity: 0.8, slot, endSlot })));
  }
  return events;
}

/** Picks the notes each instrument plays at each grid slot. */
function tracksFor(mode, notes, harmonyAt, melodyWeights) {
  const guitar = { name: 'Guitar', tuning: GUITAR_TUNING, program: GUITAR_PROGRAM, events: new Map() };
  const bass = { name: 'Bass', tuning: BASS_TUNING, program: BASS_PROGRAM, events: new Map() };
  if (mode === 'melody') {
    const line = melodyLine(notes.filter((n) => n.pitch >= GUITAR_RANGE[0]), melodyWeights ? { weights: melodyWeights } : {});
    // Notes the tune joins up last until the next note.
    line.forEach((n, i) => {
      const next = line[i + 1];
      if (next && Math.abs(n.start + n.duration - next.start) < 1e-6) n.endSlot = Math.max(n.slot + 1, next.slot);
    });
    guitar.events = eventsFrom(bySlot(inRange(line, GUITAR_RANGE)), loudest);
    guitar.name = 'Melody';
    return [guitar];
  }
  if (mode === 'bass') {
    bass.events = bassEvents(notes);
    return [bass];
  }
  if (mode === 'chords') {
    guitar.events = strumEvents(notes, harmonyAt.chordAtSlot, harmonyAt.changeSlots, harmonyAt.slotsPerBeat, harmonyAt.slotsPerBar);
    guitar.name = 'Chords';
    guitar.fixedFingering = true;
    return [guitar];
  }
  if (mode === 'guitar') {
    guitar.events = eventsFrom(bySlot(inRange(notes, GUITAR_RANGE)), chordOf);
    return [guitar];
  }
  // Guitar and bass: the bass takes the lowest note, the guitar the rest.
  bass.events = bassEvents(notes);
  const taken = new Set([...bass.events.values()].flat());
  guitar.events = eventsFrom(bySlot(inRange(notes.filter((n) => !taken.has(n)), GUITAR_RANGE)), chordOf);
  return [guitar, bass];
}

/**
 * Puts a chord's pitches on strings: highest pitch on the highest string it
 * fits, and so on down. The fingering optimizer later finds the comfortable
 * positions; this only has to be playable. Pitches with no string left are dropped.
 */
export function placeOnStrings(pitches, tuning) {
  const used = new Set();
  const out = [];
  for (const pitch of [...pitches].sort((a, b) => b - a)) {
    for (let s = 0; s < tuning.length; s++) {
      const fret = pitch - tuning[s];
      if (used.has(s) || fret < 0 || fret > MAX_FRET) continue;
      // Leave lower strings free for the lower notes still to come.
      used.add(s);
      out.push({ string: s, fret, pitch });
      break;
    }
  }
  return out;
}

/** Writes one track's events as Songsterr-style measures, with chords at `marks` (slot -> { text, frets }). */
function measuresFor(track, { totalSlots, slotsPerBar, unitsPerSlot, beatsPerBar, unitsPerBeat, marks }) {
  const slots = [...track.events.keys()].sort((a, b) => a - b);
  // Each event lasts until its notes end or the next event starts, whichever is first.
  const spans = slots.map((slot, i) => {
    const next = i + 1 < slots.length ? slots[i + 1] : totalSlots;
    const notes = track.events.get(slot);
    const end = Math.max(slot + 1, Math.min(next, Math.max(...notes.map((n) => n.endSlot ?? slot + 1))));
    return { slot, end, notes };
  });
  const markSlots = [...marks.keys()].sort((a, b) => a - b);

  const bars = Math.max(1, Math.ceil(totalSlots / slotsPerBar));
  const measures = [];
  let spanIndex = 0;
  let carried = null; // the part of a note continuing from the previous bar
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * slotsPerBar;
    const barEnd = barStart + slotsPerBar;
    const beats = [];
    const write = (from, to, notes, tieFirst) => {
      // Break at chord changes so each chord name sits on its own beat.
      const cuts = [from, ...markSlots.filter((m) => m > from && m < to), to];
      for (let c = 0; c + 1 < cuts.length; c++) {
        const a = cuts[c];
        const b = cuts[c + 1];
        splitDuration((a - barStart) * unitsPerSlot, (b - a) * unitsPerSlot, unitsPerBeat).forEach((v, k) => {
          const beat = { type: v.type, duration: [v.dots ? 3 : 1, v.dots ? v.type * 2 : v.type] };
          if (v.dots) beat.dots = v.dots;
          if (k === 0 && marks.has(a)) beat.chord = { ...marks.get(a) };
          if (!notes) {
            beat.rest = true;
            beat.notes = [{ rest: true }];
          } else {
            const tie = k > 0 || c > 0 || tieFirst;
            beat.notes = notes.map((n) => ({ string: n.string, fret: n.fret, ...(tie ? { tie: true } : {}) }));
          }
          beats.push(beat);
        });
      }
    };
    let pos = barStart;
    if (carried) {
      const to = Math.min(carried.end, barEnd);
      write(pos, to, carried.placed, true);
      pos = to;
      carried = carried.end > barEnd ? carried : null;
    }
    while (spanIndex < spans.length && spans[spanIndex].slot < barEnd) {
      const span = spans[spanIndex++];
      if (span.slot < pos) continue; // overlapped by a note held from the previous bar
      if (span.slot > pos) write(pos, span.slot, null);
      let placed;
      if (track.fixedFingering) placed = span.notes;
      else {
        // Notes below the lowest string (a 5-string bass part) go up an octave.
        const lowestString = Math.min(...track.tuning);
        placed = placeOnStrings(span.notes.map((n) => (n.pitch < lowestString ? n.pitch + 12 * Math.ceil((lowestString - n.pitch) / 12) : n.pitch)), track.tuning);
      }
      if (!placed.length) {
        pos = span.slot;
        continue;
      }
      const to = Math.min(span.end, barEnd);
      write(span.slot, to, placed, false);
      pos = to;
      if (span.end > barEnd) carried = { end: span.end, placed };
    }
    if (pos < barEnd) write(pos, barEnd, null);
    const measure = { voices: [{ beats }] };
    if (bar === 0) measure.signature = [beatsPerBar, 4];
    measures.push(measure);
  }
  return measures;
}

/** A steady pulse of beats covering from..to seconds, through beatTime. */
function steadyBeats(bpm, beatTime, from, to) {
  const period = 60 / bpm;
  const first = beatTime - Math.ceil((beatTime - from) / period + 1) * period;
  const beats = [];
  for (let t = first; t <= to + 2 * period; t += period) beats.push(t);
  return beats;
}

/** Half or double tempo: every other beat, or a beat between each two. */
function scaleBeats(beats, downbeat, scale) {
  if (scale === 0.5) {
    const parity = downbeat % 2;
    const kept = beats.filter((_, i) => i % 2 === parity);
    return { beats: kept, downbeat: (downbeat - parity) / 2 };
  }
  if (scale === 2) {
    const out = [];
    beats.forEach((b, i) => {
      out.push(b);
      if (i + 1 < beats.length) out.push((b + beats[i + 1]) / 2);
    });
    return { beats: out, downbeat: downbeat * 2 };
  }
  return { beats, downbeat };
}

/**
 * Turns notes into a score in Songsterr's format.
 * @param {Array<{start:number,duration:number,pitch:number,velocity:number}>} notes
 * @param {{ mode?: keyof TRANSCRIBE_MODES, analysis?: object, tempoScale?: 0.5 | 1 | 2,
 *   bpm?: number, beatTime?: number, beatsPerBar?: number, barShift?: number,
 *   grid?: 16 | 8, minVelocity?: number, chords?: boolean, title?: string, artist?: string }} options
 *   With `analysis` (from analyzeRecording) the music follows the beats found
 *   in the recording; with `bpm`, or without either, it uses a steady pulse.
 */
export function notesToBundle(notes, options = {}) {
  const { mode = 'guitar', barShift = 0, minVelocity = 0.2, title = 'Transcription', artist = 'Transcribed from audio', analysis = null, tempoScale = 1 } = options;
  const grid = options.grid || (mode === 'chords' ? 8 : 16);
  const cleaned = removeOvertones(mergeRetriggers(notes)).filter((n) => n.duration > 0 && n.velocity >= minVelocity);
  const firstNote = cleaned.length ? Math.min(...cleaned.map((n) => n.start)) : 0;
  const lastNote = cleaned.length ? Math.max(...cleaned.map((n) => n.start + n.duration)) : 1;

  // The beats the music is written against.
  let beats;
  let downbeat = null;
  let beatsPerBar = options.beatsPerBar || 4;
  let bpm;
  let beatTime;
  let confidence = null;
  if (analysis && !options.bpm) {
    const scaled = scaleBeats(analysis.beats, analysis.downbeat, tempoScale);
    beats = scaled.beats;
    beatsPerBar = options.beatsPerBar || analysis.beatsPerBar;
    downbeat = scaled.downbeat;
    bpm = Math.round(analysis.bpm * tempoScale);
    beatTime = beats[downbeat];
  } else {
    const tempo = options.bpm ? { bpm: options.bpm, beatTime: options.beatTime ?? estimateTempo(cleaned).beatTime } : estimateTempo(cleaned);
    bpm = Math.max(20, Math.min(400, tempo.bpm));
    beatTime = tempo.beatTime;
    confidence = tempo.confidence ?? null;
    beats = steadyBeats(bpm, beatTime, firstNote - 2, lastNote + 2);
  }
  bpm = Math.max(20, Math.min(400, bpm));
  const slotsPerBeat = grid === 8 ? 2 : 4;
  const unitsPerSlot = 4 / slotsPerBeat; // grid units are sixteenths
  const slotsPerBar = beatsPerBar * slotsPerBeat;

  // Bar 1 starts on a bar line at or before the first note (or, on a steady
  // pulse, on the beat at or before it), moved by barShift beats.
  const firstPos = beatPosition(beats, firstNote);
  let origin = Math.floor(firstPos + 0.5 / slotsPerBeat);
  if (downbeat != null) origin -= (((origin - downbeat) % beatsPerBar) + beatsPerBar) % beatsPerBar;
  origin -= barShift;
  const slotAt = (time) => Math.round((beatPosition(beats, time) - origin) * slotsPerBeat);

  const placed = cleaned.map((n) => {
    const slot = Math.max(0, slotAt(n.start));
    return { ...n, slot, endSlot: Math.max(slot + 1, slotAt(n.start + n.duration)) };
  });

  // Chord names, from the harmony heard on each beat.
  const marks = new Map();
  const chordBySlot = [];
  if (analysis?.harmony) {
    const chords = chordsPerBeat(analysis.harmony, beats, { beatsPerBar, downbeat: downbeat ?? 0 });
    let previous = null;
    chords.forEach((chord, i) => {
      const slot = Math.round((i - origin) * slotsPerBeat);
      if (slot < 0) return;
      chordBySlot.push({ slot, chord });
      if (chord && chord.name !== previous) {
        // Guitar parts get a diagram of the shape to play.
        const mark = { text: spellChord(chord, analysis.key) };
        if (mode !== 'bass') {
          const frets = new Array(6).fill(-1);
          for (const n of chordShape(chord.root, chord.quality)) frets[n.string] = n.fret;
          mark.frets = frets;
        }
        marks.set(slot, mark);
      }
      previous = chord ? chord.name : previous;
    });
  }
  const chordAtSlot = (slot) => {
    let found = null;
    for (const entry of chordBySlot) {
      if (entry.slot > slot) break;
      found = entry.chord;
    }
    return found;
  };
  const tracks = tracksFor(mode, placed, { chordAtSlot, changeSlots: [...marks.keys()], slotsPerBeat, slotsPerBar }, options.melodyWeights);

  let lastStart = 0;
  for (const t of tracks) for (const slot of t.events.keys()) lastStart = Math.max(lastStart, slot);
  // The music ends with the bar of the last note (its ring-out is cut there).
  const totalSlots = (Math.floor(lastStart / slotsPerBar) + 1) * slotsPerBar;
  for (const slot of [...marks.keys()]) if (slot >= totalSlots) marks.delete(slot);
  if (options.chords === false) marks.clear();
  const layout = { totalSlots, slotsPerBar, unitsPerSlot, beatsPerBar, unitsPerBeat: 4, marks };

  return {
    title,
    artist,
    ...(analysis?.key ? { key: { fifths: analysis.key.fifths, minor: analysis.key.minor, name: analysis.key.name } } : {}),
    transcription: { bpm, beatTime, mode, beatsPerBar, barShift, grid, minVelocity, confidence, tempoScale, followsBeats: !!analysis && !options.bpm },
    tracks: tracks.map((t, i) => ({
      meta: { title: t.name, instrumentId: t.program },
      data: {
        name: t.name,
        instrumentId: t.program,
        tuning: t.tuning.slice(),
        ...(t.fixedFingering ? { fixedFingering: true } : {}),
        // Chord names go above the first track only.
        measures: measuresFor(t, i === 0 ? layout : { ...layout, marks: new Map() }),
        automations: { tempo: [{ measure: 0, position: 0, bpm }] }
      }
    }))
  };
}
