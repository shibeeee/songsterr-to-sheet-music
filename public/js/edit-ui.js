// The edit mode interface: selection highlight, the edit panel in the sidebar
// and keyboard editing. All changes go through host.commit(), which records
// undo history, rebuilds the score and re-renders.
import * as ed from './editor.js';

const DURATION_LABELS = { 1: 'Whole', 2: 'Half', 4: 'Quarter', 8: 'Eighth', 16: '16th', 32: '32nd', 64: '64th' };
const FRET_TYPING_WINDOW_MS = 700;

/**
 * @param {object} host
 *   alphaTab, api, $, toast,
 *   score(): current Score,
 *   visible(): visible track indexes,
 *   commit(fn, { merge }): apply an edit; fn(score, m) returns the new selection,
 *   undo(), redo(), canUndo(), canRedo(), revert(), isDirty()
 */
export function createEditUI(host) {
  const { alphaTab, api, $ } = host;
  const m = alphaTab.model;
  let editing = false;
  let sel = null;
  let typed = { text: '', at: 0 };
  let clipboard = null; // a copied bar

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  function select(next, { scroll = false } = {}) {
    const score = host.score();
    if (!score || !next) {
      sel = null;
    } else {
      sel = ed.clampSelection(score, next);
      if (!host.visible().includes(sel.track)) sel = null;
    }
    typed = { text: '', at: 0 };
    refreshPanel();
    drawSelection({ scroll });
  }

  function selection() {
    return sel;
  }

  function firstSelection() {
    const score = host.score();
    const track = Math.min(...host.visible());
    const beat = ed.beatOf(score, { track, staff: 0, bar: 0, voice: 0, beat: 0 });
    return beat ? ed.selectionForBeat(beat) : null;
  }

  api.beatMouseDown.on((beat) => {
    if (!editing || !beat) return;
    select(ed.selectionForBeat(beat, sel && beat.voice.bar.staff.track.index === sel.track ? sel.string : null));
  });
  api.noteMouseDown.on((note) => {
    if (!editing || !note) return;
    select({ ...ed.selectionForBeat(note.beat, note.string), string: note.string });
  });

  // -------------------------------------------------------------------------
  // Highlight
  // -------------------------------------------------------------------------

  function hideHighlight() {
    $('edit-cursor').hidden = true;
    $('edit-note').hidden = true;
  }

  function drawSelection({ scroll = false } = {}) {
    if (!editing || !sel) return hideHighlight();
    const beat = ed.beatOf(host.score(), sel);
    const lookup = api.renderer?.boundsLookup;
    const bounds = beat && lookup ? lookup.findBeat(beat) : null;
    const surface = $('score').querySelector('.at-surface');
    if (!bounds || !surface) return hideHighlight();

    const frame = $('score').parentElement.getBoundingClientRect();
    const origin = surface.getBoundingClientRect();
    const dx = origin.left - frame.left;
    const dy = origin.top - frame.top;
    const column = bounds.visualBounds;
    const bar = bounds.barBounds.visualBounds;

    const box = $('edit-cursor');
    Object.assign(box.style, {
      left: `${dx + column.x - 4}px`,
      top: `${dy + bar.y - 4}px`,
      width: `${column.w + 8}px`,
      height: `${bar.h + 8}px`
    });
    box.hidden = false;

    const noteBox = $('edit-note');
    const target = ed.noteOnString(beat, sel.string);
    const noteBounds = target && bounds.notes ? bounds.notes.find((n) => n.note === target) : null;
    if (noteBounds) {
      const b = noteBounds.noteHeadBounds;
      Object.assign(noteBox.style, {
        left: `${dx + b.x - 3}px`,
        top: `${dy + b.y - 3}px`,
        width: `${b.w + 6}px`,
        height: `${b.h + 6}px`
      });
      noteBox.hidden = false;
    } else {
      noteBox.hidden = true;
    }
    if (scroll) box.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  api.postRenderFinished.on(() => drawSelection());
  window.addEventListener('resize', () => drawSelection());
  // In one-line layout the score scrolls sideways inside its own box.
  $('score').addEventListener('scroll', () => drawSelection(), { passive: true });

  // -------------------------------------------------------------------------
  // Applying edits
  // -------------------------------------------------------------------------

  function edit(fn, options) {
    if (!sel) {
      host.toast('Click a note or beat in the score first');
      return;
    }
    const before = sel;
    host.commit((score) => fn(score, before) ?? before, options);
  }

  /** Called by the host after any score replacement. */
  function afterScoreChange(nextSel) {
    if (!editing) return;
    select(nextSel === undefined ? sel : nextSel);
  }

  function typeFret(digit) {
    const now = Date.now();
    const joined = now - typed.at < FRET_TYPING_WINDOW_MS ? typed.text + digit : digit;
    const value = Number(joined) <= 36 ? joined : digit;
    const merge = value.length > 1;
    typed = { text: value, at: now };
    const keep = typed;
    edit((score, s) => ed.setFret(m, score, s, Number(value)), { merge });
    typed = keep;
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  function stringLabel(staff, string) {
    const tuning = staff.tuning;
    const value = tuning[tuning.length - string];
    const name = value === undefined ? '' : alphaTab.model.Tuning.getTextForTuning(value, false);
    return `String ${tuning.length - string + 1}${name ? ` (${name})` : ''}`;
  }

  function setPressed(el, on) {
    el.setAttribute('aria-pressed', String(!!on));
  }

  function refreshPanel() {
    const score = host.score();
    $('edit-undo').disabled = !host.canUndo();
    $('edit-redo').disabled = !host.canRedo();
    $('edit-revert').disabled = !host.isDirty();
    if (!score) return;

    $('edit-title').value = score.title || '';
    $('edit-artist').value = score.artist || '';

    const controls = $('edit-controls');
    if (!sel) {
      controls.hidden = true;
      $('edit-where').textContent = 'Click a note or a rest in the score to select it.';
      return;
    }
    controls.hidden = false;
    const staff = ed.staffOf(score, sel);
    const beat = ed.beatOf(score, sel);
    const note = ed.noteOnString(beat, sel.string);
    const stringed = ed.isStringed(staff);
    const mb = score.masterBars[sel.bar];

    $('edit-where').textContent = `${staff.track.name} · bar ${sel.bar + 1} · beat ${sel.beat + 1}${sel.voice ? ` · voice ${sel.voice + 1}` : ''}`;

    // Note
    $('edit-note-group').hidden = !stringed;
    if (stringed) {
      $('edit-string').textContent = stringLabel(staff, sel.string);
      $('edit-string-up').disabled = sel.string >= staff.tuning.length;
      $('edit-string-down').disabled = sel.string <= 1;
      const fret = $('edit-fret');
      if (document.activeElement !== fret) fret.value = note ? String(note.fret) : '';
      fret.placeholder = note ? '' : 'none';
      $('edit-remove-note').disabled = !note;
    }
    $('edit-rest').disabled = beat.isRest;

    // Rhythm
    for (const button of document.querySelectorAll('[data-duration]')) {
      setPressed(button, Number(button.dataset.duration) === beat.duration);
    }
    setPressed($('edit-dot'), beat.dots > 0);
    setPressed($('edit-triplet'), beat.tupletNumerator === 3);

    // Techniques
    for (const button of document.querySelectorAll('[data-effect]')) {
      button.disabled = beat.isRest;
      setPressed(button, ed.effectState(m, score, sel, button.dataset.effect));
    }

    // Beat
    const text = $('edit-text');
    if (document.activeElement !== text) text.value = beat.text || '';

    // Bar
    $('edit-bar-number').textContent = String(sel.bar + 1);
    if (document.activeElement !== $('edit-section')) $('edit-section').value = mb.section ? mb.section.text : '';
    if (document.activeElement !== $('edit-tempo')) $('edit-tempo').value = String(Math.round(ed.tempoAt(score, sel.bar)));
    $('edit-ts-num').value = String(mb.timeSignatureNumerator);
    $('edit-ts-den').value = String(mb.timeSignatureDenominator);
    setPressed($('edit-repeat-start'), mb.isRepeatStart);
    $('edit-repeat-end').value = String(mb.repeatCount || 0);
    $('edit-delete-bar').disabled = score.masterBars.length <= 1;
    $('edit-transpose-group').hidden = !stringed;

    // Track
    if (document.activeElement !== $('edit-track-name')) $('edit-track-name').value = staff.track.name;
  }

  function copyCurrentBar() {
    clipboard = ed.copyBar(m, host.score(), sel.track, sel.bar, sel.staff ?? 0);
    $('edit-paste-bar').disabled = !clipboard;
    host.toast(`Copied bar ${sel.bar + 1}. Select another bar and paste with Ctrl+V.`);
  }

  function pasteCurrentBar() {
    if (!clipboard) {
      host.toast('Copy a bar first (Ctrl+C or "Copy bar")');
      return;
    }
    edit((score, s) => {
      const skipped = ed.pasteBar(m, score, s.track, s.bar, clipboard, s.staff ?? 0);
      if (skipped) host.toast(`${skipped} note${skipped === 1 ? '' : 's'} didn't fit this track and were left out`);
      return { ...s, beat: 0 };
    });
  }

  function bindButtons() {
    const on = (id, fn) => $(id).addEventListener('click', fn);

    on('edit-undo', () => host.undo());
    on('edit-redo', () => host.redo());
    on('edit-done', () => setEditing(false));
    on('edit-revert', () => {
      if (window.confirm('Undo every change you made to this song?')) host.revert();
    });

    on('edit-string-up', () => select({ ...sel, string: sel.string + 1 }));
    on('edit-string-down', () => select({ ...sel, string: sel.string - 1 }));
    $('edit-fret').addEventListener('change', (e) => {
      const value = e.target.value.trim();
      if (value === '') edit((score, s) => ed.deleteNote(m, score, s));
      else if (/^\d+$/.test(value)) edit((score, s) => ed.setFret(m, score, s, Number(value)));
    });
    on('edit-remove-note', () => edit((score, s) => ed.deleteNote(m, score, s)));
    on('edit-rest', () => edit((score, s) => ed.makeRest(m, score, s)));

    for (const button of document.querySelectorAll('[data-duration]')) {
      button.addEventListener('click', () => edit((score, s) => ed.setDuration(m, score, s, Number(button.dataset.duration))));
    }
    on('edit-dot', () => edit((score, s) => ed.toggleDot(m, score, s)));
    on('edit-triplet', () => edit((score, s) => ed.toggleTriplet(m, score, s)));

    for (const button of document.querySelectorAll('[data-effect]')) {
      button.addEventListener('click', () => edit((score, s) => ed.toggleEffect(m, score, s, button.dataset.effect)));
    }

    $('edit-text').addEventListener('change', (e) => edit((score, s) => ed.setBeatText(m, score, s, e.target.value.trim())));
    on('edit-insert-beat', () => edit((score, s) => ed.insertBeat(m, score, s)));
    on('edit-delete-beat', () => edit((score, s) => ed.deleteBeat(m, score, s)));

    $('edit-section').addEventListener('change', (e) => edit((score, s) => ed.setSection(m, score, s.bar, e.target.value)));
    $('edit-tempo').addEventListener('change', (e) => {
      const value = Number(e.target.value);
      if (!(value >= 20 && value <= 400)) {
        host.toast('Tempo has to be between 20 and 400 bpm');
        refreshPanel();
        return;
      }
      edit((score, s) => ed.setTempo(m, score, s.bar, value));
    });
    const timeSig = () => {
      const num = Number($('edit-ts-num').value);
      const den = Number($('edit-ts-den').value);
      edit((score, s) => {
        if (!ed.setTimeSignature(m, score, s.bar, num, den)) host.toast('That time signature is not supported');
      });
    };
    $('edit-ts-num').addEventListener('change', timeSig);
    $('edit-ts-den').addEventListener('change', timeSig);
    on('edit-repeat-start', () => edit((score, s) => ed.toggleRepeatStart(m, score, s.bar)));
    $('edit-repeat-end').addEventListener('change', (e) => edit((score, s) => ed.setRepeatEnd(m, score, s.bar, Number(e.target.value))));

    on('edit-insert-bar-before', () => edit((score, s) => ({ ...s, bar: ed.insertBar(m, score, s.bar), beat: 0 })));
    on('edit-insert-bar-after', () => edit((score, s) => ({ ...s, bar: ed.insertBar(m, score, s.bar + 1), beat: 0 })));
    on('edit-duplicate-bar', () => edit((score, s) => ({ ...s, bar: ed.duplicateBar(m, score, s.bar), beat: 0 })));
    on('edit-delete-bar', () => edit((score, s) => ({ ...s, bar: ed.deleteBar(m, score, s.bar), beat: 0 })));
    on('edit-copy-bar', () => sel && copyCurrentBar());
    on('edit-paste-bar', () => sel && pasteCurrentBar());

    const transpose = (semitones) =>
      edit((score, s) => {
        const skipped = ed.transposeBars(m, score, s.track, s.bar, s.bar, semitones);
        if (skipped) host.toast(`${skipped} note${skipped === 1 ? '' : 's'} could not move that far and stayed put`);
      });
    on('edit-transpose-down', () => transpose(-1));
    on('edit-transpose-up', () => transpose(1));

    const songInfo = () =>
      host.commit((score) => {
        ed.setSongInfo(score, { title: $('edit-title').value.trim(), artist: $('edit-artist').value.trim() });
        return sel;
      });
    $('edit-title').addEventListener('change', songInfo);
    $('edit-artist').addEventListener('change', songInfo);
    $('edit-track-name').addEventListener('change', (e) => edit((score, s) => ed.renameTrack(score, s.track, e.target.value)));
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  /** Returns true when the key was handled. */
  function handleKey(e) {
    if (!editing) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.shiftKey ? host.redo() : host.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      host.redo();
      return true;
    }
    if (mod && sel && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      copyCurrentBar();
      return true;
    }
    if (mod && sel && e.key.toLowerCase() === 'v') {
      pasteCurrentBar();
      return true;
    }
    if (mod || e.altKey) return false;
    if (e.key === 'Escape') {
      setEditing(false);
      return true;
    }
    if (!sel) {
      if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        select(firstSelection(), { scroll: true });
        return true;
      }
      return false;
    }
    const score = host.score();
    switch (e.key) {
      case 'ArrowRight':
        select(ed.stepBeat(score, sel, 1), { scroll: true });
        return true;
      case 'ArrowLeft':
        select(ed.stepBeat(score, sel, -1), { scroll: true });
        return true;
      case 'ArrowUp':
        select({ ...sel, string: sel.string + 1 });
        return true;
      case 'ArrowDown':
        select({ ...sel, string: sel.string - 1 });
        return true;
      case 'Delete':
      case 'Backspace':
        edit((sc, s) => ed.deleteNote(m, sc, s));
        return true;
      case 'r':
      case 'R':
        edit((sc, s) => ed.makeRest(m, sc, s));
        return true;
      case '[':
        edit((sc, s) => ed.stepDuration(m, sc, s, -1));
        return true;
      case ']':
        edit((sc, s) => ed.stepDuration(m, sc, s, 1));
        return true;
      case '.':
        edit((sc, s) => ed.toggleDot(m, sc, s));
        return true;
      case 'Enter':
        edit((sc, s) => ed.insertBeat(m, sc, s));
        return true;
      default:
        if (/^[0-9]$/.test(e.key) && ed.isStringed(ed.staffOf(score, sel))) {
          typeFret(e.key);
          return true;
        }
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('editing', on);
    $('edit-panel').hidden = !on;
    $('edit-banner').hidden = !on;
    $('edit-toggle').setAttribute('aria-pressed', String(on));
    if (on) {
      api.pause();
      select(sel || firstSelection());
      $('sidebar').scrollTop = 0;
    } else {
      hideHighlight();
    }
  }

  bindButtons();

  return {
    isEditing: () => editing,
    setEditing,
    toggle: () => setEditing(!editing),
    handleKey,
    afterScoreChange,
    refreshPanel,
    selection,
    reset() {
      sel = null;
      setEditing(false);
    }
  };
}

export { DURATION_LABELS };
