// Converts Songsterr track payloads into an alphaTab Score.
//
// The module takes the alphaTab namespace as a parameter so the same code runs
// in the browser (loaded from /vendor/alphatab) and in Node tests.
//
// Input "bundle" shape (what /api/songsterr returns):
//   {
//     title, artist, songId?, revisionId?,
//     tracks: [ { meta?: { partId, instrumentId, name, title, tuning, isDrums }, data: <track payload> } ]
//   }
//
// Songsterr conventions worth remembering:
//   - string 0 is the highest-pitched string; alphaTab counts from 1 = lowest.
//   - `tuning` lists MIDI notes from the highest string down (same as alphaTab).
//   - beat `type` is the written note value, `dots`/`tuplet` modify it, and
//     `duration` is the real length as a fraction of a whole note.
//   - drums use instrumentId 1024; `fret` is the GM drum note and `string` is the
//     vertical staff position (0 = top line, 0.5 per step downwards).

const DRUM_INSTRUMENT_ID = 1024;
const PERCUSSION_CHANNEL = 9;

const DYNAMICS = { ppp: 'PPP', pp: 'PP', p: 'P', mp: 'MP', mf: 'MF', f: 'F', ff: 'FF', fff: 'FFF' };

const HARMONICS = {
  natural: 'Natural',
  artificial: 'Artificial',
  pinch: 'Pinch',
  tap: 'Tap',
  semi: 'Semi',
  feedback: 'Feedback'
};

// GM drum notes that are usually written with cross noteheads.
const CYMBAL_NOTES = new Set([42, 44, 46, 49, 51, 52, 53, 55, 57, 59]);

// Fallback staff positions (Songsterr units) for drum notes without one.
const DEFAULT_DRUM_POSITIONS = {
  35: 4, 36: 3.5, 37: 1.5, 38: 1.5, 40: 1.5, 41: 3, 42: -0.5, 43: 2.5, 44: 4.5, 45: 2,
  46: -0.5, 47: 1, 48: 0.5, 49: -1, 50: 0, 51: 0, 52: -1, 53: 0, 55: -1, 57: -1, 59: 0
};

const DRUM_NAMES = {
  35: 'Kick', 36: 'Kick', 37: 'Side Stick', 38: 'Snare', 40: 'Snare (rim)', 41: 'Floor Tom',
  42: 'Hi-Hat (closed)', 43: 'Floor Tom', 44: 'Hi-Hat (pedal)', 45: 'Low Tom', 46: 'Hi-Hat (open)',
  47: 'Mid Tom', 48: 'High Tom', 49: 'Crash', 50: 'High Tom', 51: 'Ride', 52: 'China',
  53: 'Ride Bell', 55: 'Splash', 57: 'Crash 2', 59: 'Ride 2'
};

const STANDARD_TUPLET_DENOMINATORS = { 3: 2, 5: 4, 6: 4, 7: 4, 9: 8, 10: 8, 11: 8, 12: 8, 13: 8 };

/**
 * @param {any} alphaTab the alphaTab module namespace
 * @param {object} bundle see the shape documented above
 * @returns {{ score: any, warnings: string[] }}
 */
export function songsterrToScore(alphaTab, bundle) {
  const m = alphaTab.model;
  const warnings = [];
  const tracks = normalizeTracks(bundle);
  if (tracks.length === 0) throw new Error('No tracks found in the Songsterr data.');

  const score = new m.Score();
  score.title = bundle.title || tracks[0].data.title || 'Untitled';
  score.artist = bundle.artist || '';
  score.tab = 'Converted from Songsterr';

  const measureCount = Math.max(...tracks.map((t) => (t.data.measures || []).length));
  buildMasterBars(m, score, tracks, measureCount);

  let nextChannel = 0;
  tracks.forEach((entry, trackIndex) => {
    const isDrums = isDrumTrack(entry);
    let channel = PERCUSSION_CHANNEL;
    if (!isDrums) {
      channel = nextChannel === PERCUSSION_CHANNEL ? ++nextChannel : nextChannel;
      nextChannel = (channel + 1) % 16;
    }
    buildTrack(m, score, entry, { isDrums, channel, measureCount, trackIndex, warnings });
  });

  score.finish(new alphaTab.Settings());
  return { score, warnings };
}

/** Accepts the bundle format, a bare track payload, or an array of payloads. */
export function normalizeTracks(bundle) {
  if (!bundle) return [];
  if (Array.isArray(bundle)) return bundle.map((data) => ({ meta: {}, data }));
  if (Array.isArray(bundle.measures)) return [{ meta: {}, data: bundle }];
  return (bundle.tracks || [])
    .map((t) => (t && t.data ? { meta: t.meta || {}, data: t.data } : { meta: {}, data: t }))
    .filter((t) => t.data && Array.isArray(t.data.measures));
}

function isDrumTrack(entry) {
  const id = entry.meta.instrumentId ?? entry.data.instrumentId;
  return id === DRUM_INSTRUMENT_ID || entry.meta.isDrums === true;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'string') return value.text;
  return '';
}

// ---------------------------------------------------------------------------
// Master bars: time signatures, tempo, repeats, sections
// ---------------------------------------------------------------------------

function buildMasterBars(m, score, tracks, measureCount) {
  const reference = tracks[0].data.measures;
  let signature = [4, 4];

  for (let i = 0; i < measureCount; i++) {
    const mb = new m.MasterBar();
    // Structural info is usually identical on every track; take the first that has it.
    const measures = tracks.map((t) => t.data.measures[i]).filter(Boolean);
    const first = reference[i] || measures[0] || {};
    const pick = (key) => {
      for (const ms of measures) if (ms[key] !== undefined) return ms[key];
      return undefined;
    };

    const sig = pick('signature');
    if (Array.isArray(sig) && sig.length === 2) signature = sig;
    mb.timeSignatureNumerator = signature[0];
    mb.timeSignatureDenominator = signature[1];

    if (pick('repeatStart')) mb.isRepeatStart = true;
    const repeat = pick('repeat') ?? pick('repeatCount');
    if (typeof repeat === 'number' && repeat > 0) mb.repeatCount = repeat;
    else if (pick('repeatEnd')) mb.repeatCount = 2;

    const ending = pick('alternateEnding');
    if (ending !== undefined) mb.alternateEndings = endingMask(ending);

    if (pick('doubleBarline') || first.doubleBar) mb.isDoubleBar = true;

    const marker = textOf(pick('marker'));
    if (marker) {
      const section = new m.Section();
      section.text = marker;
      mb.section = section;
    }

    score.addMasterBar(mb);
  }

  applyTempo(m, score, tracks);
}

function endingMask(ending) {
  const list = Array.isArray(ending) ? ending : [ending];
  return list.reduce((mask, n) => (n >= 1 && n <= 8 ? mask | (1 << (n - 1)) : mask), 0);
}

function applyTempo(m, score, tracks) {
  const source = tracks.find((t) => t.data.automations && Array.isArray(t.data.automations.tempo));
  const points = source ? source.data.automations.tempo : [];
  // reference 2 = tempo expressed in quarter notes
  const add = (index, ratio, bpm) => {
    const mb = score.masterBars[index];
    if (!mb) return;
    mb.tempoAutomations.push(m.Automation.buildTempoAutomation(false, ratio, bpm, 2));
  };

  let hasFirst = false;
  for (const p of points) {
    if (typeof p.bpm !== 'number' || p.bpm <= 0) continue;
    const measure = p.measure || 0;
    const ratio = typeof p.position === 'number' && p.position > 0 && p.position < 1 ? p.position : 0;
    if (measure === 0 && ratio === 0) hasFirst = true;
    add(measure, ratio, p.bpm);
  }
  if (!hasFirst) score.masterBars[0].tempoAutomations.unshift(m.Automation.buildTempoAutomation(false, 0, 120, 2));
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

function buildTrack(m, score, entry, ctx) {
  const { data, meta } = entry;
  const track = new m.Track();
  track.name = meta.title || meta.name || data.name || `Track ${ctx.trackIndex + 1}`;
  track.shortName = track.name.slice(0, 10);
  score.addTrack(track);

  const staff = new m.Staff();
  track.addStaff(staff);

  const instrumentId = meta.instrumentId ?? data.instrumentId ?? 25;
  track.playbackInfo.program = ctx.isDrums ? 0 : clamp(instrumentId, 0, 127);
  track.playbackInfo.primaryChannel = ctx.channel;
  track.playbackInfo.secondaryChannel = ctx.channel;
  track.playbackInfo.volume = 15;

  const tuning = Array.isArray(data.tuning) && data.tuning.length ? data.tuning : meta.tuning;
  let numStrings = 6;
  if (ctx.isDrums) {
    staff.isPercussion = true;
    staff.showTablature = false;
  } else if (Array.isArray(tuning) && tuning.length) {
    staff.stringTuning = new m.Tuning('', tuning.slice(), false);
    const preset = m.Tuning.findTuning(tuning);
    if (preset) staff.stringTuning.name = preset.name;
    numStrings = tuning.length;
  } else {
    const preset = m.Tuning.getDefaultTuningFor(data.strings || 6);
    if (preset) staff.stringTuning = new m.Tuning(preset.name, preset.tunings.slice(), true);
    numStrings = data.strings || 6;
  }
  if (typeof data.capo === 'number' && data.capo > 0) staff.capo = data.capo;

  const drumKit = ctx.isDrums ? new DrumKit(m, track) : null;
  const lowest = Array.isArray(tuning) && tuning.length ? Math.min(...tuning) : 40;
  const isBass = !ctx.isDrums && lowest < 36;

  for (let i = 0; i < ctx.measureCount; i++) {
    const bar = new m.Bar();
    if (ctx.isDrums) {
      bar.clef = m.Clef.Neutral;
    } else if (isBass) {
      bar.clef = m.Clef.F4;
      bar.clefOttava = m.Ottavia._8vb;
    } else {
      bar.clef = m.Clef.G2;
      bar.clefOttava = m.Ottavia._8vb;
    }
    staff.addBar(bar);

    const measure = data.measures[i];
    const voices = (measure && measure.voices) || [];
    voices.forEach((voiceData, voiceIndex) => {
      if (voiceIndex > 0 && isRestOnly(voiceData)) return;
      const voice = new m.Voice();
      bar.addVoice(voice);
      for (const beatData of voiceData.beats || []) {
        const loc = `${track.name}, bar ${i + 1}`;
        voice.addBeat(buildBeat(m, staff, beatData, { numStrings, drumKit, loc, warnings: ctx.warnings }));
      }
      if (voice.beats.length === 0) voice.addBeat(restBeat(m));
    });

    if (bar.voices.length === 0) {
      const voice = new m.Voice();
      bar.addVoice(voice);
      voice.addBeat(restBeat(m));
    }
  }
}

function isRestOnly(voiceData) {
  if (!voiceData || voiceData.rest) return true;
  const beats = voiceData.beats || [];
  return beats.every((b) => b.rest || !(b.notes || []).some((n) => !n.rest));
}

function restBeat(m) {
  const beat = new m.Beat();
  beat.duration = m.Duration.Whole;
  return beat;
}

// ---------------------------------------------------------------------------
// Beats and notes
// ---------------------------------------------------------------------------

function buildBeat(m, staff, b, ctx) {
  const beat = new m.Beat();
  applyDuration(m, beat, b);

  if (b.graceNote === 'beforeBeat') beat.graceType = m.GraceType.BeforeBeat;
  else if (b.graceNote === 'onBeat') beat.graceType = m.GraceType.OnBeat;

  const text = textOf(b.text);
  if (text) beat.text = text;

  if (typeof b.velocity === 'string' && DYNAMICS[b.velocity]) beat.dynamics = m.DynamicValue[DYNAMICS[b.velocity]];

  if (b.pickStroke === 'up') beat.pickStroke = m.PickStroke.Up;
  else if (b.pickStroke === 'down') beat.pickStroke = m.PickStroke.Down;

  if (b.brushStroke && typeof b.brushStroke === 'object') {
    beat.brushType = b.brushStroke.direction === 'up' ? m.BrushType.BrushUp : m.BrushType.BrushDown;
  } else if (b.upStroke) {
    beat.brushType = m.BrushType.BrushUp;
  } else if (b.downStroke) {
    beat.brushType = m.BrushType.BrushDown;
  }

  if (b.wideVibrato) beat.vibrato = m.VibratoType.Wide;
  else if (b.vibrato) beat.vibrato = m.VibratoType.Slight;

  if (Array.isArray(b.tremolo) && b.tremolo[1]) {
    const speed = durationFromDenominator(m, b.tremolo[1]);
    if (speed) beat.tremoloSpeed = speed;
  }

  const chordName = textOf(b.chord);
  if (chordName && !ctx.drumKit) {
    const id = `songsterr-${chordName}`;
    if (!staff.hasChord(id)) {
      const chord = new m.Chord();
      chord.name = chordName;
      chord.showDiagram = false;
      chord.showFingering = false;
      staff.addChord(id, chord);
    }
    beat.chordId = id;
  }

  if (!b.rest) {
    for (const n of b.notes || []) {
      if (n.rest || typeof n.fret !== 'number') continue;
      const note = ctx.drumKit ? buildDrumNote(m, n, ctx.drumKit) : buildNote(m, n, b, ctx);
      if (note) beat.addNote(note);
    }
  }
  return beat;
}

function buildNote(m, n, b, ctx) {
  const string = ctx.numStrings - Math.round(n.string ?? 0);
  if (string < 1 || string > ctx.numStrings) {
    ctx.warnings.push(`${ctx.loc}: skipped a note on missing string ${n.string}`);
    return null;
  }
  const note = new m.Note();
  note.string = string;
  note.fret = n.fret;

  if (n.tie) note.isTieDestination = true;
  if (n.dead) note.isDead = true;
  if (n.ghost) note.isGhost = true;
  if (n.staccato) note.isStaccato = true;
  if (n.heavyAccentuated) note.accentuated = m.AccentuationType.Heavy;
  else if (n.accentuated) note.accentuated = m.AccentuationType.Normal;
  if (n.hp) note.isHammerPullOrigin = true;
  if (b.palmMute) note.isPalmMute = true;
  if (b.letRing || n.letRing) note.isLetRing = true;

  if (n.wideVibrato) note.vibrato = m.VibratoType.Wide;
  else if (n.vibrato) note.vibrato = m.VibratoType.Slight;

  switch (n.slide) {
    case 'shift': note.slideOutType = m.SlideOutType.Shift; break;
    case 'legato': note.slideOutType = m.SlideOutType.Legato; break;
    case 'below': note.slideInType = m.SlideInType.IntoFromBelow; break;
    case 'above': note.slideInType = m.SlideInType.IntoFromAbove; break;
    case 'downwards': note.slideOutType = m.SlideOutType.OutDown; break;
    case 'upwards': note.slideOutType = m.SlideOutType.OutUp; break;
  }

  if (typeof n.harmonic === 'string' && HARMONICS[n.harmonic]) {
    note.harmonicType = m.HarmonicType[HARMONICS[n.harmonic]];
    note.harmonicValue = typeof n.harmonicFret === 'number' ? n.harmonicFret : n.fret;
  }

  if (n.bend && Array.isArray(n.bend.points) && n.bend.points.length > 0) {
    note.bendType = m.BendType.Custom;
    for (const p of n.bend.points) {
      // Songsterr: tone 100 = one whole step. alphaTab: value in quarter tones.
      const offset = clamp(Math.round(p.position ?? 0), 0, 60);
      const value = Math.round((p.tone ?? 0) / 25);
      note.addBendPoint(new m.BendPoint(offset, value));
    }
  }
  return note;
}

class DrumKit {
  constructor(m, track) {
    this.m = m;
    this.track = track;
    this.byMidi = new Map();
  }

  articulationFor(midi, position) {
    const key = `${midi}:${position}`;
    if (this.byMidi.has(key)) return this.byMidi.get(key);
    const m = this.m;
    const S = m.MusicFontSymbol;
    const cymbal = CYMBAL_NOTES.has(midi);
    const open = midi === 46;
    const heads = open
      ? [S.NoteheadCircleX, S.NoteheadCircleX, S.NoteheadCircleX]
      : cymbal
        ? [S.NoteheadXBlack, S.NoteheadXHalf, S.NoteheadXWhole]
        : [S.NoteheadBlack, S.NoteheadHalf, S.NoteheadWhole];
    // alphaTab counts staff steps from the top line, Songsterr counts lines.
    const staffLine = Math.round(position * 2);
    const articulation = new m.InstrumentArticulation(
      DRUM_NAMES[midi] || `Drum ${midi}`,
      staffLine,
      midi,
      heads[0],
      heads[1],
      heads[2]
    );
    this.track.percussionArticulations.push(articulation);
    const index = this.track.percussionArticulations.length - 1;
    this.byMidi.set(key, index);
    return index;
  }
}

function buildDrumNote(m, n, kit) {
  const midi = n.fret;
  const position = typeof n.string === 'number' ? n.string : DEFAULT_DRUM_POSITIONS[midi] ?? 1.5;
  const note = new m.Note();
  note.percussionArticulation = kit.articulationFor(midi, position);
  if (n.ghost) note.isGhost = true;
  if (n.accentuated) note.accentuated = m.AccentuationType.Normal;
  if (n.tie) note.isTieDestination = true;
  return note;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

function durationFromDenominator(m, den) {
  const map = { 1: 'Whole', 2: 'Half', 4: 'Quarter', 8: 'Eighth', 16: 'Sixteenth', 32: 'ThirtySecond', 64: 'SixtyFourth', 128: 'OneHundredTwentyEighth' };
  return map[den] ? m.Duration[map[den]] : null;
}

/**
 * Sets beat.duration, dots and tuplet from a Songsterr beat. Exported for tests.
 */
export function applyDuration(m, beat, b) {
  const actual = Array.isArray(b.duration) && b.duration[1] ? b.duration[0] / b.duration[1] : null;
  let type = typeof b.type === 'number' ? b.type : null;
  let dots = typeof b.dots === 'number' ? b.dots : 0;

  if (!type && actual) {
    const guess = guessTypeAndDots(actual);
    type = guess.type;
    dots = guess.dots;
  }
  if (!type) type = 4;

  beat.duration = durationFromDenominator(m, type) ?? m.Duration.Quarter;
  beat.dots = clamp(dots, 0, 2);

  const tuplet = typeof b.tuplet === 'number' && b.tuplet > 1 ? b.tuplet : 0;
  if (tuplet) {
    const written = (1 / type) * (2 - 1 / 2 ** beat.dots);
    let denominator = actual ? (tuplet * actual) / written : NaN;
    if (!Number.isFinite(denominator) || Math.abs(denominator - Math.round(denominator)) > 1e-6 || denominator < 1) {
      denominator = STANDARD_TUPLET_DENOMINATORS[tuplet] ?? Math.max(1, tuplet - 1);
    }
    beat.tupletNumerator = tuplet;
    beat.tupletDenominator = Math.round(denominator);
  }
}

function guessTypeAndDots(actual) {
  for (const type of [1, 2, 4, 8, 16, 32, 64, 128]) {
    for (const dots of [0, 1, 2]) {
      const value = (1 / type) * (2 - 1 / 2 ** dots);
      if (Math.abs(value - actual) < 1e-9) return { type, dots };
    }
  }
  // Tuplet or unusual value: choose the nearest larger plain value.
  for (const type of [1, 2, 4, 8, 16, 32, 64, 128]) {
    if (1 / type <= actual * 1.5) return { type, dots: 0 };
  }
  return { type: 128, dots: 0 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
