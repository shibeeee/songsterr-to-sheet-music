// Turning a part into music for another instrument: bass tab into a tuba
// part, a guitar riff into a trumpet part, and so on.
//
// The new part is written in standard notation the way that instrument reads
// it: its clef, its transposition (a B-flat trumpet reads a tone higher than it
// sounds, a brass-band E-flat tuba reads in treble clef), its key signature,
// and only notes it can play, one at a time. The original track stays as it is.

// Ranges are sounding pitches as MIDI notes: [lowest, highest] the instrument
// can play, and [low, high] where most players are comfortable.
// `written` is how many semitones above the sound the part is written.
export const INSTRUMENTS = {
  tuba: { name: 'Tuba', short: 'Tba.', family: 'Brass', label: 'Tuba (bass clef)', program: 58, clef: 'F4', written: 0, range: [26, 65], comfortable: [28, 58] },
  'tuba-eb': { name: 'E♭ Tuba', short: 'E♭ Tba.', family: 'Brass', label: 'E♭ tuba (brass band, treble clef)', program: 58, clef: 'G2', written: 21, range: [28, 63], comfortable: [31, 58] },
  'tuba-bb': { name: 'B♭ Tuba', short: 'B♭ Tba.', family: 'Brass', label: 'B♭ tuba (brass band, treble clef)', program: 58, clef: 'G2', written: 26, range: [26, 60], comfortable: [28, 55] },
  euphonium: { name: 'Euphonium', short: 'Euph.', family: 'Brass', label: 'Euphonium (bass clef)', program: 57, clef: 'F4', written: 0, range: [34, 72], comfortable: [40, 65] },
  'euphonium-treble': { name: 'Euphonium', short: 'Euph.', family: 'Brass', label: 'Euphonium (treble clef, B♭)', program: 57, clef: 'G2', written: 14, range: [34, 72], comfortable: [40, 65] },
  trombone: { name: 'Trombone', short: 'Tbn.', family: 'Brass', label: 'Trombone', program: 57, clef: 'F4', written: 0, range: [40, 72], comfortable: [41, 67] },
  'bass-trombone': { name: 'Bass Trombone', short: 'B. Tbn.', family: 'Brass', label: 'Bass trombone', program: 57, clef: 'F4', written: 0, range: [31, 67], comfortable: [34, 62] },
  horn: { name: 'Horn in F', short: 'Hn.', family: 'Brass', label: 'French horn in F', program: 60, clef: 'G2', written: 7, range: [34, 77], comfortable: [41, 72] },
  trumpet: { name: 'Trumpet in B♭', short: 'Tpt.', family: 'Brass', label: 'Trumpet in B♭', program: 56, clef: 'G2', written: 2, range: [52, 82], comfortable: [55, 77] },
  flute: { name: 'Flute', short: 'Fl.', family: 'Woodwind', label: 'Flute', program: 73, clef: 'G2', written: 0, range: [60, 96], comfortable: [62, 91] },
  clarinet: { name: 'Clarinet in B♭', short: 'Cl.', family: 'Woodwind', label: 'Clarinet in B♭', program: 71, clef: 'G2', written: 2, range: [50, 89], comfortable: [52, 84] },
  'bass-clarinet': { name: 'Bass Clarinet', short: 'B. Cl.', family: 'Woodwind', label: 'Bass clarinet in B♭', program: 71, clef: 'G2', written: 14, range: [34, 75], comfortable: [38, 70] },
  'alto-sax': { name: 'Alto Saxophone', short: 'A. Sax.', family: 'Woodwind', label: 'Alto sax in E♭', program: 65, clef: 'G2', written: 9, range: [49, 80], comfortable: [51, 77] },
  'tenor-sax': { name: 'Tenor Saxophone', short: 'T. Sax.', family: 'Woodwind', label: 'Tenor sax in B♭', program: 66, clef: 'G2', written: 14, range: [44, 75], comfortable: [46, 72] },
  'bari-sax': { name: 'Baritone Saxophone', short: 'Bar. Sax.', family: 'Woodwind', label: 'Baritone sax in E♭', program: 67, clef: 'G2', written: 21, range: [36, 68], comfortable: [38, 65] },
  bassoon: { name: 'Bassoon', short: 'Bsn.', family: 'Woodwind', label: 'Bassoon', program: 70, clef: 'F4', written: 0, range: [34, 75], comfortable: [36, 70] },
  violin: { name: 'Violin', short: 'Vln.', family: 'Strings', label: 'Violin', program: 40, clef: 'G2', written: 0, range: [55, 100], comfortable: [55, 88] },
  viola: { name: 'Viola', short: 'Vla.', family: 'Strings', label: 'Viola (alto clef)', program: 41, clef: 'C3', written: 0, range: [48, 88], comfortable: [48, 79] },
  cello: { name: 'Cello', short: 'Vc.', family: 'Strings', label: 'Cello', program: 42, clef: 'F4', written: 0, range: [36, 81], comfortable: [36, 72] },
  'double-bass': { name: 'Double Bass', short: 'Cb.', family: 'Strings', label: 'Double bass (upright)', program: 43, clef: 'F4', written: 12, range: [28, 67], comfortable: [28, 60] },
  piano: { name: 'Piano', short: 'Pno.', family: 'Keyboard', label: 'Piano (one staff, chords kept)', program: 0, clef: 'auto', written: 0, range: [21, 108], comfortable: [21, 108], chords: true }
};

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** "E1", "B♭3": a pitch name with its octave (middle C is C4). */
export function pitchName(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

const INTERVALS = { 2: 'a tone', 7: 'a 5th', 9: 'a major 6th', 12: 'an octave', 14: 'a 9th', 21: 'an octave and a 6th', 26: 'two octaves and a tone' };

/** How a part is written compared to how it sounds, in words. */
export function transpositionText(written) {
  if (!written) return 'concert pitch';
  const by = INTERVALS[Math.abs(written)] || `${Math.abs(written)} semitones`;
  return `written ${by} ${written > 0 ? 'higher' : 'lower'} than it sounds`;
}

/** The key signature an instrument reads, given the concert key (in sharps, minus for flats). */
export function writtenKey(fifths, written) {
  let shift = (((written * 7) % 12) + 12) % 12;
  if (shift > 6) shift -= 12;
  let key = fifths + shift;
  if (key > 7) key -= 12;
  if (key < -7) key += 12;
  return key;
}

/** The instrument that best suits a track: a tuba for a bass, a trumpet for a high part. */
export function suggestInstrument(track) {
  const staff = track.staves[0];
  const pitches = [];
  for (const bar of staff.bars) for (const beat of bar.voices[0]?.beats || []) for (const note of beat.notes) if (!note.isDead) pitches.push(note.realValueWithoutHarmonic ?? note.realValue);
  if (!pitches.length) return 'tuba';
  pitches.sort((a, b) => a - b);
  const middle = pitches[pitches.length >> 1];
  if (middle < 48) return 'tuba';
  if (middle < 60) return 'trombone';
  return 'trumpet';
}

const pitchOf = (note) => note.realValueWithoutHarmonic ?? note.realValue;

/**
 * Picks the note an instrument that plays one note at a time would play on
 * each beat: the lowest for low instruments (the bass line), the highest for
 * the others (the tune).
 */
function chooseNotes(beat, instrument) {
  const notes = beat.notes.filter((n) => !n.isDead && pitchOf(n) > 0);
  if (instrument.chords || notes.length <= 1) return notes;
  const low = (instrument.comfortable[0] + instrument.comfortable[1]) / 2 < 55;
  return [notes.reduce((a, b) => ((low ? pitchOf(b) < pitchOf(a) : pitchOf(b) > pitchOf(a)) ? b : a))];
}

/**
 * How far to move the whole part, in octaves: not at all when it already
 * fits (a bass line on tuba stays at the pitch it sounds), otherwise the move
 * that puts the most notes in the instrument's range, then in its comfortable
 * range, then the smallest move.
 */
export function bestOctave(pitches, instrument) {
  if (!pitches.length) return 0;
  const [low, high] = instrument.range;
  const [cLow, cHigh] = instrument.comfortable;
  const fits = (k) => pitches.filter((p) => p + 12 * k >= low && p + 12 * k <= high).length;
  const comfy = (k) => pitches.filter((p) => p + 12 * k >= cLow && p + 12 * k <= cHigh).length;
  let best = 0;
  for (let k = -3; k <= 3; k++) {
    const better = fits(k) - fits(best) || comfy(k) - comfy(best) || Math.abs(best) - Math.abs(k);
    if (better > 0) best = k;
  }
  // Mostly playable as it is, and about as comfortable: keep the sound (a
  // bass line on tuba) and move only the stray notes.
  const n = pitches.length;
  if (fits(0) >= n * 0.8 && comfy(0) >= comfy(best) - Math.max(1, n * 0.15)) return 0;
  return best;
}

/** Moves a pitch by octaves until the instrument can play it. */
function intoRange(pitch, [low, high]) {
  let p = pitch;
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p >= low ? p : pitch;
}

function freeChannel(score) {
  const used = new Set();
  for (const t of score.tracks) {
    used.add(t.playbackInfo.primaryChannel);
    used.add(t.playbackInfo.secondaryChannel);
  }
  for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) return c;
  return 15;
}

function uniqueName(score, name) {
  const names = new Set(score.tracks.map((t) => t.name));
  if (!names.has(name)) return name;
  let n = 2;
  while (names.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/**
 * Adds a part for `instrumentKey` made from track `trackIndex`.
 * @param {{ octave?: 'auto' | number }} options octave: 'auto', or a move in octaves (0 keeps the sound)
 * @returns {{ index: number, name: string, octave: number, foldedUp: number, foldedDown: number,
 *   chordsReduced: number, deadNotes: number, notes: number, lowest: number | null, highest: number | null,
 *   uncomfortable: number }}
 */
export function convertToInstrument(m, score, trackIndex, instrumentKey, { octave = 'auto' } = {}) {
  const instrument = INSTRUMENTS[instrumentKey];
  if (!instrument) throw new Error(`Unknown instrument: ${instrumentKey}`);
  const source = score.tracks[trackIndex];
  const staff = source?.staves[0];
  if (!staff || staff.isPercussion) throw new Error('Drum parts have no notes to give another instrument.');

  // 1. The note (or notes) to play on each beat, as sounding pitches.
  const report = { chordsReduced: 0, deadNotes: 0, foldedUp: 0, foldedDown: 0 };
  const plan = staff.bars.map((bar) =>
    (bar.voices[0]?.beats || []).map((beat) => {
      const chosen = chooseNotes(beat, instrument);
      const playable = beat.notes.filter((n) => !n.isDead).length;
      if (playable > chosen.length) report.chordsReduced++;
      report.deadNotes += beat.notes.filter((n) => n.isDead).length;
      return { beat, notes: chosen.map((n) => ({ note: n, pitch: pitchOf(n), tie: n.isTieDestination })) };
    })
  );

  // 2. Move the part into the instrument's range.
  const all = plan.flat().flatMap((b) => b.notes.filter((n) => !n.tie).map((n) => n.pitch));
  const shift = octave === 'auto' ? bestOctave(all, instrument) : Number(octave) || 0;
  for (const beat of plan.flat()) {
    for (const n of beat.notes) {
      const moved = n.pitch + 12 * shift;
      n.pitch = intoRange(moved, instrument.range);
      if (!n.tie && n.pitch > moved) report.foldedUp++;
      if (!n.tie && n.pitch < moved) report.foldedDown++;
    }
  }
  // A tied note keeps the pitch it is tied to.
  const playedPitch = new Map();
  for (const beat of plan.flat()) {
    for (const n of beat.notes) {
      const origin = n.note.tieOrigin;
      if (n.tie && origin && playedPitch.has(origin)) n.pitch = playedPitch.get(origin);
      playedPitch.set(n.note, n.pitch);
    }
  }

  // 3. Write the new part.
  const pitches = plan.flat().flatMap((b) => b.notes.map((n) => n.pitch));
  const track = new m.Track();
  track.name = uniqueName(score, instrument.name);
  track.shortName = instrument.short;
  const channel = freeChannel(score);
  track.playbackInfo.program = instrument.program;
  track.playbackInfo.primaryChannel = channel;
  track.playbackInfo.secondaryChannel = channel;
  track.playbackInfo.volume = 13;
  track.playbackInfo.balance = 8;
  const target = new m.Staff();
  track.addStaff(target);
  target.showTablature = false;
  target.showStandardNotation = true;
  // alphaTab shows notes `displayTranspositionPitch` below their sound.
  target.displayTranspositionPitch = instrument.written ? -instrument.written : 0;

  let clef = instrument.clef;
  if (clef === 'auto') {
    const sorted = [...pitches].sort((a, b) => a - b);
    clef = sorted.length && sorted[sorted.length >> 1] < 60 ? 'F4' : 'G2';
  }
  const made = new Map(); // source note -> new note, for ties
  plan.forEach((beats, barIndex) => {
    const sourceBar = staff.bars[barIndex];
    const bar = new m.Bar();
    bar.clef = m.Clef[clef];
    bar.clefOttava = m.Ottavia.Regular;
    bar.keySignature = writtenKey(sourceBar.keySignature ?? 0, instrument.written);
    bar.keySignatureType = sourceBar.keySignatureType ?? m.KeySignatureType.Major;
    target.addBar(bar);
    const voice = new m.Voice();
    bar.addVoice(voice);
    if (!beats.length) {
      const rest = new m.Beat();
      rest.isEmpty = true;
      voice.addBeat(rest);
      return;
    }
    for (const { beat: from, notes } of beats) {
      const beat = new m.Beat();
      beat.duration = from.duration;
      beat.dots = from.dots;
      beat.tupletNumerator = from.tupletNumerator;
      beat.tupletDenominator = from.tupletDenominator;
      beat.graceType = from.graceType;
      beat.text = from.text;
      beat.dynamics = from.dynamics;
      beat.fermata = from.fermata;
      beat.isEmpty = false;
      for (const { note: old, pitch, tie } of notes) {
        const note = new m.Note();
        note.octave = Math.floor(pitch / 12);
        note.tone = pitch % 12;
        note.accentuated = old.accentuated;
        note.isStaccato = old.isStaccato;
        if (tie && old.tieOrigin && made.has(old.tieOrigin)) {
          note.isTieDestination = true;
          note.tieOrigin = made.get(old.tieOrigin);
          made.get(old.tieOrigin).tieDestination = note;
        }
        made.set(old, note);
        beat.addNote(note);
      }
      voice.addBeat(beat);
    }
  });
  score.addTrack(track);

  const [cLow, cHigh] = instrument.comfortable;
  return {
    ...report,
    index: track.index,
    name: track.name,
    octave: shift,
    notes: pitches.length,
    lowest: pitches.length ? Math.min(...pitches) : null,
    highest: pitches.length ? Math.max(...pitches) : null,
    uncomfortable: pitches.filter((p) => p < cLow || p > cHigh).length
  };
}
