import * as alphaTab from '../vendor/alphatab/alphaTab.mjs';
import { songsterrToScore } from './convert.js';
import { isSongsterrLink, parseSongsterrUrl } from './songsterr.js';
import { loadSong, search } from './sources.js';
import { prefs, recentSongs, rememberSong, forgetSong } from './storage.js';
import { setupBookmarklet, listenForBookmarklet } from './bookmarklet.js';

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
  speed: 100,
  metronome: false,
  countIn: false,
  loop: false
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
  scrollToTop: false
};

// ---------------------------------------------------------------------------
// alphaTab
// ---------------------------------------------------------------------------

const api = new alphaTab.AlphaTabApi($('score'), {
  core: { fontDirectory: asset('vendor/alphatab/font/') },
  display: { layoutMode: alphaTab.LayoutMode.Page },
  player: {
    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
    soundFont: asset('vendor/alphatab/soundfont/sonivox.sf2'),
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
      document.title = `${state.score.title}${state.score.artist ? ` by ${state.score.artist}` : ''} · Tab to Sheet`;
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
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
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

async function openLink(link) {
  const token = ++loadToken;
  showView('home');
  $('results').hidden = true;
  let parsed;
  try {
    parsed = parseSongsterrUrl(link);
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  setStatus('Fetching the tab...', 'loading');
  try {
    const song = await loadSong(link, (message) => token === loadToken && setStatus(message, 'loading'));
    if (token !== loadToken) return;
    showBundle(song, { preferredTrack: parsed.trackIndex ?? song.trackIndex ?? 0, sourceUrl: song.source || link });
  } catch (err) {
    if (token !== loadToken) return;
    console.warn(err);
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

function showBundle(bundle, { preferredTrack = 0, sourceUrl = null } = {}) {
  const { score, warnings } = songsterrToScore(alphaTab, bundle);
  state.bundle = bundle;
  state.sourceUrl = sourceUrl;
  showScore(score, [...(bundle.warnings || []), ...warnings], preferredTrack);
  if (sourceUrl) {
    rememberSong({ url: sourceUrl, title: score.title, artist: score.artist });
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('url', sourceUrl);
    history.pushState({ view: 'score' }, '', url);
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
      showBundle(bundle, { preferredTrack: bundle.trackIndex ?? 0 });
      return;
    }
    state.bundle = null;
    state.sourceUrl = null;
    let score;
    if (/\.(atex|alphatex|txt)$/.test(name)) {
      score = alphaTab.importer.ScoreLoader.loadAlphaTex(await file.text(), api.settings);
    } else {
      score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await file.arrayBuffer()), api.settings);
    }
    if (!score.title) score.title = file.name.replace(/\.[^.]+$/, '');
    showScore(score, []);
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
    showBundle(await res.json());
  } catch (err) {
    setStatus(`Couldn't load the example: ${err.message}`, 'error');
  }
}

function showScore(score, warnings, preferredTrack = 0) {
  api.stop();
  state.score = score;
  state.visible = [score.tracks[preferredTrack] ? preferredTrack : 0];
  state.muted.clear();
  state.soloed.clear();
  state.endTime = 0;
  setStatus(null);
  setStatus(null, 'info', $('viewer-status'));

  $('song-title').textContent = score.title || 'Untitled';
  $('song-artist').textContent = score.artist || '';
  $('export-json').parentElement.hidden = !state.bundle;
  updateSongMeta();
  buildTrackList();
  showWarnings(warnings);
  updateTransportTime(0, 0);
  showView('score');
  state.scrollToTop = true;
  render();
}

// ---------------------------------------------------------------------------
// Sidebar: song info and tracks
// ---------------------------------------------------------------------------

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
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
    });
    const names = document.createElement('span');
    names.className = 'names';
    names.append(
      Object.assign(document.createElement('span'), { className: 'name', textContent: track.name || `Track ${index + 1}` }),
      Object.assign(document.createElement('span'), { className: 'sub', textContent: describeTrack(track) })
    );
    label.append(box, names);

    const mute = trackToggle('i-volume', 'Mute', () => {
      const on = !state.muted.has(index);
      on ? state.muted.add(index) : state.muted.delete(index);
      mute.querySelector('use').setAttribute('href', on ? '#i-muted' : '#i-volume');
      api.changeTrackMute([track], on);
      return on;
    });
    const solo = trackToggle('i-headphones', 'Solo', () => {
      const on = !state.soloed.has(index);
      on ? state.soloed.add(index) : state.soloed.delete(index);
      api.changeTrackSolo([track], on);
      return on;
    });
    li.append(label, mute, solo);
    list.append(li);
  });
}

function trackToggle(icon, title, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn small toggle';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-pressed', 'false');
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
  s.notation.rhythmMode =
    options.view === 'tab' && options.rhythm ? alphaTab.TabRhythmMode.ShowWithBars : alphaTab.TabRhythmMode.Hidden;
  s.notation.elements.set(alphaTab.NotationElement.EffectChordNames, options.chords);
  s.notation.elements.set(alphaTab.NotationElement.EffectTempo, options.tempo);
  document.body.classList.toggle('horizontal', options.layout === 'horizontal');
}

function render() {
  if (!state.score) return;
  applyStaffOptions();
  labelSections();
  applySettings();
  api.updateSettings();
  api.renderScore(state.score, [...state.visible].sort((a, b) => a - b));
}

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
  $('opt-bars').value = String(options.barsPerRow);
  $('opt-bars').disabled = options.layout === 'horizontal';
  $('opt-zoom').value = String(options.zoom);
  $('zoom-value').textContent = `${options.zoom}%`;
  $('opt-paper').value = options.paper;
  $('speed').value = String(options.speed);
  $('speed-value').textContent = `${options.speed}%`;
  $('loop-btn').setAttribute('aria-pressed', String(options.loop));
  $('metronome-btn').setAttribute('aria-pressed', String(options.metronome));
  $('countin-btn').setAttribute('aria-pressed', String(options.countIn));
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
    toast(state.sourceUrl ? 'Link copied' : 'Link copied (files you opened yourself are not included)');
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
}

api.soundFontLoad.on((e) => {
  const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
  $('player-status').textContent = pct < 100 ? `Loading sounds ${pct}%` : '';
});
api.playerReady.on(() => {
  for (const id of ['play-btn', 'stop-btn', 'seek']) $(id).disabled = false;
  $('player-status').textContent = '';
  applyPlayerOptions();
});
api.playerStateChanged.on((e) => {
  const playing = e.state === alphaTab.synth.PlayerState.Playing;
  $('play-btn').classList.toggle('playing', playing);
  $('play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
});
api.playerPositionChanged.on((e) => {
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
    li.append(open, remove);
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// Mobile sidebar
// ---------------------------------------------------------------------------

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-toggle').setAttribute('aria-expanded', 'false');
}

$('sidebar-toggle').addEventListener('click', () => {
  const open = !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', open);
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
});
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
  const params = new URLSearchParams(window.location.search);
  if (params.get('url') && state.score) showView('score', { rerender: true });
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
$('opt-bars').addEventListener('change', (e) => setOption('barsPerRow', Number(e.target.value), 'layout'));
$('opt-zoom').addEventListener('input', (e) => ($('zoom-value').textContent = `${e.target.value}%`));
$('opt-zoom').addEventListener('change', (e) => setOption('zoom', Number(e.target.value), 'layout'));
$('opt-paper').addEventListener('change', (e) => setOption('paper', e.target.value, 'none'));

$('print-btn').addEventListener('click', printScore);
for (const button of document.querySelectorAll('[data-export]')) {
  button.addEventListener('click', () => exportAs(button.dataset.export));
}
$('copy-link').addEventListener('click', copyLink);

$('play-btn').addEventListener('click', () => api.playPause());
$('stop-btn').addEventListener('click', () => api.stop());
$('seek').addEventListener('input', (e) => {
  state.seeking = true;
  $('time-current').textContent = formatTime((Number(e.target.value) / 1000) * state.endTime);
});
$('seek').addEventListener('change', (e) => {
  state.seeking = false;
  if (state.endTime) api.timePosition = (Number(e.target.value) / 1000) * state.endTime;
});
$('speed').addEventListener('input', (e) => {
  options.speed = Number(e.target.value);
  $('speed-value').textContent = `${options.speed}%`;
  api.playbackSpeed = options.speed / 100;
});
$('speed').addEventListener('change', saveOptions);

function toggleOption(key) {
  setOption(key, !options[key], 'none');
  applyPlayerOptions();
}
$('loop-btn').addEventListener('click', () => toggleOption('loop'));
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
  if (document.body.dataset.view !== 'score' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'BUTTON' && e.key === ' ')) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (!$('play-btn').disabled) api.playPause();
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

// Start: ?url=<songsterr link>, ?q=<search>, ?demo
syncControls();
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
