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
  return restore(alphaTab, snapshot(alphaTab, score), settings);
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
      for (const v of from.voices) {
        const voice = new m.Voice();
        for (const beat of v.beats) voice.addBeat(cloneBeat(m, beat));
        bar.addVoice(voice);
      }
      staff.bars.splice(index + 1, 0, bar);
    }
  }
  return index + 1;
}

/** Removes bar `index` from every track, keeping tempo and repeat marks. */
export function deleteBar(m, score, index) {
  if (score.masterBars.length <= 1) return index;
  const removed = score.masterBars[index];
  const next = score.masterBars[index + 1];
  if (next) {
    if (removed.tempoAutomations.length && !next.tempoAutomations.length) {
      next.tempoAutomations = removed.tempoAutomations.map((a) => {
        a.ratioPosition = 0;
        return a;
      });
    }
    if (removed.isRepeatStart && !removed.isRepeatEnd) next.isRepeatStart = true;
    if (removed.section && !next.section) next.section = removed.section;
  }
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
    percussion: staff.isPercussion,
    voices: bar.voices.map((v) => v.beats.map((beat) => cloneBeat(m, beat)))
  };
}

/**
 * Replaces a bar's notes with a copied bar. Notes on strings the target
 * doesn't have are skipped; the count of skipped notes is returned.
 */
export function pasteBar(m, score, trackIndex, barIndex, clip, staffIndex = 0) {
  const staff = score.tracks[trackIndex]?.staves[staffIndex];
  const bar = staff?.bars[barIndex];
  if (!bar || !clip) return 0;
  let skipped = 0;
  bar.voices.splice(0, bar.voices.length);
  for (const beats of clip.voices) {
    const voice = new m.Voice();
    for (const source of beats) {
      const beat = cloneBeat(m, source);
      for (const note of [...beat.notes]) {
        const fits = staff.isPercussion === clip.percussion && (staff.isPercussion || note.string <= staff.tuning.length);
        if (!fits) {
          beat.removeNote(note);
          skipped++;
        }
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

export function tempoAt(score, index) {
  for (let i = index; i >= 0; i--) {
    const a = score.masterBars[i]?.tempoAutomations?.[0];
    if (a) return a.value;
  }
  return 120;
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
