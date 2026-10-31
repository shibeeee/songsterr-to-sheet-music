// The "from a recording" flow: choosing a source (YouTube video, audio file,
// microphone), recording, transcribing in a worker, and the Transcription
// panel for adjusting the result. The score itself is shown by the app.

import { youtubeId, canRecordTab, canRecordMic, startTabRecording, startMicRecording, decodeAudio, forModel, Transcriber } from './audio-input.js';
import { notesToBundle } from './transcribe.js';

// How many notes to keep: what the model counts as a note, and how quiet a
// note may be and still be written.
const SENSITIVITY = {
  more: { worker: { onsetThreshold: 0.4, frameThreshold: 0.25, minNoteFrames: 5 }, minVelocity: 0.1 },
  normal: { worker: { onsetThreshold: 0.5, frameThreshold: 0.3, minNoteFrames: 6 }, minVelocity: 0.2 },
  fewer: { worker: { onsetThreshold: 0.6, frameThreshold: 0.35, minNoteFrames: 8 }, minVelocity: 0.35 }
};

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "1:23", "83" or "1:23.5" to seconds; empty is null. */
export function parseTime(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * host: { $, asset, toast, show(bundle) -> Promise<boolean>, isDirty() -> boolean, home() }
 */
export function createTranscribeUI(host) {
  const { $ } = host;
  const dialog = $('audio-dialog');
  const transcriber = new Transcriber(host.asset('vendor/transcriber/transcriber-worker.js'), host.asset('vendor/transcriber/model/model.json'));

  const flow = { source: null, recorder: null, timer: 0, blob: null, buffer: null, name: '', url: null, busy: false };
  // The transcription on screen: its notes and the settings that wrote them.
  let current = null;

  // -------------------------------------------------------------------------
  // Dialog
  // -------------------------------------------------------------------------

  function showError(message) {
    const el = $('audio-error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function showStep({ youtube = false, mic = false, recorder = false, settings = false }) {
    $('audio-youtube').hidden = !youtube;
    $('audio-mic').hidden = !mic;
    $('audio-recorder').hidden = !recorder;
    $('audio-settings').hidden = !settings;
  }

  function resetRecorderUI() {
    $('record-start').hidden = false;
    $('record-start').disabled = false;
    $('record-stop').hidden = true;
    $('record-time').hidden = true;
    $('record-level').hidden = true;
    $('record-hint').textContent = '';
  }

  /** Opens the dialog for a source: 'youtube' (with an optional link), 'mic' or 'file'. */
  async function open(source, { link = '', file = null } = {}) {
    if (flow.busy) return;
    stopRecording(true);
    flow.source = source;
    showError('');
    resetRecorderUI();
    $('tx-progress').hidden = true;
    if (!dialog.open) dialog.showModal();
    if (source === 'youtube') {
      showStep({ youtube: true, recorder: canRecordTab() });
      $('youtube-unsupported').hidden = canRecordTab();
      $('youtube-how').hidden = !canRecordTab();
      $('youtube-input').value = link;
      if (link) loadVideo(link);
      else {
        $('youtube-frame').hidden = true;
        $('youtube-frame').replaceChildren();
        $('youtube-input').focus();
      }
    } else if (source === 'mic') {
      showStep({ mic: true, recorder: true });
      if (!canRecordMic()) showError("This browser can't record sound. Try Chrome, Edge, Firefox or Safari.");
      $('record-start').querySelector('span').textContent = 'Start recording';
    } else if (source === 'file' && file) {
      showStep({});
      await useAudio(file, file.name.replace(/\.[^.]+$/, ''));
    }
  }

  async function loadVideo(link) {
    const id = youtubeId(link);
    if (!id) {
      showError("That doesn't look like a YouTube link. It should look like youtube.com/watch?v=... or youtu.be/...");
      return;
    }
    showError('');
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`;
    frame.title = 'YouTube video';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    $('youtube-frame').replaceChildren(frame);
    $('youtube-frame').hidden = false;
    $('record-start').querySelector('span').textContent = 'Start listening';
    flow.name = 'YouTube video';
    // The video's title, for the score (YouTube allows this lookup from any page).
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
      if (res.ok) {
        const info = await res.json();
        if (info.title) flow.name = info.title;
      }
    } catch {
      // keep the plain name
    }
  }

  async function startRecording() {
    showError('');
    $('record-start').disabled = true;
    try {
      flow.recorder = flow.source === 'youtube' ? await startTabRecording() : await startMicRecording();
    } catch (err) {
      $('record-start').disabled = false;
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      showError(
        denied
          ? flow.source === 'youtube'
            ? 'Sharing was cancelled. Press Start listening again and choose this tab, with "Share tab audio" on.'
            : 'The microphone was blocked. Allow it in the address bar, then try again.'
          : err.message || String(err)
      );
      return;
    }
    $('record-start').hidden = true;
    $('record-stop').hidden = false;
    $('record-time').hidden = false;
    $('record-level').hidden = false;
    $('record-hint').textContent = flow.source === 'youtube' ? 'Now play the video. Press Stop when the part is over.' : 'Recording. Press Stop when you are done.';
    flow.recorder.onEnd(() => finishRecording());
    let quiet = 0;
    const tick = () => {
      if (!flow.recorder) return;
      const level = flow.recorder.level();
      $('record-level').firstElementChild.style.width = `${Math.round(level * 100)}%`;
      $('record-time').textContent = formatTime(flow.recorder.seconds());
      quiet = level > 0.02 ? 0 : quiet + 1;
      if (quiet > 120 && flow.source === 'youtube') $('record-hint').textContent = 'No sound yet. Is the video playing, with "Share tab audio" on?';
      else if (quiet === 0) $('record-hint').textContent = 'Hearing it. Press Stop when the part is over.';
      flow.timer = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopRecording(discard = false) {
    cancelAnimationFrame(flow.timer);
    const recorder = flow.recorder;
    flow.recorder = null;
    if (!recorder) return null;
    const done = recorder.stop();
    return discard ? null : done;
  }

  async function finishRecording() {
    const recorder = flow.recorder;
    const done = stopRecording();
    if (!done) return;
    resetRecorderUI();
    const seconds = recorder.seconds();
    const blob = await done;
    if (seconds < 1.5 || !blob.size) {
      showError('That recording is too short. Record at least a few seconds.');
      return;
    }
    // Leave the video's own player paused: there is nothing more to hear.
    $('youtube-frame').replaceChildren();
    $('youtube-frame').hidden = true;
    await useAudio(blob, flow.source === 'youtube' ? flow.name : 'Recording');
  }

  async function useAudio(blob, name) {
    showError('');
    flow.busy = true;
    try {
      flow.buffer = await decodeAudio(blob);
    } catch (err) {
      showError(err.message);
      return;
    } finally {
      flow.busy = false;
    }
    flow.blob = blob;
    flow.name = name || 'Recording';
    if (flow.url) URL.revokeObjectURL(flow.url);
    flow.url = URL.createObjectURL(blob);
    $('recording-name').textContent = flow.name;
    $('recording-length').textContent = `(${formatTime(flow.buffer.duration)})`;
    $('recording-preview').src = flow.url;
    $('tx-from').value = '';
    $('tx-to').value = '';
    showStep({ settings: true });
    $('tx-start').disabled = false;
    $('tx-start').focus();
  }

  async function startTranscription() {
    const from = parseTime($('tx-from').value) ?? 0;
    const to = parseTime($('tx-to').value) ?? flow.buffer.duration;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 1) {
      showError('Check the From and To times (like 0:30 and 1:15), at least a second apart.');
      return;
    }
    showError('');
    flow.busy = true;
    $('tx-start').disabled = true;
    $('tx-cancel').hidden = false;
    $('tx-progress').hidden = false;
    const setProgress = (value, text) => {
      $('tx-progress').querySelector('.bar span').style.width = `${Math.round(value * 100)}%`;
      $('tx-progress-text').textContent = text;
    };
    setProgress(0, 'Getting the listener ready…');
    const started = performance.now();
    const settings = { mode: $('tx-mode-start').value, beatsPerBar: Number($('tx-meter-start').value), sensitivity: 'normal', grid: 16, barShift: 0, bpm: null };
    try {
      const audio = await forModel(flow.buffer, from, to);
      const length = audio.length / 22050;
      const result = await transcriber.transcribe(audio, SENSITIVITY.normal.worker, (value) => {
        const elapsed = (performance.now() - started) / 1000;
        // The first part includes warming up, so estimate only after that.
        const left = value > 0.2 ? (elapsed / value) * (1 - value) : null;
        setProgress(value, `Listening… ${Math.round(value * 100)}%${left != null && left > 3 ? `, about ${left < 60 ? `${Math.ceil(left)} s` : `${Math.ceil(left / 60)} min`} left` : ''}`);
      });
      if (!result.notes.length) throw new Error("No notes were heard. Check that the recording has sound, or try a louder part.");
      current = { id: result.id, notes: result.notes, settings, name: flow.name, url: flow.url, length, backend: result.backend, detectedBpm: null };
      flow.url = null; // the panel's player owns it now
      setProgress(1, 'Writing the music…');
      await render();
      dialog.close();
    } catch (err) {
      if (!err.cancelled) showError(`Couldn't transcribe this recording: ${err.message || err}`);
    } finally {
      flow.busy = false;
      $('tx-start').disabled = false;
      $('tx-cancel').hidden = true;
      if (dialog.open) $('tx-progress').hidden = true;
    }
  }

  // -------------------------------------------------------------------------
  // The score and the Transcription panel
  // -------------------------------------------------------------------------

  async function render() {
    const s = current.settings;
    const bundle = notesToBundle(current.notes, {
      mode: s.mode,
      beatsPerBar: s.beatsPerBar,
      barShift: s.barShift,
      grid: s.grid,
      bpm: s.bpm,
      beatTime: s.beatTime,
      minVelocity: SENSITIVITY[s.sensitivity].minVelocity,
      title: current.name,
      artist: 'Transcribed from a recording'
    });
    // Keep the tempo and beat found the first time, so other changes don't move them.
    s.bpm = bundle.transcription.bpm;
    s.beatTime = bundle.transcription.beatTime;
    if (current.detectedBpm == null) current.detectedBpm = s.bpm;
    current.bundle = bundle;
    const shown = await host.show(bundle);
    if (shown) syncPanel();
    return shown;
  }

  function syncPanel() {
    const s = current.settings;
    if ($('tx-audio').getAttribute('src') !== current.url) $('tx-audio').src = current.url;
    $('tx-mode').value = s.mode;
    $('tx-bpm').value = String(s.bpm);
    $('tx-bpm-note').textContent = current.detectedBpm && current.detectedBpm !== s.bpm ? `heard ${current.detectedBpm}` : '';
    $('tx-meter').value = String(s.beatsPerBar);
    $('tx-grid').value = String(s.grid);
    $('tx-sensitivity').value = s.sensitivity;
  }

  /** Re-writes the music with changed settings (asking first if it was edited). */
  async function update(change) {
    if (!current) return;
    if (host.isDirty() && !window.confirm('Rewriting the transcription replaces your edits to it. Continue?')) {
      syncPanel();
      return;
    }
    const before = { ...current.settings };
    Object.assign(current.settings, change);
    if (change.sensitivity && change.sensitivity !== before.sensitivity) {
      try {
        const result = await transcriber.notes(current.id, SENSITIVITY[change.sensitivity].worker);
        current.notes = result.notes;
      } catch (err) {
        host.toast(err.message || String(err));
        current.settings = before;
        syncPanel();
        return;
      }
    }
    await render();
  }

  /** Called whenever the app shows a score: the panel only belongs to transcriptions. */
  function scoreShown(bundle) {
    const isTranscription = !!current && bundle === current.bundle;
    $('tx-panel').hidden = !isTranscription;
    if (!isTranscription && current && !flow.busy) {
      // Another song opened: let go of the recording.
      $('tx-audio').removeAttribute('src');
      if (current.url) URL.revokeObjectURL(current.url);
      current = null;
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  $('audio-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    stopRecording(true);
    if (flow.busy) transcriber.cancel();
    $('youtube-frame').replaceChildren();
    resetRecorderUI();
  });
  $('youtube-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadVideo($('youtube-input').value);
  });
  $('youtube-input').addEventListener('paste', () => setTimeout(() => youtubeId($('youtube-input').value) && loadVideo($('youtube-input').value)));
  $('switch-to-mic').addEventListener('click', () => open('mic'));
  $('record-start').addEventListener('click', startRecording);
  $('record-stop').addEventListener('click', finishRecording);
  $('tx-start').addEventListener('click', startTranscription);
  $('tx-cancel').addEventListener('click', () => {
    transcriber.cancel();
    $('tx-progress').hidden = true;
  });

  $('tx-mode').addEventListener('change', (e) => update({ mode: e.target.value }));
  $('tx-meter').addEventListener('change', (e) => update({ beatsPerBar: Number(e.target.value), barShift: 0 }));
  $('tx-grid').addEventListener('change', (e) => update({ grid: Number(e.target.value) }));
  $('tx-sensitivity').addEventListener('change', (e) => update({ sensitivity: e.target.value }));
  $('tx-bpm').addEventListener('change', (e) => {
    const bpm = Math.round(Number(e.target.value));
    if (bpm >= 30 && bpm <= 300) update({ bpm });
    else syncPanel();
  });
  $('tx-half').addEventListener('click', () => current && update({ bpm: Math.max(30, Math.round(current.settings.bpm / 2)) }));
  $('tx-double').addEventListener('click', () => current && update({ bpm: Math.min(300, current.settings.bpm * 2) }));
  $('tx-shift-left').addEventListener('click', () => current && update({ barShift: current.settings.barShift + 1 }));
  $('tx-shift-right').addEventListener('click', () => current && update({ barShift: current.settings.barShift - 1 }));
  $('tx-new').addEventListener('click', () => host.home());

  return { open, scoreShown, isYouTubeLink: (text) => !!youtubeId(text) };
}
