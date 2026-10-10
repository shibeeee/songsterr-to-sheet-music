import * as alphaTab from '/vendor/alphatab/alphaTab.mjs';
import { songsterrToScore } from './convert.js';

const $ = (id) => document.getElementById(id);

const state = {
  score: null,
  bundle: null, // raw Songsterr data, when the score came from Songsterr
  selected: [],
  zoom: 1
};

const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

const api = new alphaTab.AlphaTabApi($('score'), {
  core: { fontDirectory: '/vendor/alphatab/font/' },
  display: { layoutMode: alphaTab.LayoutMode.Page, scale: 1 },
  notation: { rhythmMode: alphaTab.TabRhythmMode.ShowWithBars },
  player: {
    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
    soundFont: '/vendor/alphatab/soundfont/sonivox.sf2',
    enableCursor: true,
    enableUserInteraction: true
  }
});
// Section names are drawn as beat text instead (see labelSections).
api.settings.notation.elements.set(alphaTab.NotationElement.EffectMarker, false);
api.settings.display.resources.elementFonts.set(
  alphaTab.NotationElement.EffectText,
  new alphaTab.model.Font('Georgia, serif', 12, alphaTab.model.FontStyle.Plain, alphaTab.model.FontWeight.Bold)
);
api.updateSettings();

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function setStatus(message, kind = 'info') {
  const el = $('status');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = '';
  if (kind === 'loading') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    el.append(spinner);
  }
  el.append(message);
}

function showWarnings(warnings) {
  const el = $('warnings');
  if (!warnings || warnings.length === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = '';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `${warnings.length} thing${warnings.length === 1 ? '' : 's'} could not be converted exactly`;
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

async function loadFromSongsterr(link) {
  const button = $('convert-btn');
  button.disabled = true;
  setStatus('Fetching the tab from Songsterr...', 'loading');
  try {
    const res = await fetch(`/api/songsterr?url=${encodeURIComponent(link)}`);
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!isJson) {
      throw new Error(
        'The converter server is not running, so Songsterr links cannot be fetched here. Start it with "npm start", or open a file instead.'
      );
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);

    const trackMatch = link.match(/-s\d+t(\d+)/);
    showBundle(body, trackMatch ? Number(trackMatch[1]) : 0);

    const url = new URL(window.location.href);
    url.searchParams.set('url', link);
    history.replaceState(null, '', url);
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    button.disabled = false;
  }
}

function showBundle(bundle, preferredTrack = 0) {
  const { score, warnings } = songsterrToScore(alphaTab, bundle);
  state.bundle = bundle;
  const extra = bundle.warnings || [];
  showScore(score, [...extra, ...warnings], preferredTrack);
}

async function loadFile(file) {
  setStatus(`Opening ${file.name}...`, 'loading');
  try {
    const name = file.name.toLowerCase();
    if (name.endsWith('.json')) {
      const bundle = JSON.parse(await file.text());
      if (!bundle.title) bundle.title = file.name.replace(/\.json$/i, '');
      showBundle(bundle);
      return;
    }
    state.bundle = null;
    let score;
    if (/\.(atex|alphatex|txt)$/.test(name)) {
      score = alphaTab.importer.ScoreLoader.loadAlphaTex(await file.text(), api.settings);
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, api.settings);
    }
    if (!score.title) score.title = file.name.replace(/\.[^.]+$/, '');
    showScore(score, []);
  } catch (err) {
    console.error(err);
    setStatus(`Could not open ${file.name}: ${err.message || err}`, 'error');
  }
}

async function loadDemo() {
  setStatus('Loading the demo...', 'loading');
  try {
    const res = await fetch('/demo/demo-song.json');
    showBundle(await res.json());
  } catch (err) {
    setStatus(`Could not load the demo: ${err.message}`, 'error');
  }
}

function showScore(score, warnings, preferredTrack = 0) {
  state.score = score;
  const first = score.tracks[preferredTrack] ? preferredTrack : 0;
  state.selected = [first];

  $('song-title').textContent = score.title || 'Untitled';
  $('song-artist').textContent = score.artist || '';
  $('export-json').hidden = !state.bundle;
  buildTrackChips();
  showWarnings(warnings);
  setStatus(null);
  $('workspace').hidden = false;
  render();
  $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Display options
// ---------------------------------------------------------------------------

function currentView() {
  return document.querySelector('input[name="view"]:checked').value;
}

function applyStaffOptions() {
  const view = currentView();
  const slash = $('slash').checked;
  for (const track of state.score.tracks) {
    for (const staff of track.staves) {
      const stringed = !staff.isPercussion && staff.tuning.length > 0;
      staff.showTablature = stringed && (view === 'both' || view === 'tab');
      staff.showStandardNotation = view === 'both' || view === 'notes' || !stringed;
      staff.showSlash = slash;
    }
  }
  const rhythm = $('tab-rhythm');
  rhythm.disabled = view !== 'tab';
  rhythm.parentElement.classList.toggle('disabled', rhythm.disabled);
  api.settings.notation.rhythmMode =
    view === 'tab' && rhythm.checked ? alphaTab.TabRhythmMode.ShowWithBars : alphaTab.TabRhythmMode.Hidden;
}

function applyLayoutSettings() {
  const layout = document.querySelector('input[name="layout"]:checked').value;
  api.settings.display.layoutMode = layout === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
  api.settings.display.scale = state.zoom;
  $('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
}

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
  const track = state.score.tracks[Math.min(...state.selected)];
  const staff = track && track.staves[0];
  if (!staff) return;
  for (const masterBar of state.score.masterBars) {
    if (!masterBar.section) continue;
    const beat = staff.bars[masterBar.index]?.voices[0]?.beats[0];
    if (!beat) continue;
    const name = masterBar.section.marker
      ? `[${masterBar.section.marker}] ${masterBar.section.text}`
      : masterBar.section.text;
    if (!name) continue;
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

function render() {
  if (!state.score) return;
  applyStaffOptions();
  labelSections();
  applyLayoutSettings();
  api.updateSettings();
  api.renderScore(state.score, [...state.selected].sort((a, b) => a - b));
}

function rerenderLayout() {
  if (!state.score) return;
  applyLayoutSettings();
  api.updateSettings();
  api.render();
}

function buildTrackChips() {
  const list = $('track-list');
  list.innerHTML = '';
  state.score.tracks.forEach((track, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = track.name || `Track ${index + 1}`;
    chip.setAttribute('aria-pressed', String(state.selected.includes(index)));
    chip.addEventListener('click', () => {
      const on = state.selected.includes(index);
      if (on && state.selected.length === 1) return; // keep at least one track
      state.selected = on ? state.selected.filter((i) => i !== index) : [...state.selected, index];
      chip.setAttribute('aria-pressed', String(!on));
      render();
    });
    list.append(chip);
  });
}

// ---------------------------------------------------------------------------
// Export and print
// ---------------------------------------------------------------------------

function safeFileName() {
  const s = state.score;
  const base = [s.artist, s.title].filter(Boolean).join(' - ') || 'score';
  return base.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 120) || 'score';
}

function download(data, fileName, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportAs(kind) {
  if (!state.score) return;
  try {
    withCleanScore(() => exportFile(kind));
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message || err}`, 'error');
  }
}

function exportFile(kind) {
  const name = safeFileName();
  switch (kind) {
    case 'gp': {
      const bytes = new alphaTab.exporter.Gp7Exporter().export(state.score, api.settings);
      download(bytes, `${name}.gp`, 'application/octet-stream');
      break;
    }
    case 'midi':
      api.downloadMidi();
      break;
    case 'tex': {
      const tex = new alphaTab.exporter.AlphaTexExporter().exportToString(state.score, api.settings);
      download(tex, `${name}.atex`, 'text/plain');
      break;
    }
    case 'json':
      if (state.bundle) download(JSON.stringify(state.bundle), `${name}.json`, 'application/json');
      break;
  }
}

function printScore() {
  if (!state.score) return;
  try {
    api.print();
  } catch (err) {
    // Popup blocked: print the page itself, which hides everything but the score.
    console.warn('Print window blocked, printing the page instead', err);
    window.print();
  }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

api.soundFontLoad.on((e) => {
  const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
  $('player-status').textContent = `Loading sounds ${pct}%`;
});
api.playerReady.on(() => {
  $('play-btn').disabled = false;
  $('stop-btn').disabled = false;
  $('player-status').textContent = '';
});
api.playerStateChanged.on((e) => {
  const playing = e.state === alphaTab.synth.PlayerState.Playing;
  $('play-btn').classList.toggle('playing', playing);
  $('play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
});
api.renderStarted.on(() => {
  $('render-progress').hidden = false;
});
api.renderFinished.on(() => {
  $('render-progress').hidden = true;
});
api.error.on((err) => {
  console.error(err);
  setStatus(`Something went wrong while drawing the score: ${err.message || err}`, 'error');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const link = $('url-input').value.trim();
  if (!link) {
    setStatus('Paste a Songsterr link first.', 'error');
    return;
  }
  loadFromSongsterr(link);
});

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
  e.target.value = '';
});
$('demo-btn').addEventListener('click', loadDemo);

for (const input of document.querySelectorAll('input[name="view"], #slash, #tab-rhythm')) {
  input.addEventListener('change', render);
}
for (const input of document.querySelectorAll('input[name="layout"]')) {
  input.addEventListener('change', rerenderLayout);
}

function zoom(direction) {
  const index = ZOOM_STEPS.findIndex((z) => Math.abs(z - state.zoom) < 0.001);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
  if (next !== state.zoom) {
    state.zoom = next;
    rerenderLayout();
  }
}
$('zoom-in').addEventListener('click', () => zoom(1));
$('zoom-out').addEventListener('click', () => zoom(-1));

$('play-btn').addEventListener('click', () => api.playPause());
$('stop-btn').addEventListener('click', () => api.stop());
$('speed').addEventListener('change', (e) => {
  api.playbackSpeed = Number(e.target.value);
});
$('metronome').addEventListener('change', (e) => {
  api.metronomeVolume = e.target.checked ? 1 : 0;
});

$('print-btn').addEventListener('click', printScore);

const exportButton = $('export-btn');
const exportMenu = $('export-menu');
function setMenu(open) {
  exportMenu.hidden = !open;
  exportButton.setAttribute('aria-expanded', String(open));
}
exportButton.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(exportMenu.hidden);
});
exportMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-export]');
  if (!item) return;
  setMenu(false);
  exportAs(item.dataset.export);
});
document.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
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

// Shareable links: ?url=<songsterr link> loads straight away, ?demo opens the demo.
const params = new URLSearchParams(window.location.search);
if (params.get('url')) {
  $('url-input').value = params.get('url');
  loadFromSongsterr(params.get('url'));
} else if (params.has('demo')) {
  loadDemo();
}
