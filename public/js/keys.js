// Key signatures and how black-key notes are spelled (B♭ or A♯).
//
// Songsterr tabs carry no key, so a song's key is found from its notes when
// it opens; the person can pick another in the Notation panel. Each part gets
// the key it reads (a B♭ trumpet in concert E♭ reads F). Notes outside the
// key are spelled with flats, sharps, or as the key suggests.

import { keyFromChroma } from './analysis.js';
import { writtenKey } from './instruments.js';

const MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MAJOR_FLAT = ['C', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭'];
const MINOR = ['A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
const MINOR_FLAT = ['A', 'D', 'G', 'C', 'F', 'B♭', 'E♭', 'A♭'];

/** "E♭ major / C minor (3 flats)" for a key signature (sharps, or minus for flats). */
export function keyLabel(fifths) {
  const n = Math.abs(fifths);
  const major = fifths < 0 ? MAJOR_FLAT[n] : MAJOR[n];
  const minor = fifths < 0 ? MINOR_FLAT[n] : MINOR[n];
  const count = n === 0 ? 'no sharps or flats' : `${n} ${fifths < 0 ? 'flat' : 'sharp'}${n === 1 ? '' : 's'}`;
  return `${major} major / ${minor} minor (${count})`;
}

/** The keys to choose from: flat keys first, then sharp keys. */
export const KEY_CHOICES = [0, -1, -2, -3, -4, -5, -6, 1, 2, 3, 4, 5, 6];

const pitchedStaves = (score) => score.tracks.flatMap((t) => t.staves).filter((s) => !s.isPercussion);
const pitchOf = (note) => note.realValueWithoutHarmonic ?? note.realValue;
const mod12 = (n) => ((n % 12) + 12) % 12;

/** Whether any part of the score already has a key signature other than C. */
export function scoreHasKey(score) {
  return pitchedStaves(score).some((staff) => staff.bars.some((bar) => bar.keySignature !== 0));
}

/** The concert key the score is written in (from its first pitched part), in sharps or minus flats. */
export function concertKey(score) {
  const staff = pitchedStaves(score)[0];
  if (!staff || !staff.bars.length) return 0;
  // A part written N semitones high reads a key N semitones higher; undo that.
  return writtenKey(staff.bars[0].keySignature, staff.displayTranspositionPitch || 0);
}

/**
 * Finds the key from the notes: how long each pitch class sounds, across
 * every pitched part. Returns keyFromChroma's result, or null with no notes.
 */
export function detectScoreKey(score) {
  const total = new Float64Array(12);
  let any = false;
  for (const staff of pitchedStaves(score)) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          const length = beat.playbackDuration || 960;
          for (const note of beat.notes) {
            if (note.isDead || note.isTieDestination) continue;
            const pitch = pitchOf(note);
            if (!(pitch > 0)) continue;
            total[mod12(pitch)] += length;
            any = true;
          }
        }
      }
    }
  }
  return any ? keyFromChroma(total) : null;
}

/** Sets the key on every bar of every pitched part, written for each part's transposition. */
export function setScoreKey(m, score, fifths, minor = false) {
  for (const staff of pitchedStaves(score)) {
    const key = writtenKey(fifths, -(staff.displayTranspositionPitch || 0));
    for (const bar of staff.bars) {
      bar.keySignature = key;
      bar.keySignatureType = minor ? m.KeySignatureType.Minor : m.KeySignatureType.Major;
    }
  }
}

function scaleOf(fifths) {
  const tonic = mod12(fifths * 7);
  return new Set([0, 2, 4, 5, 7, 9, 11].map((step) => mod12(tonic + step)));
}

const BLACK = new Set([1, 3, 6, 8, 10]);
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Whether a black key in this key should be a flat: the key's own spelling, else the preference. */
function useFlat(pc, fifths, preference) {
  if (scaleOf(fifths).has(pc)) return fifths < 0 || (fifths === 0 && preference !== 'sharps');
  if (preference === 'flats') return true;
  if (preference === 'sharps') return false;
  return fifths <= 0;
}

/** Respells a chord name's root and bass ("A#m7/C#" -> "Bbm7/Db"). */
export function spellChordName(name, fifths, preference) {
  const respell = (letter, accidental) => {
    let pc = LETTER[letter];
    if (/[#♯]/.test(accidental)) pc += 1;
    else if (/[b♭]/.test(accidental)) pc -= 1;
    pc = mod12(pc);
    if (!BLACK.has(pc)) return letter + accidental;
    return (useFlat(pc, fifths, preference) ? FLAT_NAMES : SHARP_NAMES)[pc];
  };
  const match = /^([A-G])([#b♯♭]?)(.*?)(?:\/([A-G])([#b♯♭]?))?$/.exec(name);
  if (!match) return name;
  const [, root, rootAcc, quality, bass, bassAcc] = match;
  return respell(root, rootAcc) + quality + (bass ? `/${respell(bass, bassAcc || '')}` : '');
}

/**
 * Spells black-key notes outside each bar's key as flats or sharps
 * (`preference`: 'flats', 'sharps' or 'key'), and chord names to match.
 * Notes in the key keep the key's spelling.
 */
export function applySpelling(m, score, preference) {
  const { ForceFlat, ForceSharp, Default } = m.NoteAccidentalMode;
  for (const staff of pitchedStaves(score)) {
    const shift = staff.displayTranspositionPitch || 0;
    for (const bar of staff.bars) {
      const scale = scaleOf(bar.keySignature);
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            if (![Default, ForceFlat, ForceSharp].includes(note.accidentalMode)) continue; // set on purpose in the file
            const pc = mod12(pitchOf(note) - shift);
            if (!BLACK.has(pc) || scale.has(pc) || preference === 'key') note.accidentalMode = Default;
            else note.accidentalMode = preference === 'flats' ? ForceFlat : ForceSharp;
          }
        }
      }
    }
    if (staff.chords) {
      const key = writtenKey(staff.bars[0]?.keySignature ?? 0, shift);
      for (const chord of staff.chords.values()) if (chord.name) chord.name = spellChordName(chord.name, key, preference);
    }
  }
}
