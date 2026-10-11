// Fingering: choosing where on the neck each note is played.
//
// optimizeFingering() keeps every pitch and only changes string/fret, picking
// the positions that need the least hand movement over the whole passage.
// It works like a route planner: each moment in the music (an "event", all
// notes starting together) has a list of playable shapes, and dynamic
// programming finds the cheapest path through them, where cost is mostly how
// far the hand has to shift between shapes.
//
// Rules a player would follow are built into the costs:
//   - a chord must fit under the hand (span of about four frets),
//   - tied notes stay on the same string and fret,
//   - hammer-ons, pull-offs and slides stay on one string,
//   - shifting is cheaper during an open string or after a long note/rest,
//   - natural harmonics are left where they are (moving them changes them).
//
// convertToFourStringBass() retunes a 5- or 6-string bass track to standard
// E A D G, moves notes that are too low up an octave, then optimizes.

export const MAX_FRET = 24;
export const BASS_4_STANDARD = [43, 38, 33, 28]; // G D A E (high to low)

const HAND_SPAN = 3; // frets the hand covers without shifting (index to pinky = 4 frets)
const MAX_CANDIDATES = 48;

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

/** Hand window for a shape: the index-finger positions that reach all fretted notes. */
function windowOf(frets) {
  const fretted = frets.filter((f) => f > 0);
  if (fretted.length === 0) return null; // only open strings: any position works
  const lo = Math.min(...fretted);
  const hi = Math.max(...fretted);
  return { from: Math.max(1, hi - HAND_SPAN), to: lo, span: hi - lo, lo, hi };
}

function staticCost(frets, strings, window) {
  let cost = 0;
  // Gentle pull towards lower positions, so equal-movement choices stay low.
  for (const f of frets) cost += 0.02 * f + (f > 12 ? 0.05 * (f - 12) : 0);
  if (window && window.span > HAND_SPAN) cost += 3 * (window.span - HAND_SPAN);
  if (strings.length > 1) {
    // Chords: prefer shapes on neighbouring strings.
    const spread = Math.max(...strings) - Math.min(...strings) + 1 - strings.length;
    cost += 0.3 * Math.max(0, spread);
  }
  return cost;
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
  const pitches = movable.map((n) => n.pitch);
  const results = [];

  const assign = (i, chosen) => {
    if (results.length > 4000) return;
    if (i === movable.length) {
      const frets = [...chosen.map((c) => c.fret), ...fixed.map((n) => n.fret)];
      const allStrings = [...chosen.map((c) => c.string), ...fixed.map((n) => n.string)];
      const window = windowOf(frets);
      if (window && window.span > HAND_SPAN + 2) return; // unplayable stretch
      results.push({
        place: new Map(chosen.map((c, k) => [movable[k], c])),
        window,
        stringsUsed: allStrings,
        cost: staticCost(frets, allStrings, window)
      });
      return;
    }
    for (let s = 1; s <= strings; s++) {
      if (used.has(s)) continue;
      const fret = pitches[i] - stringPitch(staff, s);
      if (fret < 0 || fret > maxFret) continue;
      used.add(s);
      chosen.push({ string: s, fret });
      assign(i + 1, chosen);
      chosen.pop();
      used.delete(s);
    }
  };
  assign(0, []);

  // Always keep the current placement, so nothing gets worse than the original.
  const current = {
    place: new Map(movable.map((n) => [n, { string: n.string, fret: n.fret }])),
    window: windowOf(ev.notes.map((n) => n.fret)),
    stringsUsed: ev.notes.map((n) => n.string),
    current: true
  };
  current.cost = staticCost(ev.notes.map((n) => n.fret), current.stringsUsed, current.window);
  results.sort((a, b) => a.cost - b.cost);
  const top = results.slice(0, MAX_CANDIDATES);
  const same = (c) => movable.every((n) => c.place.get(n).string === n.string);
  if (!top.some(same)) top.push(current);
  return top;
}

function isFixed(note) {
  return note.harmonicType !== 0 && note.harmonicType !== undefined;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function windowDistance(a, b) {
  if (!a || !b) return 0;
  if (b.to < a.from) return a.from - b.to;
  if (b.from > a.to) return b.from - a.to;
  return 0;
}

/**
 * Cost of moving from one shape to the next.
 * `held` is the hand window carried through open-string-only shapes.
 */
function transitionCost(prevEv, prev, held, ev, cand, links) {
  let cost = 0;
  const target = cand.window;
  const distance = windowDistance(held, target);
  if (distance > 0) {
    let shift = 1 + 0.6 * distance;
    // Time to move: after long notes/rests or during open strings it's easier.
    const gap = ev.time - prevEv.time;
    if (gap >= 1920) shift *= 0.5; // a half note or more (960 ticks per quarter)
    if (!prev.window) shift *= 0.6;
    cost += shift;
  }
  // String crossings in single-note lines.
  if (prev.stringsUsed.length === 1 && cand.stringsUsed.length === 1) {
    cost += 0.12 * Math.abs(prev.stringsUsed[0] - cand.stringsUsed[0]);
  }
  // Ties, hammer-ons/pull-offs and slides must stay on one string.
  for (const [origin, dest, hard] of links) {
    const a = prev.place.get(origin) ?? (prevEv.notes.includes(origin) ? origin : null);
    const b = cand.place.get(dest) ?? (ev.notes.includes(dest) ? dest : null);
    if (!a || !b) continue;
    if (a.string !== b.string) cost += hard ? 1e6 : 8;
  }
  return cost;
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

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

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

    // Viterbi over events. Each entry remembers the hand window it carries
    // forward (open-string shapes keep the previous window).
    let layer = options[0].map((cand) => ({ cost: cand.cost, held: cand.window, back: null, cand }));
    const layers = [layer];
    for (let i = 1; i < events.length; i++) {
      const links = linksBetween(events[i - 1], events[i]);
      const next = options[i].map((cand) => {
        let best = null;
        for (const p of layer) {
          const c = p.cost + transitionCost(events[i - 1], p.cand, p.held, events[i], cand, links);
          if (!best || c < best.cost) best = { cost: c, back: p };
        }
        return { cost: best.cost + cand.cost, held: cand.window || best.back.held, back: best.back, cand };
      });
      layers.push(next);
      layer = next;
    }

    // Walk back the cheapest path and apply it.
    let node = layer.reduce((a, b) => (b.cost < a.cost ? b : a));
    for (let i = events.length - 1; i >= 0; i--) {
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
export function convertToFourStringBass(m, score, trackIndex) {
  const report = { octaveUp: 0, octaveDown: 0, dropped: 0, changed: 0 };
  const lowest = BASS_4_STANDARD[BASS_4_STANDARD.length - 1];
  const highest = BASS_4_STANDARD[0] + MAX_FRET;

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
              if (used.has(s) || fret < 0 || fret > MAX_FRET) continue;
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
  report.changed = optimizeFingering(m, score, trackIndex).changed;
  return report;
}
