// Fingering: choosing where on the neck each note is played.
//
// optimizeFingering() keeps every pitch and only changes string/fret, picking
// the positions that need the least hand movement over the whole passage.
//
// The model follows the fretting hand. At any moment the hand sits in a
// position: the index finger at fret h covers frets h..h+3, one finger per
// fret. A shape (one note or a chord) can be played from a position when all
// of its fretted notes fall inside that window; open strings fit anywhere.
// Dynamic programming walks through the music and finds the sequence of
// (shape, position) pairs with the lowest total cost, where cost is mostly
// hand shifts: every change of position costs a fixed amount plus a little
// per fret travelled, so the result stays in one position as long as it can
// and shifts as rarely and as little as possible.
//
// Rules a player would follow are built into the costs:
//   - a chord must fit under the hand (a five-fret stretch at most),
//   - tied notes stay on the same string and fret,
//   - hammer-ons, pull-offs and slides stay on one string,
//   - shifting is cheaper during an open string or after a long note or rest,
//   - lower positions win ties, very high positions cost a little extra,
//   - natural harmonics are left where they are (moving them changes them).
//
// convertToFourStringBass() retunes a 5- or 6-string bass track to standard
// E A D G, moves notes that are too low up an octave, then optimizes.

export const MAX_FRET = 24;
export const BASS_4_STANDARD = [43, 38, 33, 28]; // G D A E (high to low)

const HAND_SPAN = 3; // index at h reaches h+3 (four frets) without stretching
const MAX_STRETCH = 4; // a five-fret stretch is allowed, at a price
const MAX_CANDIDATES = 48;

// Costs. A shift is the thing to avoid; everything else breaks ties.
const SHIFT_COST = 3;
const SHIFT_PER_FRET = 0.35;
const STRETCH_COST = 2;
const POSITION_COST = 0.04; // per fret of hand position, keeps things low
const HIGH_POSITION_COST = 0.15; // extra per fret above the 12th
const STRING_CROSS_COST = 0.15;
const LEGATO_BREAK_COST = 8;
const HALF_NOTE_TICKS = 1920; // alphaTab uses 960 ticks per quarter note

/** Sounding pitch of a note on its staff (capo and harmonics ignored). */
export function notePitch(staff, note) {
  const tuning = staff.tuning;
  return tuning[tuning.length - note.string] + note.fret;
}

function stringPitch(staff, string) {
  return staff.tuning[staff.tuning.length - string];
}

function isStringed(staff) {
  return !!staff && !staff.isPercussion && staff.tuning.length > 0;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Groups the notes of a staff into time-ordered events (notes starting together). */
function buildEvents(staff, fromBar, toBar) {
  const events = [];
  for (let b = fromBar; b <= toBar && b < staff.bars.length; b++) {
    const bar = staff.bars[b];
    const byStart = new Map();
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest || beat.notes.length === 0) continue;
        const key = beat.playbackStart;
        if (!byStart.has(key)) byStart.set(key, { bar: b, start: key, beats: [], notes: [] });
        const ev = byStart.get(key);
        ev.beats.push(beat);
        ev.notes.push(...beat.notes);
      }
    }
    events.push(...[...byStart.values()].sort((a, c) => a.start - c.start));
  }
  for (const ev of events) {
    ev.time = ev.beats[0].absolutePlaybackStart;
    ev.duration = Math.max(...ev.beats.map((x) => x.playbackDuration));
  }
  return events;
}

// ---------------------------------------------------------------------------
// Candidate shapes
// ---------------------------------------------------------------------------

/** Fretted extent of a shape, or null when it only uses open strings. */
function extentOf(frets) {
  const fretted = frets.filter((f) => f > 0);
  if (fretted.length === 0) return null;
  const lo = Math.min(...fretted);
  const hi = Math.max(...fretted);
  return { lo, hi, span: hi - lo };
}

/** Hand positions (index-finger frets) that can play a shape. */
function positionsFor(extent, maxFret) {
  if (!extent) return null; // open strings only: any position
  const out = [];
  const reach = extent.span <= HAND_SPAN ? HAND_SPAN : MAX_STRETCH;
  for (let h = Math.max(1, extent.hi - reach); h <= extent.lo && h <= maxFret; h++) out.push(h);
  return out;
}

function shapeCost(frets, strings, extent) {
  let cost = 0;
  if (extent && extent.span > HAND_SPAN) cost += STRETCH_COST * (extent.span - HAND_SPAN);
  if (strings.length > 1) {
    // Chords: prefer shapes on neighbouring strings.
    const spread = Math.max(...strings) - Math.min(...strings) + 1 - strings.length;
    cost += 0.3 * Math.max(0, spread);
  }
  // Tiny pull towards lower frets so otherwise equal choices stay low.
  for (const f of frets) cost += 0.005 * f;
  return cost;
}

function isFixed(note) {
  return note.harmonicType !== 0 && note.harmonicType !== undefined;
}

/**
 * All playable ways to place the event's notes: each note on its own string,
 * fret 0..maxFret, chord within reach. Fixed notes (harmonics) keep their place.
 */
function candidatesFor(staff, ev, maxFret) {
  const strings = staff.tuning.length;
  const movable = ev.notes.filter((n) => !isFixed(n));
  const fixed = ev.notes.filter(isFixed);
  const used = new Set(fixed.map((n) => n.string));
  const results = [];

  const make = (place) => {
    const frets = [...[...place.values()].map((c) => c.fret), ...fixed.map((n) => n.fret)];
    const stringsUsed = [...[...place.values()].map((c) => c.string), ...fixed.map((n) => n.string)];
    const extent = extentOf(frets);
    return { place, extent, stringsUsed, cost: shapeCost(frets, stringsUsed, extent) };
  };

  const assign = (i, chosen) => {
    if (results.length > 4000) return;
    if (i === movable.length) {
      const cand = make(new Map(chosen.map((c, k) => [movable[k], { string: c.string, fret: c.fret }])));
      if (!cand.extent || cand.extent.span <= MAX_STRETCH) results.push(cand);
      return;
    }
    for (let s = 1; s <= strings; s++) {
      if (used.has(s)) continue;
      const fret = movable[i].pitch - stringPitch(staff, s);
      if (fret < 0 || fret > maxFret) continue;
      used.add(s);
      chosen.push({ string: s, fret });
      assign(i + 1, chosen);
      chosen.pop();
      used.delete(s);
    }
  };
  assign(0, []);

  results.sort((a, b) => a.cost - b.cost);
  const top = results.slice(0, MAX_CANDIDATES);
  // Keep the current placement too, so there is always a way through.
  const same = (c) => movable.every((n) => c.place.get(n).string === n.string);
  if (!top.some(same)) {
    const current = make(new Map(movable.map((n) => [n, { string: n.string, fret: n.fret }])));
    if (current.extent && current.extent.span > MAX_STRETCH) current.cost += 20; // awkward, but possible
    top.push(current);
  }
  for (const cand of top) {
    const positions = positionsFor(cand.extent, maxFret);
    // Too wide for one hand position (e.g. two voices far apart): play it
    // from its lowest fretted note rather than giving up on the passage.
    cand.positions = positions === null ? null : positions.length ? positions : [Math.min(cand.extent.lo, maxFret)];
  }
  return top;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function shiftCost(from, to, discount) {
  if (from === to) return 0;
  return (SHIFT_COST + SHIFT_PER_FRET * Math.abs(from - to)) * discount;
}

function positionCost(h) {
  return POSITION_COST * h + (h > 12 ? HIGH_POSITION_COST * (h - 12) : 0);
}

/** Links between notes that must share a string: [origin, destination, mustMatch]. */
function linksBetween(prevEv, ev) {
  const links = [];
  for (const dest of ev.notes) {
    if (dest.isTieDestination && dest.tieOrigin && prevEv.notes.includes(dest.tieOrigin)) {
      links.push([dest.tieOrigin, dest, true]);
    }
  }
  for (const origin of prevEv.notes) {
    const dest = origin.hammerPullDestination || origin.slideTarget;
    if (dest && ev.notes.includes(dest)) links.push([origin, dest, false]);
  }
  return links;
}

/** Costs that depend on which shapes follow each other (not on the hand position). */
function pairCost(prev, cand, links) {
  let cost = 0;
  if (prev.stringsUsed.length === 1 && cand.stringsUsed.length === 1) {
    cost += STRING_CROSS_COST * Math.abs(prev.stringsUsed[0] - cand.stringsUsed[0]);
  }
  for (const [origin, dest, hard] of links) {
    const a = prev.place.get(origin) ?? origin;
    const b = cand.place.get(dest) ?? dest;
    if (a.string !== b.string) cost += hard ? 1e6 : LEGATO_BREAK_COST;
  }
  return cost;
}

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

/** Expands a candidate into (candidate, hand position) states. */
function statesFor(cand, maxFret) {
  if (cand.positions) return cand.positions.map((h) => ({ cand, h }));
  const all = [];
  for (let h = 1; h <= maxFret - HAND_SPAN; h++) all.push({ cand, h });
  return all;
}

/**
 * Re-chooses string and fret for every note in the range, keeping pitches.
 * @returns {{ changed: number, notes: number }}
 */
export function optimizeFingering(m, score, trackIndex, { fromBar = 0, toBar = Infinity, maxFret = MAX_FRET } = {}) {
  let changed = 0;
  let total = 0;
  for (const staff of score.tracks[trackIndex].staves) {
    if (!isStringed(staff)) continue;
    const last = Math.min(toBar, staff.bars.length - 1);
    const events = buildEvents(staff, fromBar, last);
    if (events.length === 0) continue;
    for (const ev of events) for (const n of ev.notes) n.pitch = notePitch(staff, n);

    const options = events.map((ev) => candidatesFor(staff, ev, maxFret));

    // Viterbi over (shape, hand position) states.
    let layer = options[0].flatMap((cand) => statesFor(cand, maxFret)).map((st) => ({
      ...st,
      cost: st.cand.cost + (st.cand.extent ? positionCost(st.h) : 0),
      back: null
    }));
    for (let i = 1; i < events.length; i++) {
      const prevEv = events[i - 1];
      const ev = events[i];
      const links = linksBetween(prevEv, ev);
      const gapDiscount = ev.time - prevEv.time >= HALF_NOTE_TICKS ? 0.5 : 1;
      const pairwise = links.length > 0 || options[i].some((c) => c.stringsUsed.length === 1);

      // Best previous state for each hand position (when only the position matters).
      const bestAt = new Map();
      for (const p of layer) {
        const cur = bestAt.get(p.h);
        if (!cur || p.cost < cur.cost) bestAt.set(p.h, p);
      }

      const next = [];
      for (const cand of options[i]) {
        for (const { h } of statesFor(cand, maxFret)) {
          let best = null;
          let bestCost = Infinity;
          const sources = pairwise ? layer : bestAt.values();
          for (const p of sources) {
            const discount = gapDiscount * (p.cand.extent ? 1 : 0.5);
            const c = p.cost + shiftCost(p.h, h, discount) + (pairwise ? pairCost(p.cand, cand, links) : 0);
            if (c < bestCost) {
              bestCost = c;
              best = p;
            }
          }
          if (!best) continue;
          next.push({ cand, h, back: best, cost: bestCost + cand.cost + (cand.extent ? positionCost(h) : 0) });
        }
      }
      // Never let the path break: if nothing connects, restart from the
      // cheapest state so far (only possible with very odd input).
      if (next.length === 0) {
        const restart = layer.reduce((a, b) => (b.cost < a.cost ? b : a));
        for (const cand of options[i]) {
          for (const { h } of statesFor(cand, maxFret)) next.push({ cand, h, back: restart, cost: restart.cost + SHIFT_COST + cand.cost });
        }
      }
      layer = next;
    }

    // Walk back the cheapest path and apply it.
    let node = layer.reduce((a, b) => (b.cost < a.cost ? b : a));
    while (node) {
      for (const [note, pos] of node.cand.place) {
        total++;
        if (note.string !== pos.string || note.fret !== pos.fret) {
          note.string = pos.string;
          note.fret = pos.fret;
          changed++;
        }
      }
      node = node.back;
    }
    // Ties whose origin wasn't in the previous event: copy the origin's place.
    for (const ev of events) {
      for (const n of ev.notes) {
        if (n.isTieDestination && n.tieOrigin && (n.string !== n.tieOrigin.string || n.fret !== n.tieOrigin.fret)) {
          const clash = ev.notes.some((o) => o !== n && o.string === n.tieOrigin.string);
          if (!clash) {
            n.string = n.tieOrigin.string;
            n.fret = n.tieOrigin.fret;
          }
        }
      }
    }
    for (const ev of events) for (const n of ev.notes) delete n.pitch;
  }
  return { changed, notes: total };
}

// ---------------------------------------------------------------------------
// 5/6-string bass to 4-string
// ---------------------------------------------------------------------------

/** Bass-like: low tuning, a bass instrument sound (GM 33-40), or "bass" in the name. */
export function looksLikeBass(staff) {
  const program = staff.track?.playbackInfo?.program;
  return Math.min(...staff.tuning) < 40 || (program >= 32 && program <= 39) || /bass/i.test(staff.track?.name || '');
}

export function canConvertToFourString(staff) {
  return isStringed(staff) && staff.tuning.length > 4 && looksLikeBass(staff);
}

/** Why a track can't be converted, or null when it can. */
export function fourStringBlocker(track) {
  const staves = track.staves.filter(isStringed);
  if (staves.length === 0) return 'This track has no strings to convert.';
  if (staves.some(canConvertToFourString)) return null;
  if (staves.every((s) => s.tuning.length <= 4)) return `${track.name} already has ${staves[0].tuning.length} strings.`;
  return `${track.name} looks like a guitar part, so it isn't converted to bass.`;
}

/**
 * Retunes a bass track to standard 4-string (E A D G), keeping pitches.
 * Notes lower than low E move up an octave; notes too high move down one.
 * @returns {{ octaveUp: number, octaveDown: number, dropped: number, changed: number }}
 */
export function convertToFourStringBass(m, score, trackIndex, { maxFret = MAX_FRET } = {}) {
  const report = { octaveUp: 0, octaveDown: 0, dropped: 0, changed: 0 };
  const lowest = BASS_4_STANDARD[BASS_4_STANDARD.length - 1];
  const highest = BASS_4_STANDARD[0] + maxFret;

  for (const staff of score.tracks[trackIndex].staves) {
    if (!canConvertToFourString(staff)) continue;
    const pitches = new Map();
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) {
            let p = notePitch(staff, note);
            if (!Number.isFinite(p)) continue; // note on a string the tuning doesn't have
            while (p < lowest) {
              p += 12;
              report.octaveUp++;
            }
            while (p > highest) {
              p -= 12;
              report.octaveDown++;
            }
            pitches.set(note, p);
          }
        }
      }
    }

    staff.stringTuning = new m.Tuning('Bass Standard', BASS_4_STANDARD.slice(), true);

    // First placement: every note on a valid string (lowest fret first);
    // chords with more notes than strings keep their highest four.
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          const notes = [...beat.notes].sort((a, b) => (pitches.get(b) ?? 0) - (pitches.get(a) ?? 0));
          const used = new Set();
          for (const note of notes) {
            const p = pitches.get(note);
            let placed = false;
            if (p === undefined) {
              beat.removeNote(note);
              report.dropped++;
              continue;
            }
            for (let s = BASS_4_STANDARD.length; s >= 1; s--) {
              const fret = p - BASS_4_STANDARD[BASS_4_STANDARD.length - s];
              if (used.has(s) || fret < 0 || fret > maxFret) continue;
              // Prefer the highest string that still has a non-negative fret: lowest fret.
              note.string = s;
              note.fret = fret;
              used.add(s);
              placed = true;
              break;
            }
            if (!placed) {
              beat.removeNote(note);
              report.dropped++;
            }
          }
        }
      }
    }
  }

  const track = score.tracks[trackIndex];
  track.name = track.name.replace(/\b([56])[- ]?strings?\b/i, '4-string');
  track.shortName = track.name.slice(0, 10);

  // Then find comfortable positions for the whole track. Tie, hammer-on and
  // slide links still point at the right notes from before the retune.
  report.changed = optimizeFingering(m, score, trackIndex, { maxFret }).changed;
  return report;
}
