// Score editing operations.
//
// Every operation mutates an alphaTab Score in place and returns the selection
// to use afterwards. The caller then rebuilds the score (rebuildScore) so all
// derived data (timing, ties, hammer-on targets, beaming) is recalculated, and
// re-renders. Snapshots for undo use alphaTab's own JSON form.
//
// A selection points at one beat and one string:
//   { track, staff, bar, voice, beat, string }
// `string` uses alphaTab numbering: 1 is the lowest-pitched string.

import { shortTrackName } from './convert.js';

export const DURATIONS = [1, 2, 4, 8, 16, 32, 64];

export const NOTE_EFFECTS = {
  palmMute: 'Palm mute',
  letRing: 'Let ring',
  hammer: 'Hammer-on / pull-off',
  slide: 'Slide',
  vibrato: 'Vibrato',
  bend: 'Bend (full)',
  harmonic: 'Harmonic',
  ghost: 'Ghost note',
  dead: 'Dead note',
  accent: 'Accent',
  staccato: 'Staccato'
};

// ---------------------------------------------------------------------------
// Snapshots and rebuilding
// ---------------------------------------------------------------------------

export function snapshot(alphaTab, score) {
  return alphaTab.model.JsonConverter.scoreToJsObject(score);
}

export function restore(alphaTab, snap, settings) {
  return alphaTab.model.JsonConverter.jsObjectToScore(snap, settings);
}

/** Recomputes everything derived from the raw data (after an edit). */
export function rebuildScore(alphaTab, score, settings) {
  repairLinks(score);
  return restore(alphaTab, snapshot(alphaTab, score), settings);
}

// Links between notes, as [origin field, destination field]. The JSON form
// stores them as note ids and alphaTab resolves each destination's origin id
// while it walks the score in order, so an origin that is gone (or comes
// later) makes restoring throw.
const LINKS = [
  ['tieOrigin', 'tieDestination'],
  ['hammerPullOrigin', 'hammerPullDestination'],
  ['slurOrigin', 'slurDestination'],
  ['slideOrigin', 'slideTarget']
];
const TIE_SEARCH_BARS = 3; // how far back alphaTab looks for a tie's origin

/**
 * Makes the links between notes consistent after an edit removed or moved
 * some of them: links to notes no longer in the score are dropped (a note
 * whose tie origin is gone is no longer tied), and new tie destinations get
 * their origin (the previous note on the same string), as alphaTab would.
 */
export function repairLinks(score) {
  const order = new Map();
  const staves = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const notes = [];
      staff.bars.forEach((bar, b) => {
        bar.voices.forEach((voice, v) => {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              order.set(note, order.size);
              notes.push({ note, bar: b, voice: v });
            }
          }
        });
      });
      staves.push({ staff, notes });
    }
  }
  const before = (a, b) => order.has(a) && order.get(a) < order.get(b);

  // A hammer-on or slide that was switched off no longer joins the next note.
  const switchedOff = (originKey, origin) =>
    (originKey === 'hammerPullOrigin' && !origin.isHammerPullOrigin) || (originKey === 'slideOrigin' && !origin.slideOutType);
  for (const note of order.keys()) {
    for (const [originKey, destKey] of LINKS) {
      const origin = note[originKey];
      if (origin && switchedOff(originKey, origin)) {
        origin[destKey] = null;
        note[originKey] = null;
        continue;
      }
      if (origin && !before(origin, note)) {
        note[originKey] = null;
        if (originKey === 'tieOrigin') note.isTieDestination = false;
      }
      const dest = note[destKey];
      if (dest && (!before(note, dest) || (dest[originKey] && dest[originKey] !== note))) note[destKey] = null;
    }
    if (note.isSlurDestination && !note.slurOrigin) note.isSlurDestination = false;
  }
  // Every origin points back at its destination, so alphaTab can find it.
  for (const note of order.keys()) {
    for (const [originKey, destKey] of LINKS) {
      const origin = note[originKey];
      if (origin && !origin[destKey]) origin[destKey] = note;
    }
  }

  for (const { staff, notes } of staves) {
    const stringed = isStringed(staff);
    const last = new Map(); // `${voice}:${string}` -> { note, bar }
    for (const item of notes) {
      const { note } = item;
      if (note.isTieDestination && !note.tieOrigin) {
        const prev = stringed ? last.get(`${item.voice}:${note.string}`) : null;
        if (prev && prev.bar >= item.bar - TIE_SEARCH_BARS) {
          note.tieOrigin = prev.note;
          prev.note.tieDestination = note;
          note.fret = prev.note.fret;
        } else if (stringed) {
          note.isTieDestination = false;
        }
      }
      if (stringed) last.set(`${item.voice}:${note.string}`, item);
    }
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function staffOf(score, sel) {
  return score.tracks[sel.track]?.staves[sel.staff ?? 0] ?? null;
}

export function voiceOf(score, sel) {
  return staffOf(score, sel)?.bars[sel.bar]?.voices[sel.voice ?? 0] ?? null;
}

export function beatOf(score, sel) {
  return voiceOf(score, sel)?.beats[sel.beat] ?? null;
}

export function isStringed(staff) {
  return !!staff && !staff.isPercussion && staff.tuning.length > 0;
}

export function noteOnString(beat, string) {
  return beat?.notes.find((n) => n.string === string) ?? null;
}

/** Selection for a beat object (from a click), keeping a sensible string. */
export function selectionForBeat(beat, string = null) {
  const voice = beat.voice;
  const bar = voice.bar;
  const staff = bar.staff;
  let s = string;
  if (s == null || !beat.notes.some((n) => n.string === s)) {
    s = beat.notes.length ? beat.notes[beat.notes.length - 1].string : s ?? staff.tuning.length ?? 1;
  }
  return { track: staff.track.index, staff: staff.index, bar: bar.index, voice: voice.index, beat: beat.index, string: s || 1 };
}

/** Keeps a selection pointing at something that exists. */
export function clampSelection(score, sel) {
  const track = Math.min(Math.max(0, sel.track), score.tracks.length - 1);
  const staffObj = score.tracks[track].staves[Math.min(sel.staff ?? 0, score.tracks[track].staves.length - 1)];
  const bar = Math.min(Math.max(0, sel.bar), staffObj.bars.length - 1);
  const voices = staffObj.bars[bar].voices;
  const voice = Math.min(sel.voice ?? 0, voices.length - 1);
  const beat = Math.min(Math.max(0, sel.beat), voices[voice].beats.length - 1);
  const strings = staffObj.tuning.length || 1;
  const string = Math.min(Math.max(1, sel.string || 1), strings);
  return { track, staff: staffObj.index, bar, voice, beat, string };
}

/** Next or previous beat, crossing bar lines. */
export function stepBeat(score, sel, direction) {
  const staff = staffOf(score, sel);
  let { bar, beat } = sel;
  const voiceIndex = sel.voice ?? 0;
  beat += direction;
  while (bar >= 0 && bar < staff.bars.length) {
    const voice = staff.bars[bar].voices[voiceIndex] ?? staff.bars[bar].voices[0];
    if (beat >= 0 && beat < voice.beats.length) return { ...sel, bar, beat, voice: voice.index };
    bar += direction;
    if (bar < 0 || bar >= staff.bars.length) break;
    const next = staff.bars[bar].voices[voiceIndex] ?? staff.bars[bar].voices[0];
    beat = direction > 0 ? 0 : next.beats.length - 1;
  }
  return sel;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function clearRest(beat) {
  beat.isEmpty = false;
}

export function setFret(m, score, sel, fret) {
  const staff = staffOf(score, sel);
  const beat = beatOf(score, sel);
  if (!isStringed(staff) || !beat) return sel;
  const value = Math.max(0, Math.min(36, Math.round(fret)));
  let note = noteOnString(beat, sel.string);
  if (!note) {
    note = new m.Note();
    note.string = sel.string;
    beat.addNote(note);
    clearRest(beat);
  }
  note.fret = value;
  note.isDead = false;
  return sel;
}

export function deleteNote(m, score, sel) {
  const beat = beatOf(score, sel);
  if (!beat) return sel;
  const staff = staffOf(score, sel);
  const note = isStringed(staff) ? noteOnString(beat, sel.string) : beat.notes[beat.notes.length - 1];
  if (note) beat.removeNote(note);
  return sel;
}

export function makeRest(m, score, sel) {
  const beat = beatOf(score, sel);
  if (!beat) return sel;
  while (beat.notes.length) beat.removeNote(beat.notes[0]);
  return sel;
}

/** Toggles a technique on the selected note (or the whole beat for beat-level ones). */
export function toggleEffect(m, score, sel, effect) {
  const beat = beatOf(score, sel);
  if (!beat) return sel;
  const staff = staffOf(score, sel);
  const targets = isStringed(staff) ? [noteOnString(beat, sel.string)].filter(Boolean) : beat.notes;
  if (targets.length === 0) return sel;
  const on = !effectState(m, score, sel, effect);
  for (const note of targets) {
    switch (effect) {
      case 'palmMute': note.isPalmMute = on; break;
      case 'letRing': note.isLetRing = on; break;
      case 'hammer': note.isHammerPullOrigin = on; break;
      case 'slide': note.slideOutType = on ? m.SlideOutType.Shift : m.SlideOutType.None; break;
      case 'vibrato': note.vibrato = on ? m.VibratoType.Slight : m.VibratoType.None; break;
      case 'ghost': note.isGhost = on; break;
      case 'dead': note.isDead = on; break;
      case 'accent': note.accentuated = on ? m.AccentuationType.Normal : m.AccentuationType.None; break;
      case 'staccato': note.isStaccato = on; break;
      case 'harmonic':
        note.harmonicType = on ? m.HarmonicType.Natural : m.HarmonicType.None;
        note.harmonicValue = on ? note.fret : 0;
        break;
      case 'bend':
        note.bendPoints = null;
        note.maxBendPoint = null;
        note.bendType = m.BendType.None;
        if (on) {
          note.bendType = m.BendType.Custom;
          note.addBendPoint(new m.BendPoint(0, 0));
          note.addBendPoint(new m.BendPoint(15, 4));
          note.addBendPoint(new m.BendPoint(60, 4));
        }
        break;
    }
  }
  return sel;
}

export function effectState(m, score, sel, effect) {
  const beat = beatOf(score, sel);
  const staff = staffOf(score, sel);
  const note = isStringed(staff) ? noteOnString(beat, sel.string) : beat?.notes[0];
  if (!note) return false;
  switch (effect) {
    case 'palmMute': return note.isPalmMute;
    case 'letRing': return note.isLetRing;
    case 'hammer': return note.isHammerPullOrigin;
    case 'slide': return note.slideOutType !== m.SlideOutType.None;
    case 'vibrato': return note.vibrato !== m.VibratoType.None;
    case 'ghost': return note.isGhost;
    case 'dead': return note.isDead;
    case 'accent': return note.accentuated !== m.AccentuationType.None;
    case 'staccato': return note.isStaccato;
    case 'harmonic': return note.harmonicType !== m.HarmonicType.None;
    case 'bend': return !!(note.bendPoints && note.bendPoints.length);
    default: return false;
  }
}

/** Moves every fretted note in the given bars of a track by `semitones`, on the same string. */
export function transposeBars(m, score, trackIndex, fromBar, toBar, semitones) {
  let skipped = 0;
  for (const staff of score.tracks[trackIndex].staves) {
    if (!isStringed(staff)) continue;
    for (let b = fromBar; b <= toBar && b < staff.bars.length; b++) {
      for (const voice of staff.bars[b].voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            const fret = note.fret + semitones;
            if (fret < 0 || fret > 36) skipped++;
            else note.fret = fret;
          }
        }
      }
    }
  }
  return skipped;
}

// ---------------------------------------------------------------------------
// Rhythm and beats
// ---------------------------------------------------------------------------

export function setDuration(m, score, sel, value) {
  const beat = beatOf(score, sel);
  if (beat && DURATIONS.includes(value)) beat.duration = value;
  return sel;
}

/** Shorter (direction 1) or longer (-1) by one step. */
export function stepDuration(m, score, sel, direction) {
  const beat = beatOf(score, sel);
  if (!beat) return sel;
  const i = DURATIONS.indexOf(beat.duration);
  const next = DURATIONS[Math.min(DURATIONS.length - 1, Math.max(0, (i < 0 ? 2 : i) + direction))];
  beat.duration = next;
  return sel;
}

export function toggleDot(m, score, sel) {
  const beat = beatOf(score, sel);
  if (beat) beat.dots = beat.dots ? 0 : 1;
  return sel;
}

export function toggleTriplet(m, score, sel) {
  const beat = beatOf(score, sel);
  if (!beat) return sel;
  if (beat.tupletNumerator === 3) {
    beat.tupletNumerator = -1;
    beat.tupletDenominator = -1;
  } else {
    beat.tupletNumerator = 3;
    beat.tupletDenominator = 2;
  }
  return sel;
}

export function setBeatText(m, score, sel, text) {
  const beat = beatOf(score, sel);
  if (beat) beat.text = text ? String(text) : null;
  return sel;
}

/** Copies the editable parts of a beat (notes, rhythm, techniques). */
function copyPrimitives(from, to, skip) {
  for (const key of Object.keys(from)) {
    if (skip.has(key)) continue;
    const value = from[key];
    if (value === null || ['number', 'boolean', 'string'].includes(typeof value)) to[key] = value;
  }
}

const SKIP = new Set(['id', 'index']);

export function cloneBeat(m, beat) {
  const copy = new m.Beat();
  copyPrimitives(beat, copy, SKIP);
  for (const note of beat.notes) {
    const n = new m.Note();
    copyPrimitives(note, n, SKIP);
    if (note.bendPoints) for (const p of note.bendPoints) n.addBendPoint(new m.BendPoint(p.offset, p.value));
    copy.addNote(n);
  }
  if (beat.whammyBarPoints) for (const p of beat.whammyBarPoints) copy.addWhammyBarPoint(new m.BendPoint(p.offset, p.value));
  return copy;
}

/** Inserts a rest after the selected beat with the same length. */
export function insertBeat(m, score, sel) {
  const voice = voiceOf(score, sel);
  const beat = beatOf(score, sel);
  if (!voice || !beat) return sel;
  const fresh = new m.Beat();
  fresh.duration = beat.duration;
  fresh.dots = beat.dots;
  voice.beats.splice(sel.beat + 1, 0, fresh);
  fresh.voice = voice;
  return { ...sel, beat: sel.beat + 1 };
}

export function deleteBeat(m, score, sel) {
  const voice = voiceOf(score, sel);
  if (!voice || !voice.beats[sel.beat]) return sel;
  voice.beats.splice(sel.beat, 1);
  if (voice.beats.length === 0) {
    const rest = new m.Beat();
    rest.duration = m.Duration.Whole;
    voice.beats.push(rest);
    rest.voice = voice;
  }
  return { ...sel, beat: Math.min(sel.beat, voice.beats.length - 1) };
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

function emptyBarLike(m, template) {
  const bar = new m.Bar();
  bar.clef = template.clef;
  bar.clefOttava = template.clefOttava;
  bar.keySignature = template.keySignature;
  bar.keySignatureType = template.keySignatureType;
  const voice = new m.Voice();
  const rest = new m.Beat();
  rest.duration = m.Duration.Whole;
  voice.addBeat(rest);
  bar.addVoice(voice);
  return bar;
}

/** Inserts an empty bar at `index` (pushing the rest right). */
export function insertBar(m, score, index) {
  const at = Math.max(0, Math.min(index, score.masterBars.length));
  const like = score.masterBars[Math.min(at, score.masterBars.length - 1)];
  const mb = new m.MasterBar();
  mb.timeSignatureNumerator = like.timeSignatureNumerator;
  mb.timeSignatureDenominator = like.timeSignatureDenominator;
  if (at === 0) {
    // The starting tempo belongs to the new first bar.
    mb.tempoAutomations = like.tempoAutomations.filter((a) => a.ratioPosition === 0);
    like.tempoAutomations = like.tempoAutomations.filter((a) => a.ratioPosition !== 0);
  }
  score.masterBars.splice(at, 0, mb);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      staff.bars.splice(at, 0, emptyBarLike(m, staff.bars[Math.min(at, staff.bars.length - 1)]));
    }
  }
  return at;
}

/** Copies bar `index` (all tracks) right after itself. */
export function duplicateBar(m, score, index) {
  const source = score.masterBars[index];
  const mb = new m.MasterBar();
  mb.timeSignatureNumerator = source.timeSignatureNumerator;
  mb.timeSignatureDenominator = source.timeSignatureDenominator;
  mb.tripletFeel = source.tripletFeel;
  score.masterBars.splice(index + 1, 0, mb);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const from = staff.bars[index];
      const bar = new m.Bar();
      bar.clef = from.clef;
      bar.clefOttava = from.clefOttava;
      bar.keySignature = from.keySignature;
      bar.keySignatureType = from.keySignatureType;
      const copies = new Map(); // source note -> its copy
      for (const v of from.voices) {
        const voice = new m.Voice();
        for (const beat of v.beats) {
          const copy = cloneBeat(m, beat);
          beat.notes.forEach((n, i) => copies.set(n, copy.notes[i]));
          voice.addBeat(copy);
        }
        bar.addVoice(voice);
      }
      staff.bars.splice(index + 1, 0, bar);
      relinkCopies(copies, staff.bars[index + 2]);
    }
  }
  return index + 1;
}

/**
 * Links inside a copied bar join the copies, and notes of the following bar
 * that continued the source bar (a tie, hammer-on, slide or slur) now continue
 * the copy instead. Ties from before the source bar are found on rebuild.
 */
function relinkCopies(copies, nextBar) {
  for (const [source, copy] of copies) {
    for (const [originKey, destKey] of LINKS) {
      const origin = copies.get(source[originKey]);
      if (origin) {
        copy[originKey] = origin;
        origin[destKey] = copy;
      }
    }
  }
  if (!nextBar) return;
  for (const voice of nextBar.voices) {
    for (const beat of voice.beats) {
      for (const note of beat.notes) {
        for (const [originKey, destKey] of LINKS) {
          const origin = copies.get(note[originKey]);
          if (!origin) continue;
          note[originKey][destKey] = null;
          note[originKey] = origin;
          origin[destKey] = note;
        }
      }
    }
  }
}

/** Removes bar `index` from every track, keeping tempo and repeat marks. */
export function deleteBar(m, score, index) {
  if (score.masterBars.length <= 1) return index;
  const removed = score.masterBars[index];
  const next = score.masterBars[index + 1];
  if (next) {
    // The next bar starts at the tempo the removed one ended with.
    const carried = lastTempoAutomation(removed);
    if (carried && !next.tempoAutomations.some((a) => a.ratioPosition === 0)) {
      carried.ratioPosition = 0;
      next.tempoAutomations = [carried, ...next.tempoAutomations];
    }
    if (removed.isRepeatStart && !removed.isRepeatEnd) next.isRepeatStart = true;
    if (removed.section && !next.section) next.section = removed.section;
  }
  // The repeat sign at the end moves back to the bar before (a repeat of just
  // this bar goes with it). Alternate endings stay with their bars: removing
  // the last bar of an ending makes it shorter, the bar before keeps its own.
  const prev = score.masterBars[index - 1];
  if (prev && removed.isRepeatEnd && !removed.isRepeatStart && !prev.isRepeatEnd) prev.repeatCount = removed.repeatCount;
  score.masterBars.splice(index, 1);
  for (const track of score.tracks) for (const staff of track.staves) staff.bars.splice(index, 1);
  return Math.min(index, score.masterBars.length - 1);
}

/** Copies one track's bar (all voices) for pasting elsewhere. */
export function copyBar(m, score, trackIndex, barIndex, staffIndex = 0) {
  const staff = score.tracks[trackIndex]?.staves[staffIndex];
  const bar = staff?.bars[barIndex];
  if (!bar) return null;
  return {
    strings: staff.tuning.length,
    tuning: staff.tuning.slice(),
    percussion: staff.isPercussion,
    voices: bar.voices.map((v) => v.beats.map((beat) => cloneBeat(m, beat)))
  };
}

const PASTE_MAX_FRET = 24;

/**
 * Puts a beat's copied notes on the target strings, keeping their pitches.
 * A note stays on the same string counted from the top when that string has
 * the same pitch (e.g. a 6-string part on a 7-string guitar). The others go
 * where as many as possible fit, each with its fret close to where it was.
 * Returns the notes that fit nowhere.
 */
function placeByPitch(beat, from, to) {
  const pitchOf = (tuning, string) => tuning[tuning.length - string];
  const used = new Set();
  const wanted = [];
  for (const note of beat.notes) {
    const pitch = pitchOf(from, note.string) + note.fret;
    const same = note.string - from.length + to.length;
    if (same >= 1 && pitch - pitchOf(to, same) === note.fret && !used.has(same)) {
      used.add(same);
      note.string = same;
    } else {
      const choices = [];
      for (let s = 1; s <= to.length; s++) {
        const fret = pitch - pitchOf(to, s);
        if (fret >= 0 && fret <= PASTE_MAX_FRET) choices.push({ s, fret, cost: Math.abs(fret - note.fret) * 10 + Math.abs(s - same) });
      }
      wanted.push({ note, choices: choices.sort((a, c) => a.cost - c.cost) });
    }
  }
  // Fewest choices first; a beat has only a few notes, so trying them all is cheap.
  wanted.sort((a, c) => a.choices.length - c.choices.length);
  let best = { placed: -1, cost: Infinity, picks: [] };
  const search = (i, picks, placed, cost) => {
    const most = placed + wanted.length - i;
    if (most < best.placed || (most === best.placed && cost >= best.cost)) return;
    if (i === wanted.length) {
      best = { placed, cost, picks: [...picks] };
      return;
    }
    for (const choice of wanted[i].choices) {
      if (used.has(choice.s)) continue;
      used.add(choice.s);
      picks.push(choice);
      search(i + 1, picks, placed + 1, cost + choice.cost);
      picks.pop();
      used.delete(choice.s);
    }
    picks.push(null); // leave this note out
    search(i + 1, picks, placed, cost);
    picks.pop();
  };
  search(0, [], 0, 0);
  const unplaced = [];
  wanted.forEach(({ note }, i) => {
    const choice = best.picks[i];
    if (!choice) unplaced.push(note);
    else {
      note.string = choice.s;
      note.fret = choice.fret;
    }
  });
  return unplaced;
}

/**
 * Replaces a bar's notes with a copied bar. Notes keep their pitch: when the
 * target is tuned differently they move to other strings, and notes that fit
 * on no free string are skipped; the count of skipped notes is returned.
 */
export function pasteBar(m, score, trackIndex, barIndex, clip, staffIndex = 0) {
  const staff = score.tracks[trackIndex]?.staves[staffIndex];
  const bar = staff?.bars[barIndex];
  if (!bar || !clip) return 0;
  let skipped = 0;
  const kindMatches = staff.isPercussion === clip.percussion;
  const retune = kindMatches && !staff.isPercussion && clip.tuning?.length > 0 && clip.tuning.join() !== staff.tuning.join();
  bar.voices.splice(0, bar.voices.length);
  for (const beats of clip.voices) {
    const voice = new m.Voice();
    for (const source of beats) {
      const beat = cloneBeat(m, source);
      const drop = !kindMatches
        ? [...beat.notes]
        : retune
          ? placeByPitch(beat, clip.tuning, staff.tuning)
          : beat.notes.filter((n) => !staff.isPercussion && n.string > staff.tuning.length);
      for (const note of drop) {
        beat.removeNote(note);
        skipped++;
      }
      voice.addBeat(beat);
    }
    if (voice.beats.length === 0) {
      const rest = new m.Beat();
      rest.duration = m.Duration.Whole;
      voice.addBeat(rest);
    }
    bar.addVoice(voice);
  }
  return skipped;
}

export function setSection(m, score, index, text) {
  const mb = score.masterBars[index];
  if (!mb) return;
  const value = String(text || '').trim();
  if (!value) {
    mb.section = null;
    return;
  }
  const section = new m.Section();
  section.text = value;
  mb.section = section;
}

/** Tempo at the start of bar `index`: its own mark there, or the last change before it. */
export function tempoAt(score, index) {
  const atStart = score.masterBars[index]?.tempoAutomations?.find((a) => a.ratioPosition === 0);
  if (atStart) return atStart.value;
  for (let i = index - 1; i >= 0; i--) {
    const a = lastTempoAutomation(score.masterBars[i]);
    if (a) return a.value;
  }
  return 120;
}

/** The tempo change that is still in effect at the end of a bar, if it has any. */
function lastTempoAutomation(masterBar) {
  let last = null;
  for (const a of masterBar?.tempoAutomations ?? []) if (!last || a.ratioPosition >= last.ratioPosition) last = a;
  return last;
}

export function setTempo(m, score, index, bpm) {
  const mb = score.masterBars[index];
  const value = Math.round(Number(bpm));
  if (!mb || !Number.isFinite(value) || value < 20 || value > 400) return false;
  // Changing tempo at the first bar or matching the previous value removes the mark.
  mb.tempoAutomations = [m.Automation.buildTempoAutomation(false, 0, value, 2)];
  return true;
}

export function setTimeSignature(m, score, index, numerator, denominator) {
  const mb = score.masterBars[index];
  const num = Math.round(Number(numerator));
  const den = Math.round(Number(denominator));
  if (!mb || !(num >= 1 && num <= 32) || ![1, 2, 4, 8, 16, 32].includes(den)) return false;
  mb.timeSignatureNumerator = num;
  mb.timeSignatureDenominator = den;
  return true;
}

export function toggleRepeatStart(m, score, index) {
  const mb = score.masterBars[index];
  if (mb) mb.isRepeatStart = !mb.isRepeatStart;
}

export function setRepeatEnd(m, score, index, count) {
  const mb = score.masterBars[index];
  if (mb) mb.repeatCount = count > 1 ? Math.min(16, Math.round(count)) : 0;
}

// ---------------------------------------------------------------------------
// Song and tracks
// ---------------------------------------------------------------------------

export function setSongInfo(score, { title, artist }) {
  if (title !== undefined) score.title = String(title);
  if (artist !== undefined) score.artist = String(artist);
}

export function renameTrack(score, trackIndex, name) {
  const track = score.tracks[trackIndex];
  if (!track) return;
  track.name = String(name).trim() || track.name;
  track.shortName = shortTrackName(track.name);
}
