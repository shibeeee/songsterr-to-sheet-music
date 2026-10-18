import * as alphaTab from '../vendor/alphatab/alphaTab.mjs';
import { songsterrToScore } from './convert.js';
import { isSongsterrLink, parseSongsterrUrl } from './songsterr.js';
import { loadSong, search } from './sources.js';
import {
  prefs,
  recentSongs,
  rememberSong,
  forgetSong,
  saveEdits,
  loadEdits,
  deleteEdits,
  editedKeys,
  songView,
  rememberSongView
} from './storage.js';
import { setupBookmarklet, listenForBookmarklet } from './bookmarklet.js';
import { snapshot, restore, rebuildScore } from './editor.js';
import { createEditUI } from './edit-ui.js';
import { SOUND_SETS, fetchSound, isSoundCached } from './sound.js';
import { optimizeFingering, convertToFourStringBass, canConvertToFourString, fourStringBlocker } from './fingering.js';

const $ = (id) => document.getElementById(id);
// Resolve against the page so the app also works from a sub-path
// (e.g. https://user.github.io/songsterr-to-sheet-music/).
const asset = (path) => new URL(path, document.baseURI).href;

const PAPER_WIDTHS = { a4: '210mm', letter: '8.5in' };

const defaults = {
  view: 'both',
  rhythm: true,
  slash: false,
  chords: true,
  sections: true,
  tempo: true,
  layout: 'page',
  barsPerRow: -1,
  zoom: 100,
  paper: /^en-(US|CA)$/i.test(navigator.language) ? 'letter' : 'a4',
  dynamics: false, // mf, f... marks; Songsterr parts often change them every few notes
  speed: 100,
  trainer: false, // speed trainer: get faster each time the loop repeats
  trainerStart: 60,
  trainerStep: 5,
  trainerTarget: 100,
  metronome: false,
  countIn: false,
  loop: false,
  sound: 'better', // instrument sounds: 'better' (32 MB) or 'small' (1.3 MB)
  panelHidden: false, // desktop: options panel collapsed
  maxFret: 24,
  fingerStyle: 'fewest', // what the fingering optimizer aims for
  lowNotes: 'phrase', // 4-string conversion: move whole riffs, or only the low notes // frets on the player's instrument (for the optimizer)
  tipDismissed: false,
  onlyShown: false, // mute tracks that aren't shown
  volume: 90
};
const options = { ...defaults, ...prefs.get('options', {}) };
const saveOptions = () => prefs.set('options', options);

const state = {
  score: null,
  bundle: null, // raw Songsterr data when the score came from Songsterr
  sourceUrl: null, // Songsterr link of the current song
  visible: [],
  muted: new Set(),
  soloed: new Set(),
  seeking: false,
  endTime: 0,
  scrollToTop: false,
  range: { from: 1, to: 0 }, // bars shown; to = 0 means "to the end"
  undo: [],
  redo: [],
  original: null, // snapshot taken when the song was opened
  dirty: false,
  key: null, // identifies the song for saved edits and remembered views
  saveTimer: 0,
  saveFailed: false,
  toolTrack: null // track picked in the Fingering panel (null = choose automatically)
};
const UNDO_LIMIT = 60;

// ---------------------------------------------------------------------------
// alphaTab
// ---------------------------------------------------------------------------

const api = new alphaTab.AlphaTabApi($('score'), {
  // Note bounds let a click land on a single note when editing.
  core: { fontDirectory: asset('vendor/alphatab/font/'), includeNoteBounds: true },
  display: { layoutMode: alphaTab.LayoutMode.Page },
  player: {
    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
    // Sounds are loaded separately (see prepareSound) so pages open quickly.
    soundFont: null,
    enableCursor: true,
    enableUserInteraction: true,
    scrollElement: $('stage'),
    // Follow the cursor only when it leaves the screen, so a freshly opened
    // score isn't scrolled past its title.
    scrollMode: alphaTab.ScrollMode.OffScreen,
    scrollOffsetY: -40
  }
});
// Section names are drawn as beat text instead (see labelSections), and in a
// bold serif so they read as headings.
api.settings.notation.elements.set(alphaTab.NotationElement.EffectMarker, false);
api.settings.display.resources.elementFonts.set(
  alphaTab.NotationElement.EffectText,
  new alphaTab.model.Font('Georgia, serif', 12, alphaTab.model.FontStyle.Plain, alphaTab.model.FontWeight.Bold)
);

// ---------------------------------------------------------------------------
// Views and messages
// ---------------------------------------------------------------------------

function showView(view, { rerender = false } = {}) {
  document.body.dataset.view = view;
  $('home').hidden = view !== 'home';
  $('viewer').hidden = view !== 'score';
  if (view === 'home') {
    renderRecent();
    const back = $('back-to-score');
    back.hidden = !state.score;
    if (state.score) back.querySelector('span').textContent = `Back to ${state.score.title || 'the score'}`;
    document.title = 'Tab to Sheet';
  } else {
    closeSidebar();
    if (state.score) {
      updateSongHead();
      // Coming back to a score that was laid out while hidden: redo the layout.
      if (rerender) requestAnimationFrame(() => api.render());
    }
  }
}

function setStatus(message, kind = 'info', target = $('status')) {
  if (!message) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  target.className = `status ${kind}${target.id === 'viewer-status' ? ' floating' : ''}`;
  target.replaceChildren();
  if (kind === 'loading') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    target.append(spinner);
  }
  const text = document.createElement('span');
  text.textContent = message;
  target.append(text);
}

let toastTimer = 0;
function toast(message, action = null) {
  const el = $('toast');
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label });
    button.addEventListener('click', () => {
      el.hidden = true;
      action.run();
    });
    el.append(button);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 7000 : 2600);
}

function showWarnings(warnings) {
  const el = $('warnings');
  el.replaceChildren();
  el.hidden = !warnings || warnings.length === 0;
  if (el.hidden) return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `${warnings.length} detail${warnings.length === 1 ? '' : 's'} could not be converted exactly`;
  const list = document.createElement('ul');
  for (const w of warnings.slice(0, 50)) {
    const li = document.createElement('li');
    li.textContent = w;
    list.append(li);
  }
  details.append(summary, list);
  el.append(details);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let loadToken = 0;

async function openLink(link, { fromHistory = false } = {}) {
  const token = ++loadToken;
  // When a song is already open, keep it on screen while the new one loads.
  const inViewer = document.body.dataset.view === 'score' && !!state.score;
  const target = inViewer ? $('viewer-status') : $('status');
  if (!inViewer) showView('home');
  $('results').hidden = true;
  let parsed;
  try {
    parsed = parseSongsterrUrl(link);
  } catch (err) {
    if (inViewer) toast(err.message);
    else setStatus(err.message, 'error');
    return;
  }
  setStatus('Fetching the tab...', 'loading', target);
  try {
    const song = await loadSong(link, (message) => token === loadToken && setStatus(message, 'loading', target));
    if (token !== loadToken) return;
    await showBundle(song, {
      preferredTrack: parsed.trackIndex ?? song.trackIndex ?? 0,
      explicitTrack: parsed.trackIndex != null,
      sourceUrl: song.source || link,
      pushHistory: !fromHistory
    });
  } catch (err) {
    if (token !== loadToken) return;
    console.warn(err);
    if (inViewer) {
      setStatus(null, 'info', $('viewer-status'));
      showView('home');
    }
    if (err.status === 404) {
      setStatus(err.message, 'error');
      return;
    }
    setStatus(
      "Songsterr didn't let this page read the tab, and the backup routes didn't answer either. One of the options below will get it.",
      'error'
    );
    const more = $('more-ways');
    more.open = true;
    const open = $('open-on-songsterr');
    open.href = parsed.url || `https://www.songsterr.com/a/wsa/tab-s${parsed.songId}`;
    open.hidden = false;
  }
}

async function runSearch(query) {
  const token = ++loadToken;
  showView('home');
  const list = $('results');
  list.hidden = true;
  setStatus(`Searching for "${query}"...`, 'loading');
  try {
    const results = await search(query);
    if (token !== loadToken) return;
    setStatus(null);
    list.replaceChildren();
    if (results.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No songs found. Try fewer words, or paste the song link from songsterr.com.';
      list.append(li);
    }
    for (const r of results) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const title = Object.assign(document.createElement('span'), { className: 'r-title', textContent: r.title });
      const artist = Object.assign(document.createElement('span'), { className: 'r-artist', textContent: r.artist });
      const meta = Object.assign(document.createElement('span'), {
        className: 'r-meta',
        textContent: r.instruments.length ? `${r.instruments.length} track${r.instruments.length === 1 ? '' : 's'}` : ''
      });
      button.append(title, meta, artist);
      button.addEventListener('click', () => openLink(r.url));
      li.append(button);
      list.append(li);
    }
    list.hidden = false;
  } catch (err) {
    if (token !== loadToken) return;
    setStatus(
      `Search isn't available right now (${err.message}). Paste the song's link from songsterr.com instead.`,
      'error'
    );
  }
}

function submitQuery(text) {
  const value = text.trim();
  if (!value) return;
  if (isSongsterrLink(value)) openLink(value);
  else runSearch(value);
}

async function showBundle(bundle, { preferredTrack = 0, explicitTrack = false, sourceUrl = null, key = null, pushHistory = true } = {}) {
  const { score, warnings } = songsterrToScore(alphaTab, bundle);
  const shown = await showScore(score, [...(bundle.warnings || []), ...warnings], {
    preferredTrack,
    explicitTrack,
    bundle,
    sourceUrl,
    key: key || sourceUrl
  });
  if (shown && sourceUrl) {
    rememberSong({ url: sourceUrl, title: score.title, artist: score.artist });
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('url', sourceUrl);
    if (pushHistory) history.pushState({ view: 'score' }, '', url);
    else history.replaceState({ view: 'score' }, '', url);
  }
}

async function loadFile(file) {
  ++loadToken;
  setStatus(`Opening ${file.name}...`, 'loading');
  try {
    const name = file.name.toLowerCase();
    if (name.endsWith('.json')) {
      const bundle = JSON.parse(await file.text());
      if (!bundle.title) bundle.title = file.name.replace(/\.json$/i, '');
      await showBundle(bundle, { preferredTrack: bundle.trackIndex ?? 0, key: `file:${file.name}:${file.size}` });
      return;
    }
    let score;
    if (/\.(atex|alphatex|txt)$/.test(name)) {
      score = alphaTab.importer.ScoreLoader.loadAlphaTex(await file.text(), api.settings);
    } else {
      score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await file.arrayBuffer()), api.settings);
    }
    if (!score.title) score.title = file.name.replace(/\.[^.]+$/, '');
    await showScore(score, [], { key: `file:${file.name}:${file.size}` });
  } catch (err) {
    console.error(err);
    showView('home');
    setStatus(`Couldn't open ${file.name}: ${err.message || err}`, 'error');
  }
}

async function loadDemo() {
  ++loadToken;
  setStatus('Loading the example...', 'loading');
  try {
    const res = await fetch(asset('demo/demo-song.json'));
    await showBundle(await res.json(), { key: 'demo' });
  } catch (err) {
    setStatus(`Couldn't load the example: ${err.message}`, 'error');
  }
}

/**
 * Shows a newly opened song. Restores the user's saved edits and view for it.
 * @returns {Promise<boolean>} false when the user chose to stay on the current song
 */
async function showScore(score, warnings, { preferredTrack = 0, explicitTrack = false, bundle = null, sourceUrl = null, key = null } = {}) {
  if (state.dirty && state.saveFailed && !window.confirm('Your changes to this song could not be saved in this browser. Open the new song anyway?')) {
    return false;
  }
  await flushSave();
  api.stop();
  editUI.reset();

  const original = score;
  const saved = key ? await loadEdits(key) : null;
  let restored = null;
  if (saved) {
    try {
      score = alphaTab.model.JsonConverter.jsonToScore(saved.json, api.settings);
      restored = saved;
    } catch (err) {
      console.warn('Saved edits could not be read; showing the original', err);
    }
  }

  state.bundle = bundle;
  state.sourceUrl = sourceUrl;
  state.key = key;
  state.score = score;
  document.body.classList.add('cursor-idle'); // no playback cursor until there's playback
  state.undo = [];
  state.redo = [];
  state.dirty = !!restored;
  state.saveFailed = false;
  state.original = snapshot(alphaTab, original);
  state.toolTrack = null;

  // The song's remembered view: which tracks were shown and which bars.
  const view = key ? songView(key) : null;
  const valid = (list) => Array.isArray(list) && list.length && list.every((i) => Number.isInteger(i) && score.tracks[i]);
  if (view && valid(view.visible) && !explicitTrack) state.visible = [...view.visible];
  else state.visible = [score.tracks[preferredTrack] ? preferredTrack : 0];
  state.range = view && view.range && !explicitTrack ? { from: view.range.from || 1, to: view.range.to || 0 } : { from: 1, to: 0 };
  showEditedBanner(restored);
  state.muted.clear();
  state.soloed.clear();
  state.endTime = 0;
  setStatus(null);
  setStatus(null, 'info', $('viewer-status'));

  $('export-json').parentElement.hidden = !state.bundle;
  updateSongHead();
  syncRange();
  buildTrackList();
  showWarnings(warnings);
  updateTransportTime(0, 0);
  showView('score');
  $('play-btn').disabled = false;
  $('tip').hidden = options.tipDismissed;
  prepareSound();
  state.scrollToTop = true;
  render();
  return true;
}

// ---------------------------------------------------------------------------
// Saved edits
// ---------------------------------------------------------------------------

const SAVE_DELAY_MS = 700;

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushSave(), SAVE_DELAY_MS);
}

/** Writes (or clears) the saved edits for the current song now. */
async function flushSave() {
  if (!state.saveTimer) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  if (!state.key || !state.score) return;
  try {
    if (state.dirty) {
      const json = withCleanScore(() => alphaTab.model.JsonConverter.scoreToJson(state.score));
      await saveEdits({
        key: state.key,
        json,
        title: state.score.title,
        artist: state.score.artist,
        url: state.sourceUrl,
        savedAt: Date.now()
      });
    } else {
      await deleteEdits(state.key);
    }
    state.saveFailed = false;
  } catch (err) {
    console.warn('Saving edits failed', err);
    if (!state.saveFailed) toast("Your changes couldn't be saved in this browser. Download Guitar Pro to keep them.");
    state.saveFailed = true;
  }
}

function rememberView() {
  if (!state.key || !state.score) return;
  rememberSongView(state.key, { visible: [...state.visible], range: { ...state.range } });
}

function timeAgo(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `on ${new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function showEditedBanner(saved) {
  const banner = $('edited-banner');
  banner.hidden = !saved;
  if (saved) banner.querySelector('span').textContent = `This is your edited version, saved ${timeAgo(saved.savedAt)}.`;
}

// ---------------------------------------------------------------------------
// Sidebar: song info and tracks
// ---------------------------------------------------------------------------

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateSongHead() {
  const score = state.score;
  $('song-title').textContent = score.title || 'Untitled';
  $('song-artist').textContent = score.artist || '';
  document.title = `${score.title || 'Untitled'}${score.artist ? ` by ${score.artist}` : ''}${state.dirty ? ' (edited)' : ''} · Tab to Sheet`;
  updateSongMeta();
}

function updateSongMeta() {
  const score = state.score;
  const first = score.masterBars[0];
  const parts = [];
  const tempo = first?.tempoAutomations?.[0]?.value || score.tempo;
  if (tempo) parts.push(`${Math.round(tempo)} bpm`);
  if (first) parts.push(`${first.timeSignatureNumerator}/${first.timeSignatureDenominator}`);
  parts.push(`${score.masterBars.length} bars`);
  if (state.endTime) parts.push(formatTime(state.endTime));
  $('song-meta').textContent = parts.join(' · ');
}

function describeTrack(track) {
  const staff = track.staves[0];
  if (!staff) return '';
  if (staff.isPercussion) return 'Drums';
  if (!staff.tuning.length) return 'Notation';
  const preset = alphaTab.model.Tuning.findTuning(staff.tuning);
  const names = [...staff.tuning].reverse().map((v) => alphaTab.model.Tuning.getTextForTuning(v, false)).join(' ');
  const tuning = preset && preset.name ? preset.name.replace(/ Tuning$/i, '') : names;
  const capo = staff.capo ? ` · capo ${staff.capo}` : '';
  return `${staff.tuning.length} strings · ${tuning}${capo}`;
}

function buildTrackList() {
  syncTools();
  const list = $('track-list');
  list.replaceChildren();
  state.score.tracks.forEach((track, index) => {
    const li = document.createElement('li');

    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.visible.includes(index);
    box.addEventListener('change', () => {
      if (!box.checked && state.visible.length === 1) {
        box.checked = true; // keep at least one track on the page
        toast('At least one track has to be shown');
        return;
      }
      state.visible = box.checked ? [...state.visible, index] : state.visible.filter((i) => i !== index);
      render();
      rememberView();
      editUI.afterScoreChange();
    });
    const names = document.createElement('span');
    names.className = 'names';
    names.append(
      Object.assign(document.createElement('span'), { className: 'name', textContent: track.name || `Track ${index + 1}` }),
      Object.assign(document.createElement('span'), { className: 'sub', textContent: describeTrack(track) })
    );
    label.append(box, names);
    if (track.staves.some(canConvertToFourString)) {
      const convert = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'linklike track-action',
        textContent: 'Make 4-string'
      });
      convert.title = 'Convert this bass to standard 4-string (E A D G)';
      convert.addEventListener('click', (e) => {
        e.preventDefault(); // don't toggle the checkbox around it
        e.stopPropagation();
        runConvert(index);
      });
      names.append(convert);
    }

    const mute = trackToggle(state.muted.has(index) ? 'i-muted' : 'i-volume', 'Mute', state.muted.has(index), () => {
      const on = !state.muted.has(index);
      on ? state.muted.add(index) : state.muted.delete(index);
      mute.querySelector('use').setAttribute('href', on ? '#i-muted' : '#i-volume');
      api.changeTrackMute([track], on);
      return on;
    });
    const solo = trackToggle('i-headphones', 'Solo', state.soloed.has(index), () => {
      const on = !state.soloed.has(index);
      on ? state.soloed.add(index) : state.soloed.delete(index);
      api.changeTrackSolo([track], on);
      return on;
    });
    li.append(label, mute, solo);
    list.append(li);
  });
}

function trackToggle(icon, title, pressed, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn small toggle';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-pressed', String(pressed));
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}" /></svg>`;
  button.addEventListener('click', () => button.setAttribute('aria-pressed', String(onToggle())));
  return button;
}

// ---------------------------------------------------------------------------
// Rendering options
// ---------------------------------------------------------------------------

// alphaTab draws section names and chord names in the same row, so a bar that
// has both prints them on top of each other. For display we hide the section
// row and show section names as beat text instead (that row stacks properly).
// The text is removed again before exporting so files keep real sections.
const sectionLabels = new Map(); // beat -> original text

function unlabelSections() {
  for (const [beat, original] of sectionLabels) beat.text = original;
  sectionLabels.clear();
}

function labelSections() {
  unlabelSections();
  if (!options.sections) return;
  const track = state.score.tracks[Math.min(...state.visible)];
  const staff = track && track.staves[0];
  if (!staff) return;
  for (const masterBar of state.score.masterBars) {
    if (!masterBar.section) continue;
    const beat = staff.bars[masterBar.index]?.voices[0]?.beats[0];
    const section = masterBar.section;
    const name = section.marker ? `[${section.marker}] ${section.text}` : section.text;
    if (!beat || !name) continue;
    sectionLabels.set(beat, beat.text);
    beat.text = beat.text ? `${name} · ${beat.text}` : name;
  }
}

function withCleanScore(fn) {
  unlabelSections();
  try {
    return fn();
  } finally {
    labelSections();
  }
}

function applyStaffOptions() {
  const view = options.view;
  for (const track of state.score.tracks) {
    for (const staff of track.staves) {
      const stringed = !staff.isPercussion && staff.tuning.length > 0;
      staff.showTablature = stringed && view !== 'notes';
      staff.showStandardNotation = view !== 'tab' || !stringed;
      staff.showSlash = options.slash;
      staff.showNumbered = false;
    }
  }
}

function applySettings() {
  const s = api.settings;
  s.display.layoutMode = options.layout === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
  s.display.barsPerRow = Number(options.barsPerRow) || -1;
  s.display.scale = options.zoom / 100;
  const last = state.score ? state.score.masterBars.length : 1;
  const from = Math.min(Math.max(1, state.range.from), last);
  const to = state.range.to ? Math.min(Math.max(from, state.range.to), last) : last;
  s.display.startBar = from;
  s.display.barCount = from === 1 && to === last ? -1 : to - from + 1;
  s.notation.rhythmMode =
    options.view === 'tab' && options.rhythm ? alphaTab.TabRhythmMode.ShowWithBars : alphaTab.TabRhythmMode.Hidden;
  s.notation.elements.set(alphaTab.NotationElement.EffectChordNames, options.chords);
  s.notation.elements.set(alphaTab.NotationElement.EffectTempo, options.tempo);
  s.notation.elements.set(alphaTab.NotationElement.EffectDynamics, options.dynamics);
  if (state.score) {
    // Full instrument names on the first line, short ones ("El. Gtr.") after, like a printed score.
    const sheet = state.score.stylesheet;
    const { TrackNameMode, TrackNameOrientation, TrackNamePolicy } = alphaTab.model;
    sheet.firstSystemTrackNameMode = TrackNameMode.FullName;
    // Sideways on narrow screens, where every bit of width counts.
    const wide = $('stage').clientWidth >= 700;
    sheet.firstSystemTrackNameOrientation = wide ? TrackNameOrientation.Horizontal : TrackNameOrientation.Vertical;
    sheet.otherSystemsTrackNameMode = TrackNameMode.ShortName;
    sheet.otherSystemsTrackNameOrientation = wide ? TrackNameOrientation.Horizontal : TrackNameOrientation.Vertical;
    sheet.singleTrackTrackNamePolicy = TrackNamePolicy.FirstSystem;
    sheet.multiTrackTrackNamePolicy = TrackNamePolicy.AllSystems;
  }
  document.body.classList.toggle('horizontal', options.layout === 'horizontal');
}

function render() {
  if (!state.score) return;
  applyStaffOptions();
  labelSections();
  applySettings();
  api.updateSettings();
  api.renderScore(state.score, [...state.visible].sort((a, b) => a - b));
  applyTrackAudio();
}

/** Mute and solo per track, plus "play only shown tracks". */
function applyTrackAudio() {
  if (!state.score) return;
  const tracks = state.score.tracks;
  const silent = tracks.filter((t, i) => state.muted.has(i) || (options.onlyShown && !state.visible.includes(i)));
  const audible = tracks.filter((t) => !silent.includes(t));
  if (silent.length) api.changeTrackMute(silent, true);
  if (audible.length) api.changeTrackMute(audible, false);
  const soloed = [...state.soloed].map((i) => tracks[i]).filter(Boolean);
  if (soloed.length) api.changeTrackSolo(soloed, true);
}

// ---------------------------------------------------------------------------
// Bars shown
// ---------------------------------------------------------------------------

function syncRange() {
  const last = state.score ? state.score.masterBars.length : 1;
  for (const id of ['range-from', 'range-to']) $(id).max = String(last);
  $('range-from').value = String(Math.min(state.range.from, last));
  $('range-to').value = String(state.range.to ? Math.min(state.range.to, last) : last);
  $('range-all').disabled = state.range.from === 1 && !state.range.to;
}

function setRange(from, to) {
  const last = state.score.masterBars.length;
  const a = Math.min(Math.max(1, Math.round(from) || 1), last);
  const b = Math.min(Math.max(a, Math.round(to) || last), last);
  state.range = { from: a, to: b === last ? 0 : b };
  rememberView();
  syncRange();
  syncTools();
  relayout();
}

// ---------------------------------------------------------------------------
// Fingering tools
// ---------------------------------------------------------------------------

function stringedTracks() {
  return state.score.tracks.filter((t) => t.staves.some((s) => !s.isPercussion && s.tuning.length > 0));
}

function syncTools() {
  if (!state.score) return;
  const tracks = stringedTracks();
  $('fingering-panel').hidden = tracks.length === 0;
  if (!tracks.length) return;
  const select = $('tool-track');
  select.replaceChildren(
    ...tracks.map((t) => Object.assign(document.createElement('option'), { value: String(t.index), textContent: t.name }))
  );
  // The user's pick, else a bass that can be converted, else a shown track.
  const preferred =
    tracks.find((t) => t.index === state.toolTrack) ||
    tracks.find((t) => t.staves.some(canConvertToFourString)) ||
    tracks.find((t) => state.visible.includes(t.index)) ||
    tracks[0];
  select.value = String(preferred.index);
  updateToolButtons();
}

function updateToolButtons() {
  const track = state.score.tracks[Number($('tool-track').value)];
  if (!track) return;
  const blocker = fourStringBlocker(track);
  const hasStrings = track.staves.some((s) => !s.isPercussion && s.tuning.length > 0);
  $('tool-convert').hidden = !hasStrings;
  $('tool-convert').disabled = !!blocker;
  $('lownotes-field').hidden = !hasStrings || !!blocker;
  $('tool-convert').title = blocker || 'Convert this bass to standard 4-string (E A D G)';
  const last = state.score.masterBars.length;
  const to = state.range.to || last;
  const scope = state.range.from === 1 && to === last ? 'every bar' : `bars ${state.range.from} to ${to} (the bars shown)`;
  $('tool-note').textContent =
    `Keeps every note's pitch and moves notes to where they're easiest to play: one finger per fret, shifting only when there's time, and repeated bars fingered the same way. Works on ${scope}.` +
    (blocker && track.staves.some((s) => s.tuning.length > 0) ? ` ${blocker}` : '');
}

function toolRange() {
  return { fromBar: state.range.from - 1, toBar: state.range.to ? state.range.to - 1 : Infinity };
}

function runOptimize() {
  const index = Number($('tool-track').value);
  let result = null;
  commitEdit((score, m) => {
    result = optimizeFingering(m, score, index, { ...toolRange(), maxFret: options.maxFret, style: options.fingerStyle });
    return editUI.selection() ?? undefined;
  });
  if (!result) return;
  const name = state.score.tracks[index].name;
  const shifts = (n) => `${n} hand shift${n === 1 ? '' : 's'}`;
  if (result.changed === 0) toast(`${name} already uses the easiest positions (${shifts(result.shiftsAfter)})`);
  else {
    const change =
      result.shiftsAfter < result.shiftsBefore
        ? `Hand shifts: ${result.shiftsBefore} → ${result.shiftsAfter}`
        : `${shifts(result.shiftsAfter)}, with more comfortable positions`;
    toast(`Moved ${result.changed} notes in ${name}. ${change}`, { label: 'Undo', run: undoEdit });
  }
  ensureVisible(index);
}

function runConvert(index = Number($('tool-track').value)) {
  let report = null;
  commitEdit((score, m) => {
    report = convertToFourStringBass(m, score, index, { maxFret: options.maxFret, lowNotes: options.lowNotes, style: options.fingerStyle });
    return editUI.selection() ?? undefined;
  });
  if (!report) return;
  const parts = ['Converted to 4-string bass (E A D G)'];
  if (report.phrasesUp) parts.push(`${report.phrasesUp} riff${report.phrasesUp === 1 ? '' : 's'} moved up an octave to stay in shape`);
  else if (report.octaveUp) parts.push(`${report.octaveUp} low note${report.octaveUp === 1 ? '' : 's'} moved up an octave`);
  if (report.octaveDown) parts.push(`${report.octaveDown} high note${report.octaveDown === 1 ? '' : 's'} moved down an octave`);
  if (report.dropped) parts.push(`${report.dropped} note${report.dropped === 1 ? '' : 's'} left out (too many at once)`);
  toast(parts.join('. '), { label: 'Undo', run: undoEdit });
  ensureVisible(index);
}

/** Shows the track that was just changed, so the result is on screen. */
function ensureVisible(index) {
  if (state.visible.includes(index)) return;
  state.visible = [...state.visible, index];
  buildTrackList();
  render();
}

// ---------------------------------------------------------------------------
// Editing: history and score replacement
// ---------------------------------------------------------------------------

function replaceScore(score, selection) {
  state.score = score;
  state.visible = state.visible.filter((i) => i < score.tracks.length);
  if (state.visible.length === 0) state.visible = [0];
  updateSongHead();
  buildTrackList();
  syncRange();
  render();
  editUI.afterScoreChange(selection);
}

// Each history entry remembers whether the song differed from the original
// at that point, so undo/redo/revert always know whether to keep or clear
// the saved edits.
function historyEntry() {
  return { snap: snapshot(alphaTab, state.score), dirty: state.dirty };
}

function commitEdit(fn, { merge = false } = {}) {
  if (!state.score) return;
  unlabelSections();
  const before = historyEntry();
  let selection;
  try {
    selection = fn(state.score, alphaTab.model);
  } catch (err) {
    console.error(err);
    toast(`That edit didn't work: ${err.message || err}`);
    // The model may be half-changed; go back to the snapshot.
    replaceScore(restore(alphaTab, before.snap, api.settings));
    return;
  }
  if (!merge || state.undo.length === 0) {
    state.undo.push(before);
    if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  }
  state.redo = [];
  state.dirty = true;
  replaceScore(rebuildScore(alphaTab, state.score, api.settings), selection);
  afterHistoryChange();
}

function undoEdit() {
  if (!state.undo.length) return;
  unlabelSections();
  state.redo.push(historyEntry());
  const entry = state.undo.pop();
  replaceScore(restore(alphaTab, entry.snap, api.settings));
  state.dirty = entry.dirty;
  afterHistoryChange();
}

function redoEdit() {
  if (!state.redo.length) return;
  unlabelSections();
  state.undo.push(historyEntry());
  const entry = state.redo.pop();
  replaceScore(restore(alphaTab, entry.snap, api.settings));
  state.dirty = entry.dirty;
  afterHistoryChange();
}

function revertEdits() {
  if (!state.original) return;
  unlabelSections();
  state.undo.push(historyEntry());
  state.redo = [];
  // Restore from a copy so the original snapshot stays reusable.
  replaceScore(restore(alphaTab, snapshot(alphaTab, restore(alphaTab, state.original, api.settings)), api.settings));
  state.dirty = false;
  afterHistoryChange();
  toast('Back to the original song', { label: 'Undo', run: undoEdit });
}

function afterHistoryChange() {
  if (!state.dirty) showEditedBanner(null);
  updateSongHead();
  editUI.refreshPanel();
  scheduleSave();
}

const editUI = createEditUI({
  alphaTab,
  api,
  $,
  toast: (message) => toast(message),
  score: () => state.score,
  visible: () => state.visible,
  commit: commitEdit,
  undo: undoEdit,
  redo: redoEdit,
  revert: revertEdits,
  canUndo: () => state.undo.length > 0,
  canRedo: () => state.redo.length > 0,
  isDirty: () => state.dirty
});

function relayout() {
  if (!state.score) return;
  applySettings();
  api.updateSettings();
  api.render();
}

function syncControls() {
  document.querySelector(`input[name="view"][value="${options.view}"]`).checked = true;
  document.querySelector(`input[name="layout"][value="${options.layout}"]`).checked = true;
  $('opt-rhythm').checked = options.rhythm;
  $('opt-rhythm').disabled = options.view !== 'tab';
  $('opt-slash').checked = options.slash;
  $('opt-chords').checked = options.chords;
  $('opt-sections').checked = options.sections;
  $('opt-tempo').checked = options.tempo;
  $('opt-dynamics').checked = options.dynamics;
  $('opt-bars').value = String(options.barsPerRow);
  $('opt-bars').disabled = options.layout === 'horizontal';
  $('opt-zoom').value = String(options.zoom);
  $('zoom-value').textContent = `${options.zoom}%`;
  $('opt-paper').value = options.paper;
  setSpeedSelect(options.speed);
  $('opt-countin').checked = options.countIn;
  $('opt-metronome').checked = options.metronome;
  $('opt-loop').checked = options.loop;
  $('opt-trainer').checked = options.trainer;
  $('trainer-start').value = String(options.trainerStart);
  $('trainer-step').value = String(options.trainerStep);
  $('trainer-target').value = String(options.trainerTarget);
  $('loop-btn').setAttribute('aria-pressed', String(options.loop));
  $('metronome-btn').setAttribute('aria-pressed', String(options.metronome));
  $('countin-btn').setAttribute('aria-pressed', String(options.countIn));
  const soundInput = document.querySelector(`input[name="sound"][value="${options.sound}"]`);
  if (soundInput) soundInput.checked = true;
  $('opt-only-shown').checked = options.onlyShown;
  $('volume').value = String(options.volume);
  $('opt-frets').value = String(options.maxFret);
  $('opt-fingerstyle').value = options.fingerStyle;
  $('opt-lownotes').value = options.lowNotes;
  updateSoundStatus();

}

function setOption(key, value, how = 'render') {
  options[key] = value;
  saveOptions();
  syncControls();
  if (how === 'render') render();
  else if (how === 'layout') relayout();
}

function zoomBy(step) {
  const next = Math.min(160, Math.max(60, options.zoom + step));
  if (next !== options.zoom) setOption('zoom', next, 'layout');
}

// ---------------------------------------------------------------------------
// Print, export, share
// ---------------------------------------------------------------------------

function safeFileName() {
  const s = state.score;
  const base = [s.artist, s.title].filter(Boolean).join(' - ') || 'score';
  return base.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 120) || 'score';
}

function download(data, fileName, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportAs(kind) {
  if (!state.score) return;
  const name = safeFileName();
  try {
    withCleanScore(() => {
      switch (kind) {
        case 'gp':
          download(new alphaTab.exporter.Gp7Exporter().export(state.score, api.settings), `${name}.gp`, 'application/octet-stream');
          break;
        case 'midi':
          api.downloadMidi();
          break;
        case 'tex':
          download(new alphaTab.exporter.AlphaTexExporter().exportToString(state.score, api.settings), `${name}.atex`, 'text/plain');
          break;
        case 'json':
          if (state.bundle) download(JSON.stringify(state.bundle), `${name}.json`, 'application/json');
          if (state.dirty) toast('Songsterr data is the original song. Download Guitar Pro to keep your edits.');
          break;
      }
    });
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message || err}`);
  }
}

function printScore() {
  if (!state.score) return;
  api.pause();
  try {
    // Always print as pages, whatever the on-screen layout.
    api.print(PAPER_WIDTHS[options.paper] || PAPER_WIDTHS.a4, { display: { layoutMode: alphaTab.LayoutMode.Page } });
  } catch (err) {
    // Pop-up blocked: print the page itself, which hides everything but the score.
    console.warn('Print window blocked, printing the page instead', err);
    window.print();
  }
}

async function copyLink() {
  const url = new URL(window.location.href);
  url.search = '';
  if (state.sourceUrl) url.searchParams.set('url', state.sourceUrl);
  try {
    await navigator.clipboard.writeText(url.href);
    if (state.dirty) toast('Link copied. It opens the original song; download Guitar Pro to share your edits.');
    else toast(state.sourceUrl ? 'Link copied' : 'Link copied (files you opened yourself are not included)');
  } catch {
    window.prompt('Copy this link:', url.href);
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function updateTransportTime(current, end) {
  $('time-current').textContent = formatTime(current);
  $('time-total').textContent = formatTime(end);
  if (!state.seeking) $('seek').value = end ? String(Math.round((current / end) * 1000)) : '0';
}

function applyPlayerOptions() {
  api.playbackSpeed = options.speed / 100;
  api.isLooping = options.loop;
  api.metronomeVolume = options.metronome ? 1 : 0;
  api.countInVolume = options.countIn ? 1 : 0;
  api.masterVolume = Math.max(0, Math.min(1, options.volume / 100));
}

// Speed and the speed trainer -------------------------------------------------

const SPEED_STEPS = [...$('speed').options].map((o) => Number(o.value));

/** Shows a speed in the menu, adding it as an option if it isn't one already. */
function setSpeedSelect(value) {
  const select = $('speed');
  if (![...select.options].some((o) => Number(o.value) === value)) {
    const option = Object.assign(document.createElement('option'), { value: String(value), textContent: `${value}%` });
    const after = [...select.options].find((o) => Number(o.value) > value);
    select.insertBefore(option, after || null);
  }
  select.value = String(value);
}

function setSpeed(value) {
  const speed = Math.max(25, Math.min(150, Math.round(value)));
  options.speed = speed;
  saveOptions();
  setSpeedSelect(speed);
  api.playbackSpeed = speed / 100;
  updateTrainerStatus();
}

function stepSpeed(direction) {
  const current = options.speed;
  const next = direction > 0 ? SPEED_STEPS.find((v) => v > current) : [...SPEED_STEPS].reverse().find((v) => v < current);
  if (next) {
    setSpeed(next);
    toast(`Speed ${next}%`);
  }
}

function setTrainer(on) {
  setOption('trainer', on, 'none');
  if (on) {
    // The trainer works on a loop, starting from its start speed.
    if (!options.loop) setOption('loop', true, 'none');
    applyPlayerOptions();
    setSpeed(options.trainerStart);
  }
  updateTrainerStatus();
}

function updateTrainerStatus() {
  const el = $('trainer-status');
  if (!el) return;
  if (!options.trainer) {
    el.textContent = '';
    return;
  }
  el.textContent =
    options.speed >= options.trainerTarget
      ? `Reached ${options.trainerTarget}%. Nice work.`
      : `Now ${options.speed}%. Adds ${options.trainerStep}% each time through, up to ${options.trainerTarget}%.`;
}

/** Called when a loop starts over: the trainer speeds things up. */
function onLoopRepeat() {
  if (!options.trainer || options.speed >= options.trainerTarget) return;
  const next = Math.min(options.trainerTarget, options.speed + options.trainerStep);
  setSpeed(next);
  toast(next >= options.trainerTarget ? `Speed ${next}%: target reached` : `Speed ${next}%`);
}

// Sounds ---------------------------------------------------------------------
// Playback has to start the moment Play is pressed. The small set (1.3 MB)
// loads as soon as a song opens and is ready almost instantly. The better
// set (32 MB) downloads in the background and is swapped in only while
// nothing is playing, because loading it into the synthesizer takes about a
// second and would otherwise interrupt the music.

const sound = {
  active: null, // set currently in the synthesizer: 'small' | 'better'
  activating: null, // { set, promise } while a set is being unpacked
  betterBytes: null, // the downloaded better set, waiting to be swapped in
  betterState: 'idle', // idle | downloading | ready | failed
  betterProgress: 0,
  wantPlay: false,
  swapTimer: 0
};

const isPlaying = () => api.playerState === alphaTab.synth.PlayerState.Playing;

/** Save-Data or a slow mobile connection: don't download 32 MB unasked. */
function slowConnection() {
  const c = navigator.connection;
  return !!c && (c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType || ''));
}

function whenIdle(fn) {
  if ('requestIdleCallback' in window) requestIdleCallback(() => fn(), { timeout: 3000 });
  else setTimeout(fn, 1200);
}

function setPlayerStatus(text) {
  $('player-status').textContent = text;
  $('play-btn').classList.toggle('busy', !!text);
}

function updateSoundStatus() {
  const el = $('sound-status');
  if (!el) return;
  let text;
  if (options.sound === 'small') text = 'Using the small sounds.';
  else if (sound.active === 'better') text = 'Using the better sounds.';
  else if (sound.activating?.set === 'better') text = 'Loading the better sounds…';
  else if (sound.betterState === 'downloading') text = `Downloading the better sounds (${Math.round(sound.betterProgress * 100)}%). Until then the small sounds play.`;
  else if (sound.betterState === 'ready') text = 'The better sounds are ready and switch in when playback pauses.';
  else if (sound.betterState === 'failed') text = "The better sounds couldn't download, so the small sounds are used.";
  else if (slowConnection()) text = 'On this connection the better sounds download only after you press play.';
  else text = 'The better sounds download in the background once a song is open.';
  el.textContent = text;
}

/** Loads a set into the synthesizer. */
function activate(set, bytes) {
  if (sound.activating?.set === set) return sound.activating.promise;
  const promise = new Promise((resolve) => {
    const off = api.soundFontLoaded.on(() => {
      off?.();
      resolve();
    });
    api.loadSoundFont(bytes, false);
  }).then(() => {
    sound.active = set;
    sound.activating = null;
    if (set === 'better') sound.betterBytes = null; // the synthesizer has its own copy
    updateSoundStatus();
    startIfWanted();
  });
  sound.activating = { set, promise };
  updateSoundStatus();
  return promise;
}

async function activateSmall() {
  try {
    const bytes = await fetchSound(asset(SOUND_SETS.small.path));
    if (sound.active || sound.activating) return; // something else got there first
    await activate('small', bytes);
  } catch (err) {
    console.warn('Loading sounds failed', err);
    sound.wantPlay = false;
    setPlayerStatus('');
    toast(`Playback isn't available: ${err.message || err}`);
  }
}

async function downloadBetter() {
  if (options.sound !== 'better' || sound.betterState === 'downloading' || sound.betterState === 'ready') return;
  if (sound.active === 'better') return;
  sound.betterState = 'downloading';
  updateSoundStatus();
  try {
    sound.betterBytes = await fetchSound(asset(SOUND_SETS.better.path), (loaded, total) => {
      if (!total) return;
      sound.betterProgress = loaded / total;
      updateSoundStatus();
    });
    sound.betterState = 'ready';
  } catch (err) {
    console.warn('Better sounds unavailable', err);
    sound.betterState = 'failed';
  }
  updateSoundStatus();
  swapToBetterWhenQuiet();
}

/** Swaps the better set in, but never while music is playing. */
function swapToBetterWhenQuiet(delay = 0) {
  clearTimeout(sound.swapTimer);
  sound.swapTimer = setTimeout(() => {
    if (options.sound !== 'better' || sound.betterState !== 'ready' || !sound.betterBytes) return;
    if (sound.active === 'better' || sound.activating || isPlaying()) return;
    activate('better', sound.betterBytes);
  }, delay);
}

function startIfWanted() {
  if (!sound.wantPlay || sound.activating || !sound.active || !api.isReadyForPlayback) return;
  sound.wantPlay = false;
  setPlayerStatus('');
  api.play();
}

/** Called when a song opens: get playback ready before anyone presses Play. */
async function prepareSound() {
  if (!sound.active && !sound.activating) {
    const betterUrl = asset(SOUND_SETS.better.path);
    if (options.sound === 'better' && (await isSoundCached(betterUrl))) {
      // Stored from an earlier visit: unpack it now, while the music is being read.
      await downloadBetter();
      if (!sound.active && !sound.activating) activateSmall();
    } else {
      activateSmall();
    }
  }
  if (options.sound === 'better' && sound.betterState === 'idle' && !slowConnection()) whenIdle(downloadBetter);
}

/** Play/pause. Starts at once whenever any sounds are loaded. */
let lastToggle = 0;
let pendingToggle = 0;
function togglePlay() {
  if (!state.score) return;
  // The audio engine can't pause sound that hasn't started yet, so a second
  // press right after the first waits for a quarter second to pass (and a
  // third press cancels it again).
  const wait = 250 - (performance.now() - lastToggle);
  if (wait > 0) {
    if (pendingToggle) {
      clearTimeout(pendingToggle);
      pendingToggle = 0;
    } else {
      pendingToggle = setTimeout(() => {
        pendingToggle = 0;
        togglePlay();
      }, wait);
    }
    return;
  }
  lastToggle = performance.now();
  if (sound.active && !sound.activating && api.isReadyForPlayback) {
    clearTimeout(sound.swapTimer);
    api.playPause();
    return;
  }
  sound.wantPlay = true;
  setPlayerStatus(sound.activating?.set === 'better' ? 'Loading sounds…' : 'Getting sounds ready…');
  if (!sound.active && !sound.activating) activateSmall();
  if (options.sound === 'better' && sound.betterState === 'idle') downloadBetter();
}

/** The sound choice changed in the Playback panel. */
function soundChoiceChanged() {
  updateSoundStatus();
  if (options.sound === 'small') {
    if (sound.active === 'better' && !isPlaying()) {
      sound.active = null;
      activateSmall();
    }
  } else if (sound.betterState === 'ready') {
    swapToBetterWhenQuiet();
  } else {
    downloadBetter();
  }
}

api.playerReady.on(() => {
  for (const id of ['stop-btn', 'seek']) $(id).disabled = false;
  applyPlayerOptions();
  startIfWanted();
});
api.playerStateChanged.on((e) => {
  const playing = e.state === alphaTab.synth.PlayerState.Playing;
  if (playing) document.body.classList.remove('cursor-idle');
  // Paused or stopped: a good moment to bring in the better sounds (after a
  // short wait, so a quick pause-and-resume isn't interrupted).
  if (!playing) swapToBetterWhenQuiet(1500);
  $('play-btn').classList.toggle('playing', playing);
  $('play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
});
let lastTick = 0;
let userSeekAt = 0; // clicks in the music and the seek bar also move the position back
$('score').addEventListener(
  'pointerdown',
  () => {
    userSeekAt = Date.now();
    document.body.classList.remove('cursor-idle');
  },
  true
);
api.playerPositionChanged.on((e) => {
  // A loop starting over shows up as the position jumping backwards while playing.
  const jumpedBack = e.currentTick + 960 < lastTick;
  if (jumpedBack && options.loop && isPlaying() && Date.now() - userSeekAt > 600) onLoopRepeat();
  lastTick = e.currentTick;
  if (e.currentTick > 120) document.body.classList.remove('cursor-idle'); // the player reports tick 1 on load
  if (e.endTime && Math.abs(e.endTime - state.endTime) > 500) {
    state.endTime = e.endTime;
    updateSongMeta();
  }
  updateTransportTime(e.currentTime, e.endTime);
});
api.renderStarted.on(() => ($('render-progress').hidden = false));
api.renderFinished.on(() => {
  $('render-progress').hidden = true;
  if (state.scrollToTop) {
    state.scrollToTop = false;
    $('stage').scrollTop = 0;
  }
});
api.error.on((err) => {
  console.error(err);
  setStatus(`Something went wrong while drawing the score: ${err.message || err}`, 'error', $('viewer-status'));
});

// ---------------------------------------------------------------------------
// Recent songs
// ---------------------------------------------------------------------------

function relativeDate(time) {
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderRecent() {
  const songs = recentSongs();
  const list = $('recent-list');
  list.replaceChildren();
  $('recent').hidden = songs.length === 0;
  for (const song of songs) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    open.append(
      Object.assign(document.createElement('span'), { className: 't', textContent: song.title }),
      Object.assign(document.createElement('span'), { className: 'a', textContent: song.artist }),
      Object.assign(document.createElement('span'), { className: 'd', textContent: relativeDate(song.at) })
    );
    open.addEventListener('click', () => openLink(song.url));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn small';
    remove.setAttribute('aria-label', `Remove ${song.title} from recent`);
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close" /></svg>';
    remove.addEventListener('click', () => {
      forgetSong(song.url);
      renderRecent();
    });
    li.dataset.url = song.url;
    li.append(open, remove);
    list.append(li);
  }
  // Mark songs that have saved edits.
  editedKeys().then((keys) => {
    for (const li of list.children) {
      if (!keys.has(li.dataset.url) || li.querySelector('.edited-tag')) continue;
      const tag = Object.assign(document.createElement('span'), { className: 'edited-tag', textContent: 'edited' });
      li.querySelector('.a').after(tag);
    }
  });
}

// ---------------------------------------------------------------------------
// Mobile sidebar
// ---------------------------------------------------------------------------

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-toggle').setAttribute('aria-expanded', 'false');
}

const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

$('sidebar-toggle').addEventListener('click', () => {
  if (isNarrow()) {
    const open = !$('sidebar').classList.contains('open');
    $('sidebar').classList.toggle('open', open);
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    return;
  }
  // Desktop: hide or show the panel to give the music the whole width.
  setOption('panelHidden', !options.panelHidden, 'none');
  applyPanelVisibility();
  requestAnimationFrame(() => api.render());
});

function applyPanelVisibility() {
  document.body.classList.toggle('panel-hidden', options.panelHidden);
  if (!isNarrow()) $('sidebar-toggle').setAttribute('aria-expanded', String(!options.panelHidden));
}
$('stage').addEventListener('click', closeSidebar);

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const form of [$('home-search'), $('top-search')]) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    submitQuery(input.value);
    if (form.id === 'top-search') {
      $('home-search-input').value = input.value;
      input.value = '';
      input.blur();
    }
  });
}

for (const input of document.querySelectorAll('.file-input')) {
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) loadFile(file);
    input.value = '';
  });
}

$('demo-btn').addEventListener('click', loadDemo);
$('back-btn').addEventListener('click', () => showView('score', { rerender: true }));
$('home-link').addEventListener('click', (e) => {
  e.preventDefault();
  setStatus(null);
  showView('home');
  history.pushState({ view: 'home' }, '', window.location.pathname);
});
window.addEventListener('popstate', () => {
  const link = new URLSearchParams(window.location.search).get('url');
  if (link && link !== state.sourceUrl) openLink(link, { fromHistory: true }); // another song: load it
  else if (link && state.score) showView('score', { rerender: true });
  else showView('home');
});

for (const input of document.querySelectorAll('input[name="view"]')) {
  input.addEventListener('change', () => setOption('view', input.value));
}
for (const input of document.querySelectorAll('input[name="layout"]')) {
  input.addEventListener('change', () => setOption('layout', input.value, 'layout'));
}
$('opt-rhythm').addEventListener('change', (e) => setOption('rhythm', e.target.checked));
$('opt-slash').addEventListener('change', (e) => setOption('slash', e.target.checked));
$('opt-chords').addEventListener('change', (e) => setOption('chords', e.target.checked, 'layout'));
$('opt-sections').addEventListener('change', (e) => setOption('sections', e.target.checked));
$('opt-tempo').addEventListener('change', (e) => setOption('tempo', e.target.checked, 'layout'));
$('opt-dynamics').addEventListener('change', (e) => setOption('dynamics', e.target.checked, 'layout'));
$('opt-bars').addEventListener('change', (e) => setOption('barsPerRow', Number(e.target.value), 'layout'));
$('opt-zoom').addEventListener('input', (e) => ($('zoom-value').textContent = `${e.target.value}%`));
$('opt-zoom').addEventListener('change', (e) => setOption('zoom', Number(e.target.value), 'layout'));
$('opt-paper').addEventListener('change', (e) => setOption('paper', e.target.value, 'none'));

$('tool-track').addEventListener('change', (e) => {
  state.toolTrack = Number(e.target.value);
  updateToolButtons();
});
$('tool-optimize').addEventListener('click', () => runOptimize());
$('tool-convert').addEventListener('click', () => runConvert());
$('range-from').addEventListener('change', (e) => setRange(Number(e.target.value), state.range.to || state.score.masterBars.length));
$('range-to').addEventListener('change', (e) => setRange(state.range.from, Number(e.target.value)));
$('range-all').addEventListener('click', () => setRange(1, state.score.masterBars.length));
$('edit-toggle').addEventListener('click', () => {
  // On phones, close the options drawer so the score can be tapped.
  closeSidebar();
  editUI.toggle();
});
window.addEventListener('beforeunload', (e) => {
  flushSave();
  if (!state.dirty || !state.saveFailed) return;
  e.preventDefault();
  e.returnValue = '';
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});
$('edited-original').addEventListener('click', () => {
  if (window.confirm('Go back to the original song? Your saved changes will be removed (you can still undo).')) revertEdits();
});

$('print-btn').addEventListener('click', printScore);
for (const button of document.querySelectorAll('[data-export]')) {
  button.addEventListener('click', () => exportAs(button.dataset.export));
}
$('copy-link').addEventListener('click', copyLink);

$('play-btn').addEventListener('click', togglePlay);
$('stop-btn').addEventListener('click', () => api.stop());
$('seek').addEventListener('input', (e) => {
  state.seeking = true;
  $('time-current').textContent = formatTime((Number(e.target.value) / 1000) * state.endTime);
});
$('seek').addEventListener('change', (e) => {
  state.seeking = false;
  userSeekAt = Date.now();
  if (state.endTime) api.timePosition = (Number(e.target.value) / 1000) * state.endTime;
});
$('speed').addEventListener('change', (e) => setSpeed(Number(e.target.value)));

function toggleOption(key) {
  // The trainer needs the loop, so turning the loop off stops the trainer too.
  if (key === 'loop' && options.loop && options.trainer) options.trainer = false;
  setOption(key, !options[key], 'none');
  applyPlayerOptions();
  updateTrainerStatus();
}
for (const input of document.querySelectorAll('input[name="sound"]')) {
  input.addEventListener('change', () => {
    setOption('sound', input.value, 'none');
    soundChoiceChanged();
  });
}
$('opt-only-shown').addEventListener('change', (e) => {
  setOption('onlyShown', e.target.checked, 'none');
  applyTrackAudio();
});
$('volume').addEventListener('input', (e) => {
  options.volume = Number(e.target.value);
  api.masterVolume = options.volume / 100;
});
$('volume').addEventListener('change', saveOptions);
$('opt-frets').addEventListener('change', (e) => setOption('maxFret', Number(e.target.value), 'none'));
$('opt-fingerstyle').addEventListener('change', (e) => setOption('fingerStyle', e.target.value, 'none'));
$('opt-lownotes').addEventListener('change', (e) => setOption('lowNotes', e.target.value, 'none'));

// Pasting a Songsterr link opens it straight away.
for (const input of [$('home-search-input'), $('top-search-input')]) {
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (!isSongsterrLink(text.trim())) return;
    e.preventDefault();
    input.value = text.trim();
    submitQuery(input.value);
    if (input.id === 'top-search-input') input.value = '';
  });
}

// Arrow keys move between search results.
$('home-search-input').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' || $('results').hidden) return;
  const first = $('results').querySelector('button');
  if (first) {
    e.preventDefault();
    first.focus();
  }
});
$('results').addEventListener('keydown', (e) => {
  const buttons = [...$('results').querySelectorAll('button')];
  const i = buttons.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown' && buttons[i + 1]) buttons[i + 1].focus();
  else if (e.key === 'ArrowUp') (buttons[i - 1] || $('home-search-input')).focus();
  else if (e.key === 'Escape') $('home-search-input').focus();
  else return;
  e.preventDefault();
});

// Keyboard shortcuts list.
function openShortcuts() {
  const dialog = $('shortcuts-dialog');
  if (!dialog.open) dialog.showModal();
}
$('shortcuts-open').addEventListener('click', openShortcuts);

// One-time tip in the score view.
$('tip-close').addEventListener('click', () => {
  $('tip').hidden = true;
  setOption('tipDismissed', true, 'none');
});
$('loop-btn').addEventListener('click', () => toggleOption('loop'));
$('opt-loop').addEventListener('change', (e) => {
  const on = e.target.checked;
  if (!on) options.trainer = false; // the trainer needs the loop
  setOption('loop', on, 'none');
  applyPlayerOptions();
  updateTrainerStatus();
});
$('opt-countin').addEventListener('change', (e) => {
  setOption('countIn', e.target.checked, 'none');
  applyPlayerOptions();
});
$('opt-metronome').addEventListener('change', (e) => {
  setOption('metronome', e.target.checked, 'none');
  applyPlayerOptions();
});
$('clear-range').addEventListener('click', () => {
  api.playbackRange = null;
  api.clearPlaybackRangeHighlight?.();
  toast('The whole song will play and loop again');
});
$('opt-trainer').addEventListener('change', (e) => setTrainer(e.target.checked));
for (const id of ['trainer-start', 'trainer-step', 'trainer-target']) {
  $(id).addEventListener('change', () => {
    options.trainerStart = Number($('trainer-start').value);
    options.trainerStep = Number($('trainer-step').value);
    options.trainerTarget = Number($('trainer-target').value);
    saveOptions();
    if (options.trainer) setSpeed(options.trainerStart);
    updateTrainerStatus();
  });
}
$('metronome-btn').addEventListener('click', () => toggleOption('metronome'));
$('countin-btn').addEventListener('click', () => toggleOption('countIn'));

$('relay-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('relay-input').value.trim();
  if (value && !/^https:\/\//i.test(value)) {
    toast('The relay address has to start with https://');
    return;
  }
  prefs.set('relay', value);
  toast(value ? 'Relay saved. Try the link again.' : 'Relay removed');
});
$('relay-input').value = prefs.get('relay', '');

document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'score') return;
  const tag = e.target.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'range'].includes(e.target.type));
  if (typing) return;
  // A control that was last clicked with the mouse shouldn't swallow Space
  // (it should play); keyboard users pressing a control they tabbed to keep
  // the normal behaviour.
  const control = tag === 'BUTTON' || tag === 'INPUT';
  if (control && (e.key === 'Enter' || (e.key === ' ' && !usingPointer))) return;
  // Sliders and option buttons use the arrow keys themselves.
  if (tag === 'INPUT' && e.key.startsWith('Arrow')) return;
  if (editUI.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redoEdit() : undoEdit();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case '?':
      openShortcuts();
      break;
    case 'e':
    case 'E':
      editUI.toggle();
      break;
    case ' ':
      e.preventDefault();
      spaceHandled = true; // stop the focused control reacting on key release
      togglePlay();
      break;
    case 'Escape':
      api.stop();
      closeSidebar();
      break;
    case 'l':
    case 'L':
      toggleOption('loop');
      break;
    case 'm':
    case 'M':
      toggleOption('metronome');
      break;
    case 'c':
    case 'C':
      toggleOption('countIn');
      break;
    case ',':
      stepSpeed(-1);
      break;
    case '.':
      stepSpeed(1);
      break;
    case '+':
    case '=':
      zoomBy(10);
      break;
    case '-':
    case '_':
      zoomBy(-10);
      break;
    case 'p':
    case 'P':
      printScore();
      break;
  }
});

// How the user last interacted: pointer (mouse/touch) or keyboard (Tab).
let usingPointer = true;
let spaceHandled = false;
document.addEventListener('pointerdown', () => (usingPointer = true), true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') usingPointer = false;
}, true);
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && spaceHandled) {
    e.preventDefault();
    spaceHandled = false;
  }
}, true);

// Drag and drop a file anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

setupBookmarklet($('bookmarklet'), asset('./'));
listenForBookmarklet({
  onWaiting: () => setStatus('Waiting for the song from Songsterr...', 'loading'),
  onBundle: (bundle) => showBundle(bundle, { preferredTrack: bundle.trackIndex ?? trackFromLink(bundle.source), sourceUrl: bundle.source }),
  onError: (message) => setStatus(message, 'error')
});

function trackFromLink(link) {
  try {
    return parseSongsterrUrl(link).trackIndex ?? 0;
  } catch {
    return 0;
  }
}

// Sidebar sections remember whether they're open.
const closedPanels = new Set(prefs.get('closedPanels', []));
for (const panel of document.querySelectorAll('details.panel[data-panel]')) {
  if (closedPanels.has(panel.dataset.panel)) panel.open = false;
  panel.addEventListener('toggle', () => {
    panel.open ? closedPanels.delete(panel.dataset.panel) : closedPanels.add(panel.dataset.panel);
    prefs.set('closedPanels', [...closedPanels]);
  });
}

// Start: ?url=<songsterr link>, ?q=<search>, ?demo
syncControls();
applyPanelVisibility();
showView('home');
const params = new URLSearchParams(window.location.search);
if (params.get('url')) {
  $('home-search-input').value = params.get('url');
  openLink(params.get('url'));
} else if (params.get('q')) {
  $('home-search-input').value = params.get('q');
  runSearch(params.get('q'));
} else if (params.has('demo')) {
  loadDemo();
}
