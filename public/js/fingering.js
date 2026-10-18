// Fingering: choosing where on the neck each note is played.
//
// optimizeFingering() keeps every pitch and only changes string/fret, picking
// the positions that are easiest to play over the whole passage.
//
// The model follows the fretting hand. At any moment the hand sits in a
// position: the index finger at fret h, one finger per fret over four frets
// (h..h+3). Low on a bass neck, where frets are wide, the hand covers three
// (h..h+2), the way bass players are taught. A chord may stretch one fret
// further, at a price; a single note outside the hand means a shift. Open
// strings fit anywhere.
//
// Dynamic programming walks through the music and finds the sequence of
// (shape, hand position) pairs with the lowest total cost. Cost is mostly
// hand shifts: every change of position costs a fixed amount plus a little
// per fret travelled, so the result stays in one position as long as it can.
// What a shift costs depends on how much time there is to make it: a shift
// between fast notes costs more, one during a long note, a rest, an open
// string or a slide (which carries the hand) costs less.
//
// Rules a player would follow are built into the costs:
//   - a chord must fit under the hand,
//   - tied notes stay on the same string and fret,
//   - hammer-ons, pull-offs and slides stay on one string,
//   - lower positions win ties, very high positions cost a little extra,
//   - a bar that repeats gets the same fingering each time when that costs
//     little, so it only has to be learned once,
//   - natural harmonics are left where they are (moving them changes them).
//
// Three styles shift the balance: "fewest" (fewest hand shifts), "low"
// (stay low on the neck and use open strings) and "fretted" (avoid open
// strings, for muting and an even sound).
//
// convertToFourStringBass() retunes a 5- or 6-string bass track to standard
// E A D G, moves notes that are too low up an octave (by default together
// with the rest of their phrase, so a riff keeps its shape), then optimizes.

import { shortTrackName } from './convert.js';

export const MAX_FRET = 24;
export const BASS_4_STANDARD = [43, 38, 33, 28]; // G D A E (high to low)
export const FINGERING_STYLES = ['fewest', 'low', 'fretted'];

const MAX_REACH = 4; // frets above the index finger, with a stretch
const MAX_CANDIDATES = 48;
const TICKS_PER_QUARTER = 960; // alphaTab's resolution

// Costs. A shift is the thing to avoid; everything else breaks ties.
const SHIFT_COST = 3;
const SHIFT_PER_FRET = 0.35;
const STRETCH_COST = 2; // holding a chord shape one fret wider than the hand
const POSITION_COST = 0.04; // per fret of hand position, keeps things low
const HIGH_POSITION_COST = 0.15; // extra per fret above the 12th
const STRING_CROSS_COST = 0.15;
const LEGATO_BREAK_COST = 8;
const HELD_STRING_COST = 1000; // a note on a string another note is still ringing on
const REPEAT_COST = 0.8; // per beat of a repeated bar fingered differently

const STYLE_COSTS = {
  fewest: { position: 1, open: 0, fretted: 0 },
  low: { position: 4, open: 0, fretted: 0.25 },
  fretted: { position: 1, open: 1.2, fretted: 0 }
};

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
// The hand
// ---------------------------------------------------------------------------

/** Frets above the index finger the hand covers without stretching, at position h. */
function comfortSpan(h, bass) {
  return bass && h < 5 ? 2 : 3;
}

/** Hand positions that can play a fretted extent, with how far each has to stretch. */
function positionsFor(extent, maxFret, bass) {
  const out = [];
  const maxStretch = extent.count > 1 ? 1 : 0; // only chords stretch
  for (let h = Math.max(1, extent.hi - MAX_REACH); h <= extent.lo && h <= maxFret; h++) {
    const stretch = extent.hi - h - comfortSpan(h, bass);
    if (stretch <= maxStretch) out.push({ h, stretch: Math.max(0, stretch) });
  }
  return out;
}

function positionCost(h, style) {
  return POSITION_COST * style.position * h + (h > 12 ? HIGH_POSITION_COST * (h - 12) : 0);
}

/**
 * How costly a shift is, given the seconds between the two notes: shifts
 * between fast notes are hard, shifts with time to spare are easy.
 */
function shiftUrgency(seconds) {
  if (seconds <= 0.12) return 1.5;
  if (seconds >= 0.75) return 0.5;
  return 1.5 - (seconds - 0.12) / (0.75 - 0.12);
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
  for (const ev of events) ev.time = ev.beats[0].absolutePlaybackStart;
  return events;
}

/**
 * Tempo (quarter notes per minute) at the start of each bar: a change right
 * at the start, or else the last change of an earlier bar.
 */
export function barTempos(score) {
  const out = [];
  let tempo = score.tempo || 120;
  for (const mb of score.masterBars) {
    const changes = [...(mb.tempoAutomations || [])].sort((a, c) => a.ratioPosition - c.ratioPosition);
    out.push(changes.length && changes[0].ratioPosition === 0 ? changes[0].value || tempo : tempo);
    if (changes.length) tempo = changes[changes.length - 1].value || tempo;
  }
  return out;
}

/**
 * For each event, the notes of earlier events still sounding when it starts
 * (a long note in another voice): their strings are busy.
 */
function heldNotes(staff, events) {
  const notes = [];
  const lastBar = events[events.length - 1].bar;
  for (let b = 0; b <= lastBar && b < staff.bars.length; b++) {
    for (const voice of staff.bars[b].voices) {
      for (const beat of voice.beats) {
        const start = beat.absolutePlaybackStart;
        for (const note of beat.notes) notes.push({ note, start, end: start + beat.playbackDuration });
      }
    }
  }
  notes.sort((a, c) => a.start - c.start);
  let next = 0;
  let sounding = [];
  return events.map((ev) => {
    while (next < notes.length && notes[next].start < ev.time) sounding.push(notes[next++]);
    sounding = sounding.filter((it) => it.end > ev.time);
    return sounding.map((it) => it.note);
  });
}

/** Seconds from each event to the next one. */
function eventGaps(score, events) {
  const tempos = barTempos(score);
  return events.map((ev, i) => {
    if (i === 0) return Infinity;
    const prev = events[i - 1];
    const bpm = tempos[prev.bar] || 120;
    return ((ev.time - prev.time) / TICKS_PER_QUARTER) * (60 / bpm);
  });
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
  return { lo, hi, span: hi - lo, count: fretted.length };
}

function shapeCost(frets, strings, style) {
  let cost = 0;
  if (strings.length > 1) {
    // Chords: prefer shapes on neighbouring strings.
    const spread = Math.max(...strings) - Math.min(...strings) + 1 - strings.length;
    cost += 0.3 * Math.max(0, spread);
  }
  for (const f of frets) {
    cost += f === 0 ? style.open : style.fretted;
    cost += 0.005 * f; // tiny pull towards lower frets so equal choices stay low
  }
  return cost;
}

function isFixed(note) {
  return note.harmonicType !== 0 && note.harmonicType !== undefined;
}

/**
 * All playable ways to place the event's notes: each note on its own string,
 * fret 0..maxFret, chord within reach. Fixed notes (harmonics) keep their place.
 * Strings in ev.busy (still ringing from an earlier note) are avoided when possible.
 */
function candidatesFor(staff, ev, ctx) {
  const { maxFret, style, bass } = ctx;
  const strings = staff.tuning.length;
  const movable = ev.notes.filter((n) => !isFixed(n));
  const fixed = ev.notes.filter(isFixed);
  const used = new Set(fixed.map((n) => n.string));
  const results = [];

  const make = (place) => {
    const frets = [...[...place.values()].map((c) => c.fret), ...fixed.map((n) => n.fret)];
    const stringsUsed = [...[...place.values()].map((c) => c.string), ...fixed.map((n) => n.string)];
    return { place, extent: extentOf(frets), stringsUsed, cost: shapeCost(frets, stringsUsed, style) };
  };

  const assign = (i, chosen, avoid) => {
    if (results.length > 4000) return;
    if (i === movable.length) {
      const cand = make(new Map(chosen.map((c, k) => [movable[k], { string: c.string, fret: c.fret }])));
      if (!cand.extent || cand.extent.span <= MAX_REACH - 1) results.push(cand);
      return;
    }
    for (let s = 1; s <= strings; s++) {
      if (used.has(s) || avoid.has(s)) continue;
      const fret = movable[i].pitch - stringPitch(staff, s);
      if (fret < 0 || fret > maxFret) continue;
      used.add(s);
      chosen.push({ string: s, fret });
      assign(i + 1, chosen, avoid);
      chosen.pop();
      used.delete(s);
    }
  };
  const busy = ev.busy ?? new Set();
  assign(0, [], busy);
  // Better to cut a ringing note short than to have no way to play this one.
  if (results.length === 0 && busy.size) assign(0, [], new Set());

  results.sort((a, b) => a.cost - b.cost);
  const top = results.slice(0, MAX_CANDIDATES);
  // Keep the current placement too, so there is always a way through.
  const same = (c) => movable.every((n) => c.place.get(n).string === n.string);
  if (!top.some(same)) {
    const current = make(new Map(movable.map((n) => [n, { string: n.string, fret: n.fret }])));
    current.cost += 20; // awkward, but possible
    top.push(current);
  }
  top.forEach((cand, i) => {
    cand.i = i;
    // Notes in pitch order -> strings, to recognise the same fingering again.
    cand.print = [...cand.place].sort((a, b) => a[0].pitch - b[0].pitch).map(([, c]) => c.string).join(',');
    if (!cand.extent) {
      cand.states = null; // open strings only: any position
      return;
    }
    const positions = positionsFor(cand.extent, maxFret, bass);
    // Too wide for one hand position (e.g. two voices far apart): play it
    // from its lowest fretted note rather than giving up on the passage.
    cand.states = positions.length
      ? positions
      : [{ h: Math.min(cand.extent.lo, maxFret), stretch: Math.max(0, cand.extent.span - comfortSpan(cand.extent.lo, bass)) }];
  });
  return top;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

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

/**
 * Costs that depend on which shapes follow each other (not on the hand
 * position), and whether a slide carries the hand to the new place.
 */
function pairCost(prev, cand, links) {
  let cost = 0;
  let glide = false;
  if (prev.stringsUsed.length === 1 && cand.stringsUsed.length === 1) {
    cost += STRING_CROSS_COST * Math.abs(prev.stringsUsed[0] - cand.stringsUsed[0]);
  }
  for (const [origin, dest, hard] of links) {
    const a = prev.place.get(origin) ?? origin;
    const b = cand.place.get(dest) ?? dest;
    if (a.string !== b.string) cost += hard ? 1e6 : LEGATO_BREAK_COST;
    else if (origin.slideTarget === dest) glide = true;
  }
  return { cost, glide };
}

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

/** (candidate, hand position) states for a candidate. */
function statesFor(cand, maxFret) {
  if (cand.states) return cand.states;
  const all = [];
  for (let h = 1; h <= Math.max(1, maxFret - 3); h++) all.push({ h, stretch: 0 });
  return all;
}

/**
 * Strings that the held notes (latest event first) occupy on the path ending
 * in `node`, which is at event k.
 */
function ringingStrings(node, k, held) {
  const out = new Set();
  for (const { note, at } of held) {
    while (node && k > at) {
      node = node.back;
      k--;
    }
    const pos = node?.cand.place.get(note);
    if (pos) out.add(pos.string);
  }
  return out;
}

/**
 * Finds the cheapest (shape, position) path through the events.
 * bias[i], when set, adds a cost to some shapes of event i.
 */
function bestPath(events, options, gaps, ctx, bias) {
  const { maxFret, style } = ctx;
  const stateCost = (cand, st, i) =>
    cand.cost +
    (bias?.[i] ? bias[i](cand) : 0) +
    (cand.extent ? positionCost(st.h, style) + st.stretch * STRETCH_COST : 0);

  let layer = options[0].flatMap((cand) => statesFor(cand, maxFret).map((st) => ({ cand, h: st.h, cost: stateCost(cand, st, 0), back: null })));
  const none = { cost: 0, glide: false };
  for (let i = 1; i < events.length; i++) {
    const links = linksBetween(events[i - 1], events[i]);
    const urgency = shiftUrgency(gaps[i]);
    const held = events[i].held ?? [];
    const pairwise = links.length > 0 || held.length > 0 || options[i].some((c) => c.stringsUsed.length === 1);
    const pairs = pairwise ? options[i - 1].map((p) => options[i].map((c) => pairCost(p, c, links))) : null;
    // Strings still ringing from notes placed earlier on each path.
    const ringing = held.length ? new Map(layer.map((p) => [p, ringingStrings(p, i - 1, held)])) : null;

    // Best previous state for each hand position (when only the position matters).
    const bestAt = new Map();
    if (!pairwise) {
      for (const p of layer) {
        const cur = bestAt.get(p.h);
        if (!cur || p.cost < cur.cost) bestAt.set(p.h, p);
      }
    }

    const next = [];
    for (const cand of options[i]) {
      for (const st of statesFor(cand, maxFret)) {
        let best = null;
        let bestCost = Infinity;
        for (const p of pairwise ? layer : bestAt.values()) {
          const pair = pairwise ? pairs[p.cand.i][cand.i] : none;
          let c = p.cost + pair.cost;
          if (ringing && cand.stringsUsed.some((s) => ringing.get(p).has(s))) c += HELD_STRING_COST;
          if (p.h !== st.h) {
            // Open strings leave the hand free; a slide moves it anyway.
            const factor = urgency * (p.cand.extent ? 1 : 0.5) * (pair.glide ? 0.3 : 1);
            c += (SHIFT_COST + SHIFT_PER_FRET * Math.abs(p.h - st.h)) * factor;
          }
          if (c < bestCost) {
            bestCost = c;
            best = p;
          }
        }
        if (!best) continue;
        next.push({ cand, h: st.h, back: best, cost: bestCost + stateCost(cand, st, i) });
      }
    }
    // Never let the path break: if nothing connects, restart from the
    // cheapest state so far (only possible with very odd input).
    if (next.length === 0) {
      const restart = layer.reduce((a, b) => (b.cost < a.cost ? b : a));
      for (const cand of options[i]) {
        for (const st of statesFor(cand, maxFret)) {
          next.push({ cand, h: st.h, back: restart, cost: restart.cost + SHIFT_COST + stateCost(cand, st, i) });
        }
      }
    }
    layer = next;
  }

  const path = new Array(events.length);
  let node = layer.reduce((a, b) => (b.cost < a.cost ? b : a));
  for (let i = events.length - 1; i >= 0 && node; i--, node = node.back) path[i] = node.cand;
  return path;
}

/**
 * Bars with the same notes and rhythm should be fingered the same way, so a
 * riff is learned once. Returns a bias towards the most common fingering of
 * each repeated bar, or null when every repeat already matches.
 */
function repeatBias(events, path) {
  const barEvents = new Map();
  events.forEach((ev, i) => {
    if (!barEvents.has(ev.bar)) barEvents.set(ev.bar, []);
    barEvents.get(ev.bar).push(i);
  });
  const groups = new Map();
  for (const idx of barEvents.values()) {
    if (idx.length < 2) continue;
    const key = idx.map((i) => `${events[i].start}:${events[i].notes.map((n) => n.pitch).sort((a, b) => a - b).join('.')}`).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  }
  const bias = [];
  let differs = false;
  for (const instances of groups.values()) {
    if (instances.length < 2) continue;
    const prints = instances.map((idx) => idx.map((i) => path[i].print).join('|'));
    const counts = new Map();
    for (const p of prints) counts.set(p, (counts.get(p) || 0) + 1);
    let ref = 0;
    prints.forEach((p, k) => {
      if (counts.get(p) > counts.get(prints[ref])) ref = k;
    });
    if (prints.some((p) => p !== prints[ref])) differs = true;
    for (const idx of instances) {
      idx.forEach((i, k) => {
        const want = path[instances[ref][k]].print;
        bias[i] = (cand) => (cand.print === want ? 0 : REPEAT_COST);
      });
    }
  }
  return differs ? bias : null;
}

/** Fewest hand position changes needed to play the events as they are now written. */
function countShifts(events, ctx) {
  const { bass } = ctx;
  const top = Math.max(ctx.maxFret, ...events.flatMap((ev) => ev.notes.map((n) => n.fret)));
  let layer = new Map([[0, 0]]); // position -> cost (shifts * 1000 + frets travelled)
  for (const ev of events) {
    const extent = extentOf(ev.notes.map((n) => n.fret));
    let hs;
    if (!extent) hs = null;
    else {
      hs = positionsFor(extent, top, bass).map((s) => s.h);
      if (!hs.length) hs = [extent.lo];
    }
    if (!hs) continue; // open strings: the hand stays where it is
    const next = new Map();
    for (const h of hs) {
      let best = Infinity;
      for (const [p, c] of layer) best = Math.min(best, c + (p === 0 || p === h ? 0 : 1000 + Math.abs(p - h)));
      next.set(h, best);
    }
    layer = next;
  }
  return Math.floor(Math.min(...layer.values()) / 1000);
}

function contextFor(staff, maxFret, style) {
  return { maxFret, bass: looksLikeBass(staff), style: STYLE_COSTS[style] || STYLE_COSTS.fewest };
}

/**
 * Re-chooses string and fret for every note in the range, keeping pitches.
 * @param {{ fromBar?: number, toBar?: number, maxFret?: number, style?: 'fewest' | 'low' | 'fretted' }} options
 * @returns {{ changed: number, notes: number, shiftsBefore: number, shiftsAfter: number }}
 */
export function optimizeFingering(m, score, trackIndex, { fromBar = 0, toBar = Infinity, maxFret = MAX_FRET, style = 'fewest' } = {}) {
  const result = { changed: 0, notes: 0, shiftsBefore: 0, shiftsAfter: 0 };
  for (const staff of score.tracks[trackIndex].staves) {
    if (!isStringed(staff)) continue;
    const last = Math.min(toBar, staff.bars.length - 1);
    const events = buildEvents(staff, fromBar, last);
    if (events.length === 0) continue;
    const ctx = contextFor(staff, maxFret, style);
    for (const ev of events) for (const n of ev.notes) n.pitch = notePitch(staff, n);
    result.shiftsBefore += countShifts(events, ctx);

    // Notes still ringing when an event starts (a long note in another voice)
    // keep their string busy. A string held by a note that stays put (outside
    // the range, or a harmonic) is avoided; for notes being placed, the path
    // search keeps them apart.
    const eventOf = new Map();
    events.forEach((ev, i) => {
      for (const n of ev.notes) if (!isFixed(n)) eventOf.set(n, i);
    });
    heldNotes(staff, events).forEach((notes, i) => {
      events[i].busy = new Set(notes.filter((n) => !eventOf.has(n)).map((n) => n.string));
      events[i].held = notes.filter((n) => eventOf.has(n)).map((n) => ({ note: n, at: eventOf.get(n) }));
      events[i].held.sort((a, c) => c.at - a.at);
    });

    const options = events.map((ev) => candidatesFor(staff, ev, ctx));
    const gaps = eventGaps(score, events);
    let path = bestPath(events, options, gaps, ctx, null);
    const bias = repeatBias(events, path);
    if (bias) path = bestPath(events, options, gaps, ctx, bias);

    path.forEach((cand) => {
      for (const [note, pos] of cand.place) {
        result.notes++;
        if (note.string !== pos.string || note.fret !== pos.fret) {
          note.string = pos.string;
          note.fret = pos.fret;
          result.changed++;
        }
      }
    });
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
    // Ties running past the last bar: the rest of the tie follows the note.
    for (const ev of events) {
      for (const n of ev.notes) {
        let from = n;
        for (let d = n.tieDestination; d && d.beat.voice.bar.index > last; from = d, d = d.tieDestination) {
          if (d.beat.notes.some((o) => o !== d && o.string === from.string)) break;
          d.string = from.string;
          d.fret = from.fret;
        }
      }
    }
    result.shiftsAfter += countShifts(events, ctx);
    for (const ev of events) for (const n of ev.notes) delete n.pitch;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 5/6-string bass to 4-string
// ---------------------------------------------------------------------------

/**
 * Bass-like, decided by the instrument sound first (GM 33-40 is a bass, 25-32
 * a guitar, however low it is tuned), then "bass" in the name, and only then
 * by the tuning: 4 to 6 strings reaching below B1, lower than guitars usually go.
 */
export function looksLikeBass(staff) {
  const program = staff.track?.playbackInfo?.program;
  if (program >= 32 && program <= 39) return true;
  if (program >= 24 && program <= 31) return false;
  if (/bass/i.test(staff.track?.name || '')) return true;
  return staff.tuning.length >= 4 && staff.tuning.length <= 6 && Math.min(...staff.tuning) < 34;
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
 * Decides the new pitch of every note when a bass loses its low strings.
 * Notes below low E move up an octave. With lowNotes 'phrase', the notes
 * played together with them (up to the next rest, within two bars) move up
 * too, so a riff keeps its shape instead of jumping between octaves.
 */
function fourStringPitches(staff, lowest, highest, lowNotes, report) {
  const items = [];
  staff.bars.forEach((bar, b) => {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) {
          const p = notePitch(staff, note);
          if (!Number.isFinite(p)) continue; // note on a string the tuning doesn't have
          items.push({ note, p, bar: b, time: beat.absolutePlaybackStart, end: beat.absolutePlaybackStart + beat.playbackDuration });
        }
      }
    }
  });
  items.sort((a, c) => a.time - c.time);

  const pitches = new Map();
  const moveNote = (it) => {
    let p = it.p;
    while (p < lowest) {
      p += 12;
      report.octaveUp++;
    }
    while (p > highest) {
      p -= 12;
      report.octaveDown++;
    }
    pitches.set(it.note, p);
  };

  // Phrases: notes until a rest of a quarter note or more, at most two bars long.
  const phrases = [];
  let phrase = [];
  let end = -Infinity;
  for (const it of items) {
    const prev = phrase[phrase.length - 1];
    const breaks = phrase.length && (it.time - end >= TICKS_PER_QUARTER || (it.bar - phrase[0].bar >= 2 && it.time !== prev.time));
    if (breaks) {
      phrases.push(phrase);
      phrase = [];
      end = -Infinity;
    }
    phrase.push(it);
    end = Math.max(end, it.end);
  }
  if (phrase.length) phrases.push(phrase);

  for (const group of phrases) {
    const low = group.some((it) => it.p < lowest);
    const fits = group.every((it) => it.p + 12 <= highest && it.p + 12 >= lowest);
    if (lowNotes === 'phrase' && low && fits) {
      for (const it of group) {
        pitches.set(it.note, it.p + 12);
        report.octaveUp++;
      }
      report.phrasesUp++;
    } else {
      group.forEach(moveNote);
    }
  }
  // A tie always keeps the pitch of the note it continues.
  for (const it of items) {
    const origin = it.note.isTieDestination ? it.note.tieOrigin : null;
    if (origin && pitches.has(origin)) pitches.set(it.note, pitches.get(origin));
  }
  return pitches;
}

/**
 * Retunes a bass track to standard 4-string (E A D G).
 * Notes lower than low E move up an octave (with their phrase when lowNotes
 * is 'phrase'); notes too high move down one.
 * @returns {{ octaveUp: number, octaveDown: number, phrasesUp: number, dropped: number, changed: number, shiftsAfter: number }}
 */
export function convertToFourStringBass(m, score, trackIndex, { maxFret = MAX_FRET, lowNotes = 'phrase', style = 'fewest' } = {}) {
  const report = { octaveUp: 0, octaveDown: 0, phrasesUp: 0, dropped: 0, changed: 0, shiftsAfter: 0 };
  const lowest = BASS_4_STANDARD[BASS_4_STANDARD.length - 1];
  const highest = BASS_4_STANDARD[0] + maxFret;

  for (const staff of score.tracks[trackIndex].staves) {
    if (!canConvertToFourString(staff)) continue;
    const pitches = fourStringPitches(staff, lowest, highest, lowNotes, report);

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
  track.shortName = shortTrackName(track.name);

  // Then find comfortable positions for the whole track. Tie, hammer-on and
  // slide links still point at the right notes from before the retune.
  const optimized = optimizeFingering(m, score, trackIndex, { maxFret, style });
  report.changed = optimized.changed;
  report.shiftsAfter = optimized.shiftsAfter;
  return report;
}
