// Audio transcription: turning the notes heard in a recording into a score.
//
// The notes come from Spotify's Basic Pitch model (see src/transcriber-worker.js)
// as { start, duration, pitch, velocity } in seconds. This module, which has no
// browser dependencies, cleans them up, finds the tempo and the beat, rounds
// everything to a rhythm grid and writes the result in the same Songsterr-style
// format the rest of the app reads, so a transcription opens like any tab.

export const TRANSCRIBE_MODES = {
  guitar: { label: 'Guitar (chords and notes)' },
  melody: { label: 'Melody or solo (one note at a time)' },
  bass: { label: 'Bass' },
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
// Tracks
// ---------------------------------------------------------------------------

/** Picks the notes each instrument plays at each grid position. */
function voicesFor(mode, groups) {
  const pick = (notes, range, choose) => {
    const inRange = notes.filter((n) => n.pitch >= range[0] && n.pitch <= range[1]);
    return inRange.length ? choose(inRange) : [];
  };
  const loudest = (notes) => [notes.reduce((a, b) => (b.velocity > a.velocity || (b.velocity === a.velocity && b.pitch > a.pitch) ? b : a))];
  const lowest = (notes) => {
    const top = Math.max(...notes.map((n) => n.velocity));
    const strong = notes.filter((n) => n.velocity >= top * 0.6);
    return [strong.reduce((a, b) => (b.pitch < a.pitch ? b : a))];
  };
  const chord = (notes) => {
    const byPitch = new Map();
    for (const n of notes) if (!byPitch.has(n.pitch) || byPitch.get(n.pitch).velocity < n.velocity) byPitch.set(n.pitch, n);
    return [...byPitch.values()].sort((a, b) => b.velocity - a.velocity).slice(0, 6);
  };

  const guitar = { name: 'Guitar', tuning: GUITAR_TUNING, program: GUITAR_PROGRAM, events: new Map() };
  const bass = { name: 'Bass', tuning: BASS_TUNING, program: BASS_PROGRAM, events: new Map() };
  for (const [slot, notes] of groups) {
    if (mode === 'guitar') guitar.events.set(slot, pick(notes, GUITAR_RANGE, chord));
    else if (mode === 'melody') guitar.events.set(slot, pick(notes, GUITAR_RANGE, loudest));
    else if (mode === 'bass') bass.events.set(slot, pick(notes, [BASS_RANGE[0] - 12, BASS_RANGE[1]], lowest));
    else {
      const low = pick(notes, [BASS_RANGE[0] - 12, BAND_SPLIT - 1], lowest);
      bass.events.set(slot, low);
      guitar.events.set(slot, pick(notes.filter((n) => !low.includes(n)), GUITAR_RANGE, chord));
    }
  }
  if (mode === 'melody') guitar.name = 'Melody';
  const tracks = mode === 'guitar' || mode === 'melody' ? [guitar] : mode === 'bass' ? [bass] : [guitar, bass];
  for (const t of tracks) for (const [slot, notes] of t.events) if (!notes.length) t.events.delete(slot);
  return tracks;
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

/** Writes one track's events as Songsterr-style measures. */
function measuresFor(track, { totalSlots, slotsPerBar, unitsPerSlot, beatsPerBar, unitsPerBeat, ends }) {
  const slots = [...track.events.keys()].sort((a, b) => a - b);
  // Each event lasts until its notes end or the next event starts, whichever is first.
  const spans = slots.map((slot, i) => {
    const next = i + 1 < slots.length ? slots[i + 1] : totalSlots;
    const end = Math.max(slot + 1, Math.min(next, ends.get(track.events.get(slot)) ?? slot + 1));
    return { slot, end, notes: track.events.get(slot) };
  });

  const bars = Math.max(1, Math.ceil(totalSlots / slotsPerBar));
  const measures = [];
  let spanIndex = 0;
  let carried = null; // the part of a note continuing from the previous bar
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * slotsPerBar;
    const barEnd = barStart + slotsPerBar;
    const beats = [];
    const write = (from, to, notes, tieFirst) => {
      splitDuration((from - barStart) * unitsPerSlot, (to - from) * unitsPerSlot, unitsPerBeat).forEach((v, k) => {
        const beat = { type: v.type, duration: [v.dots ? 3 : 1, v.dots ? v.type * 2 : v.type] };
        if (v.dots) beat.dots = v.dots;
        if (!notes) {
          beat.rest = true;
          beat.notes = [{ rest: true }];
        } else {
          beat.notes = notes.map((n) => ({ string: n.string, fret: n.fret, ...(k > 0 || tieFirst ? { tie: true } : {}) }));
        }
        beats.push(beat);
      });
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
      // Notes below the lowest string (a 5-string bass part) go up an octave.
      const lowest = Math.min(...track.tuning);
      const placed = placeOnStrings(span.notes.map((n) => (n.pitch < lowest ? n.pitch + 12 * Math.ceil((lowest - n.pitch) / 12) : n.pitch)), track.tuning);
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

/**
 * Turns notes into a score in Songsterr's format.
 * @param {Array<{start:number,duration:number,pitch:number,velocity:number}>} notes
 * @param {{ mode?: keyof TRANSCRIBE_MODES, bpm?: number, beatTime?: number,
 *   beatsPerBar?: number, barShift?: number, grid?: 16 | 8, title?: string, artist?: string }} options
 */
export function notesToBundle(notes, options = {}) {
  const { mode = 'guitar', beatsPerBar = 4, barShift = 0, grid = 16, minVelocity = 0.2, title = 'Transcription', artist = 'Transcribed from audio' } = options;
  const cleaned = removeOvertones(notes).filter((n) => n.duration > 0 && n.velocity >= minVelocity);
  const tempo = options.bpm ? { bpm: options.bpm, beatTime: options.beatTime ?? estimateTempo(cleaned).beatTime } : estimateTempo(cleaned);
  const bpm = Math.max(20, Math.min(400, tempo.bpm));
  const beat = 60 / bpm;
  const slotsPerBeat = grid === 8 ? 2 : 4;
  const unitsPerSlot = 4 / slotsPerBeat; // grid units are sixteenths
  const slotTime = beat / slotsPerBeat;
  // Bar 1 starts on the beat at or before the first note, moved by barShift beats.
  const firstNote = cleaned.length ? Math.min(...cleaned.map((n) => n.start)) : 0;
  let origin = tempo.beatTime;
  while (origin > firstNote + slotTime / 2) origin -= beat;
  while (origin + beat <= firstNote - slotTime / 2) origin += beat;
  origin -= barShift * beat;

  const groups = new Map();
  const ends = new Map();
  for (const n of cleaned) {
    const slot = Math.max(0, Math.round((n.start - origin) / slotTime));
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push({ ...n, slot, endSlot: Math.max(slot + 1, Math.round((n.start + n.duration - origin) / slotTime)) });
  }
  const tracks = voicesFor(mode, groups);
  let lastStart = 0;
  for (const t of tracks) {
    for (const [slot, notesAt] of t.events) {
      ends.set(notesAt, Math.max(...notesAt.map((n) => n.endSlot)));
      lastStart = Math.max(lastStart, slot);
    }
  }
  // The music ends with the bar of the last note (its ring-out is cut there).
  const slotsPerBar = beatsPerBar * slotsPerBeat;
  const totalSlots = (Math.floor(lastStart / slotsPerBar) + 1) * slotsPerBar;
  const layout = { totalSlots, slotsPerBar, unitsPerSlot, beatsPerBar, unitsPerBeat: 4, ends };

  return {
    title,
    artist,
    transcription: { bpm, beatTime: tempo.beatTime, mode, beatsPerBar, barShift, grid, minVelocity, confidence: tempo.confidence ?? null },
    tracks: tracks.map((t) => ({
      meta: { title: t.name, instrumentId: t.program },
      data: {
        name: t.name,
        instrumentId: t.program,
        tuning: t.tuning.slice(),
        measures: measuresFor(t, layout),
        automations: { tempo: [{ measure: 0, position: 0, bpm }] }
      }
    }))
  };
}
