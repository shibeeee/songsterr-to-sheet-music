// The "from a recording" flow: choosing a source (YouTube video, audio file,
// microphone), listening, transcribing in a worker while the sound comes in,
// and the Transcription panel for adjusting the result. The score itself is
// shown by the app.

import { youtubeId, canRecordTab, canRecordMic, startTabRecording, startMicRecording, decodeAudio, forModel, wavBlob, songFromVideoTitle, Transcriber } from './audio-input.js';
import { analyzeRecording } from './analysis.js';
import { notesToBundle } from './transcribe.js';

// How many notes to keep: what the model counts as a note, and how quiet a
// note may be and still be written.
const SENSITIVITY = {
  more: { worker: { onsetThreshold: 0.4, frameThreshold: 0.25, minNoteFrames: 5 }, minVelocity: 0.1 },
  normal: { worker: { onsetThreshold: 0.5, frameThreshold: 0.3, minNoteFrames: 6 }, minVelocity: 0.2 },
  fewer: { worker: { onsetThreshold: 0.6, frameThreshold: 0.35, minNoteFrames: 8 }, minVelocity: 0.35 }
};

const MODE_NAMES = { chords: 'chords', melody: 'the melody', bass: 'the bass line', guitar: 'every note', band: 'guitar and bass' };

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const formatLeft = (s) => (s < 60 ? `${Math.max(1, Math.ceil(s))} s` : `${Math.ceil(s / 60)} min`);

/** "1:23", "83" or "1:23.5" to seconds; empty is null. */
export function parseTime(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * Draws the notes heard so far: time across, pitch up, a "now" line at the
 * right while listening.
 */
function createNoteRoll(canvas) {
  let notes = [];
  let view = { from: 0, to: 10, now: null };
  let placeholder = '';
  const colors = () => {
    const css = getComputedStyle(canvas);
    return { note: css.getPropertyValue('--roll-note').trim() || '#e5484d', grid: css.getPropertyValue('--roll-grid').trim() || 'rgba(127,127,127,.15)', now: css.getPropertyValue('--roll-now').trim() || '#888' };
  };
  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const g = canvas.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const c = colors();
    const visible = notes.filter((n) => n.start + n.duration >= view.from && n.start <= view.to);
    let low = 40;
    let high = 84;
    if (visible.length) {
      low = Math.min(low, ...visible.map((n) => n.pitch)) - 2;
      high = Math.max(high, ...visible.map((n) => n.pitch)) + 2;
    }
    const x = (t) => ((t - view.from) / (view.to - view.from)) * width;
    const rowH = height / (high - low + 1);
    const y = (p) => height - (p - low + 1) * rowH;
    // Octave lines (each C).
    g.fillStyle = c.grid;
    for (let p = Math.ceil(low / 12) * 12; p <= high; p += 12) g.fillRect(0, Math.round(y(p) + rowH), width, 1);
    if (!visible.length && placeholder) {
      g.fillStyle = c.now;
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(placeholder, width / 2, height / 2);
    }
    g.fillStyle = c.note;
    for (const n of visible) {
      g.globalAlpha = Math.min(1, 0.35 + n.velocity);
      const w = Math.max(2, x(n.start + n.duration) - x(n.start) - 1);
      const h = Math.max(2, rowH - 1);
      g.beginPath();
      g.roundRect ? g.roundRect(x(n.start), y(n.pitch), w, h, Math.min(2, h / 2)) : g.rect(x(n.start), y(n.pitch), w, h);
      g.fill();
    }
    g.globalAlpha = 1;
    if (view.now != null) {
      g.fillStyle = c.now;
      g.fillRect(Math.round(x(view.now)) - 1, 0, 2, height);
    }
  }
  return {
    clear() {
      notes = [];
      draw();
    },
    /** New notes for everything from `from` seconds on. */
    update(fresh, from = 0) {
      notes = notes.filter((n) => n.start < from).concat(fresh);
      draw();
    },
    setView(next) {
      view = { ...view, ...next };
      draw();
    },
    placeholder(text) {
      placeholder = text;
      draw();
    },
    count: () => notes.length,
    draw
  };
}

/**
 * host: { $, asset, toast, show(bundle) -> Promise<boolean>, isDirty() -> boolean, home() }
 */
export function createTranscribeUI(host) {
  const { $ } = host;
  const dialog = $('audio-dialog');
  const transcriber = new Transcriber(host.asset('vendor/transcriber/transcriber-worker.js'), host.asset('vendor/transcriber/model/model.json'));
  const roll = createNoteRoll($('note-roll'));

  const flow = {
    source: null,
    phase: 'setup', // setup, listening, writing
    player: null,
    videoId: null,
    name: '',
    recorder: null,
    live: null,
    timer: 0,
    file: null,
    buffer: null,
    url: null,
    stopAt: null,
    warmed: false
  };
  // The transcription on screen: its notes, what was found in the recording, and the settings that wrote them.
  let current = null;

  // -------------------------------------------------------------------------
  // Dialog layout
  // -------------------------------------------------------------------------

  function showError(message) {
    $('audio-error').textContent = message || '';
    $('audio-error').hidden = !message;
  }

  function hint(text) {
    $('record-hint').textContent = text || '';
  }

  const mode = () => dialog.querySelector('input[name="tx-mode-start"]:checked')?.value || 'chords';

  function setProgress(value, text) {
    $('tx-progress').hidden = value == null;
    if (value == null) return;
    $('tx-progress').querySelector('.bar span').style.width = `${Math.round(value * 100)}%`;
    $('tx-progress-text').textContent = text;
  }

  /** Shows the parts of the dialog for the current source and phase. */
  function layout() {
    const { source, phase } = flow;
    const setup = phase === 'setup';
    for (const tab of dialog.querySelectorAll('.source-tab')) {
      const on = tab.dataset.source === source;
      tab.setAttribute('aria-selected', String(on));
      tab.disabled = !setup && !on;
    }
    const youtubeOk = canRecordTab();
    $('audio-youtube').hidden = source !== 'youtube';
    $('youtube-unsupported').hidden = source !== 'youtube' || youtubeOk;
    $('youtube-form').hidden = source !== 'youtube' || !setup || !youtubeOk;
    if (source === 'youtube' && !youtubeOk) $('youtube-frame').hidden = true;
    const elsewhere = source === 'youtube' && youtubeOk && !!flow.videoId && flow.ytMode === 'tab';
    $('youtube-frame').hidden = source !== 'youtube' || !youtubeOk || !flow.videoId || flow.ytMode === 'tab';
    $('youtube-elsewhere').hidden = !elsewhere || !setup;
    $('youtube-switch').hidden = source !== 'youtube' || !youtubeOk || !flow.videoId || flow.ytMode === 'tab' || !setup;
    $('audio-file').hidden = source !== 'file';
    $('file-drop').hidden = source !== 'file' || !!flow.buffer;
    $('recording-info').hidden = source !== 'file' || !flow.buffer;
    $('audio-mic').hidden = source !== 'mic' || !setup;
    $('mode-picker').hidden = !setup;
    $('tx-part').hidden = !setup || source === 'mic';
    $('listen').hidden = setup;
    $('record-stop').hidden = phase !== 'listening';
    $('tx-cancel').hidden = phase !== 'writing';
    const go = $('tx-go');
    go.hidden = !setup;
    const label = go.querySelector('span');
    const micInstead = source === 'youtube' && !youtubeOk;
    if (micInstead) label.textContent = 'Use the microphone instead';
    else if (source === 'youtube') label.textContent = flow.ytMode === 'tab' ? 'Listen to the YouTube tab' : 'Listen and write it out';
    else if (source === 'mic') label.textContent = 'Start recording';
    else label.textContent = 'Write it out';
    go.disabled = micInstead
      ? !canRecordMic()
      : (source === 'youtube' && !flow.videoId) || (source === 'file' && !flow.buffer) || (source === 'mic' && !canRecordMic());
    go.querySelector('svg use').setAttribute('href', source === 'file' ? '#i-music' : micInstead ? '#i-mic' : '#i-record');
    go.classList.toggle('record', source !== 'file' && !micInstead);
  }

  function setupHint() {
    if (flow.source === 'youtube') {
      if (!canRecordTab()) hint('');
      else if (!flow.videoId) hint('Paste a link to a YouTube video to begin.');
      else if (flow.ytMode === 'tab') hint('');
      else hint('When your browser asks what to share, choose this tab and keep "Share tab audio" on. The video plays by itself.');
    } else if (flow.source === 'mic') hint(canRecordMic() ? 'Your browser will ask to use the microphone.' : '');
    else hint(flow.buffer ? '' : '');
  }

  /** Opens the dialog for a source: 'youtube' (with an optional link), 'mic' or 'file'. */
  async function open(source, { link = '', file = null } = {}) {
    if (flow.phase !== 'setup') return;
    if (!dialog.open) dialog.showModal();
    if (!flow.warmed) {
      // Get the listener ready while the person chooses.
      flow.warmed = true;
      transcriber.warm();
    }
    if (source === 'youtube' && !link && !flow.videoId) $('youtube-input').value = '';
    await selectSource(source);
    if (source === 'youtube' && link) {
      $('youtube-input').value = link;
      loadVideo(link);
    }
    if (source === 'file' && file) await useFile(file);
  }

  async function selectSource(source) {
    if (flow.phase !== 'setup') return;
    flow.source = source;
    showError('');
    setProgress(null);
    if (source !== 'youtube') flow.player?.pauseVideo?.();
    layout();
    setupHint();
    if (source === 'youtube' && !flow.videoId) setTimeout(() => $('youtube-input').focus());
  }

  // -------------------------------------------------------------------------
  // YouTube
  // -------------------------------------------------------------------------

  // YouTube's player API lets the page start the video and notice when it ends.
  let youtubeApi = null;
  function loadYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (!youtubeApi) {
      youtubeApi = new Promise((resolve) => {
        const previous = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          previous?.();
          resolve(window.YT);
        };
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => resolve(null);
        document.head.append(script);
        setTimeout(() => resolve(window.YT?.Player ? window.YT : null), 8000);
      });
    }
    return youtubeApi;
  }

  function clearVideo() {
    flow.player?.destroy?.();
    flow.player = null;
    flow.videoId = null;
    flow.videoError = null;
    flow.ytMode = 'here';
    const holder = document.createElement('div');
    holder.id = 'youtube-player';
    $('youtube-frame').replaceChildren(holder);
    $('youtube-frame').hidden = true;
  }

  // What YouTube's player error codes mean, for the person.
  const VIDEO_ERRORS = {
    2: "That link doesn't point to a video YouTube can play.",
    5: "This video can't be played in this browser's player.",
    100: 'That video was removed or is private.',
    101: "This video's owner doesn't let it play on other websites.",
    150: "This video's owner doesn't let it play on other websites."
  };

  /** Plays the video on YouTube itself, in its own tab, and listens to that tab. */
  function useElsewhere(reason = '') {
    flow.ytMode = 'tab';
    flow.player?.pauseVideo?.();
    const from = Math.floor(parseTime($('tx-from').value) || 0);
    $('open-on-youtube').href = `https://www.youtube.com/watch?v=${flow.videoId}${from ? `&t=${from}s` : ''}`;
    $('elsewhere-why').textContent = reason;
    $('use-here').parentElement.hidden = flow.videoError != null;
    layout();
    setupHint();
  }

  function useHere() {
    flow.ytMode = 'here';
    layout();
    setupHint();
  }

  /**
   * Starts the video muted for a moment to find out early whether it can play
   * here at all (some owners don't allow it), then puts it back.
   */
  function probeVideo(player, id) {
    flow.probing = true;
    try {
      player.mute();
      player.playVideo();
    } catch {
      flow.probing = false;
      return;
    }
    const started = performance.now();
    const check = () => {
      if (flow.videoId !== id || !flow.probing) return;
      const state = player.getPlayerState?.();
      if (state === 1 && player.getCurrentTime() > 0.2) {
        flow.probing = false;
        player.pauseVideo();
        player.seekTo(0, true);
        player.unMute();
      } else if (performance.now() - started > 9000) {
        flow.probing = false;
        player.pauseVideo?.();
        player.unMute?.();
      } else setTimeout(check, 250);
    };
    setTimeout(check, 250);
  }

  async function loadVideo(link) {
    const id = youtubeId(link);
    if (!id) {
      showError("That doesn't look like a YouTube link. It should look like youtube.com/watch?v=… or youtu.be/…");
      return;
    }
    if (id === flow.videoId) return;
    showError('');
    clearVideo();
    flow.name = 'YouTube video';
    flow.artist = '';
    flow.videoId = id;
    layout();
    setupHint();
    const YT = await loadYouTubeApi();
    if (flow.videoId !== id) return; // another link was loaded meanwhile
    if (YT) {
      flow.player = new YT.Player('youtube-player', {
        host: 'https://www.youtube-nocookie.com',
        videoId: id,
        playerVars: { rel: 0, playsinline: 1 },
        events: {
          onReady: (e) => {
            if (flow.videoId !== id) return;
            flow.videoDuration = e.target.getDuration?.() || 0; // the song's length (an ad has its own)
            probeVideo(e.target, id);
          },
          onStateChange: (e) => {
            // The video ended while listening: that's the whole part.
            if (e.data === YT.PlayerState.ENDED && flow.phase === 'listening' && flow.ytMode === 'here') finishListening();
          },
          onError: (e) => {
            if (flow.videoId !== id) return;
            flow.probing = false;
            flow.videoError = e.data;
            const why = VIDEO_ERRORS[e.data] || "YouTube won't play this video here.";
            if (e.data === 100 || e.data === 2) {
              if (flow.phase === 'listening') abandonListening(why);
              else showError(why);
              return;
            }
            // It can still be played on YouTube itself.
            if (flow.phase === 'listening' && flow.ytMode === 'here') abandonListening('');
            if (flow.ytMode !== 'tab') useElsewhere(`${why} You can still use it: play it on YouTube and the site listens to that tab.`);
          }
        }
      });
    } else {
      // Without the player API the video still plays; the listener just can't start it.
      const frame = document.createElement('iframe');
      frame.src = `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`;
      frame.title = 'YouTube video';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      $('youtube-frame').replaceChildren(frame);
    }
    $('open-on-youtube').href = `https://www.youtube.com/watch?v=${id}`;
    // The video's title and channel, for the score (YouTube allows this lookup from any page).
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
      if (res.ok) {
        const info = await res.json();
        if (flow.videoId === id) Object.assign(flow, songFromVideoTitle(info.title, info.author_name));
      }
    } catch {
      // keep the plain name
    }
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async function useFile(file) {
    showError('');
    hint('Reading the file…');
    try {
      const buffer = await decodeAudio(file);
      flow.buffer = buffer;
      flow.file = file;
      flow.name = file.name.replace(/\.[^.]+$/, '') || 'Recording';
      if (flow.url) URL.revokeObjectURL(flow.url);
      flow.url = URL.createObjectURL(file);
      $('recording-name').textContent = flow.name;
      $('recording-length').textContent = `(${formatTime(buffer.duration)})`;
      $('recording-preview').src = flow.url;
      hint('');
    } catch (err) {
      hint('');
      showError(err.message);
    }
    layout();
    if (flow.buffer) $('tx-go').focus();
  }

  function forgetFile() {
    flow.buffer = null;
    flow.file = null;
    $('recording-preview').removeAttribute('src');
    if (flow.url) URL.revokeObjectURL(flow.url);
    flow.url = null;
  }

  // -------------------------------------------------------------------------
  // Listening
  // -------------------------------------------------------------------------

  function readPart(duration = Infinity) {
    const from = parseTime($('tx-from').value) ?? 0;
    const to = parseTime($('tx-to').value);
    if (!Number.isFinite(from) || (to !== null && (!Number.isFinite(to) || to <= from + 0.9)) || from >= duration) {
      showError('Check the From and To times (like 0:30 and 1:15), at least a second apart.');
      return null;
    }
    return { from, to };
  }

  const workerSettings = () => SENSITIVITY.normal.worker;

  async function startListening() {
    showError('');
    const youtube = flow.source === 'youtube';
    const elsewhere = youtube && flow.ytMode === 'tab';
    let part = { from: 0, to: null };
    if (youtube) {
      part = readPart();
      if (!part) return;
      hint(
        elsewhere
          ? 'Your browser is asking what to share: choose the YouTube tab and keep "Share tab audio" on. Then play the video there.'
          : 'Your browser is asking what to share: choose this tab and keep "Share tab audio" on.'
      );
    }
    flow.probing = false;
    $('tx-go').disabled = true;
    roll.clear();
    roll.placeholder(elsewhere ? 'Play the video in the YouTube tab: notes appear here as they are heard' : 'Notes appear here a moment after they are heard');
    const live = transcriber.live({ ...workerSettings(), returnAudio: true }, {
      onPartial: ({ notes, from }) => roll.update(notes, from),
      onProgress: (p) => {
        flow.heard = p.seconds;
        flow.onProgress?.(p);
      }
    });
    flow.onProgress = null;
    live.result.catch(() => {}); // handled when finishing
    flow.heard = 0;
    flow.pushed = 0; // seconds of sound sent to the transcriber
    flow.soundAt = null; // when the music started, in those seconds
    flow.videoPlaying = false;
    flow.lastVideoTime = -1;
    flow.lastVideoMove = 0;
    const player = youtube && !elsewhere ? flow.player : null;
    const controlled = !!player?.getPlayerState;
    const onSamples = (samples, rate) => {
      // Only the video itself: not ads, buffering or pauses.
      if (controlled && !flow.videoPlaying) return;
      if (flow.soundAt == null) {
        let peak = 0;
        for (let i = 0; i < samples.length; i += 4) peak = Math.max(peak, Math.abs(samples[i]));
        if (peak < 0.01) {
          if (elsewhere) return; // waiting for the video to start in the other tab
        } else flow.soundAt = flow.pushed;
      }
      flow.pushed += samples.length / rate;
      live.push(samples, rate);
    };
    try {
      flow.recorder = youtube ? await startTabRecording({ otherTab: elsewhere, onSamples }) : await startMicRecording({ onSamples });
    } catch (err) {
      transcriber.cancel();
      $('tx-go').disabled = false;
      setupHint();
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      showError(
        denied
          ? youtube
            ? `Sharing was cancelled. Press ${elsewhere ? 'Listen to the YouTube tab' : 'Listen and write it out'} again, choose ${elsewhere ? 'the YouTube tab' : 'this tab'}, and keep "Share tab audio" on.`
            : 'The microphone was blocked. Allow it in the address bar, then try again.'
          : err.message || String(err)
      );
      return;
    }
    flow.live = flow.recorder.live ? live : null;
    if (!flow.recorder.live) transcriber.cancel(); // this browser can't stream: transcribe after recording
    flow.phase = 'listening';
    flow.stopAt = part.to;
    flow.partLength = part.to != null ? part.to - part.from : null;
    flow.mode = mode();
    flow.listenStarted = performance.now();
    if (player?.playVideo) {
      player.unMute?.();
      player.seekTo(part.from, true);
      player.playVideo();
    }
    layout();
    hint(
      elsewhere
        ? `Play the video in the YouTube tab. ${flow.partLength ? `Listening stops after ${formatTime(flow.partLength)} of music, or` : 'When the part is over,'} press Stop sharing in Chrome's bar or come back and press Stop.`
        : youtube
          ? controlled
            ? `Listening while the video plays. It stops by itself ${part.to ? `at ${formatTime(part.to)}` : 'at the end'}, or press Stop.`
            : 'Listening. Press play on the video, then Stop when the part is over.'
          : 'Recording. Press Stop when you are done.'
    );
    $('listen-note').textContent = `Writing out ${MODE_NAMES[flow.mode]}`;
    flow.title = document.title;
    document.title = '● Listening… Tab to Sheet';
    flow.recorder.onEnd(() => finishListening());
    let quiet = 0;
    let stuckHinted = false;
    // A timer rather than animation frames: it keeps running while the
    // person is in the YouTube tab.
    const tick = () => {
      if (flow.phase !== 'listening') return;
      const now = performance.now();
      if (controlled) {
        const t = player.getCurrentTime?.() ?? 0;
        if (t !== flow.lastVideoTime) {
          flow.lastVideoTime = t;
          flow.lastVideoMove = now;
        }
        const duration = player.getDuration?.() || 0;
        if (!flow.videoDuration && duration && !flow.lastVideoMove) flow.videoDuration = duration;
        const ad = flow.videoDuration > 0 && duration > 0 && Math.abs(duration - flow.videoDuration) > 2;
        flow.videoPlaying = player.getPlayerState() === 1 && now - flow.lastVideoMove < 500 && t >= part.from - 1 && !ad;
        if (!flow.videoPlaying && !stuckHinted && now - flow.listenStarted > 12000 && flow.pushed < 1) {
          stuckHinted = true;
          hint("The video hasn't started. Press play on it. If it won't play here, press Stop and choose Play it on YouTube instead.");
        }
      }
      const level = flow.recorder.level();
      const seconds = flow.recorder.live ? flow.pushed : flow.recorder.seconds();
      $('record-level').firstElementChild.style.width = `${Math.round(level * 100)}%`;
      $('record-time').textContent = formatTime(seconds);
      roll.setView({ from: Math.max(0, seconds - 12), to: Math.max(12, seconds), now: seconds });
      quiet = level > 0.02 ? 0 : quiet + 1;
      if (quiet === 40 && (!controlled || flow.videoPlaying)) {
        hint(elsewhere ? 'Waiting for sound. Play the video in the YouTube tab (and check "Share tab audio" was on).' : youtube ? 'No sound yet. Is the video playing? If not, press play on it.' : 'No sound yet. Is the microphone on and near the music?');
      }
      if (controlled && flow.stopAt && player.getCurrentTime() >= flow.stopAt) {
        finishListening();
        return;
      }
      if (elsewhere && flow.partLength && flow.soundAt != null && flow.pushed - flow.soundAt >= flow.partLength) {
        finishListening();
        return;
      }
      flow.timer = setTimeout(tick, 100);
    };
    tick();
  }

  function stopRecorder() {
    clearTimeout(flow.timer);
    if (flow.title) document.title = flow.title;
    const recorder = flow.recorder;
    flow.recorder = null;
    return recorder ? { recorder, done: recorder.stop() } : null;
  }

  /** Gives up on the current listening (the video can't be played, for one). */
  function abandonListening(message) {
    if (flow.phase !== 'listening') return;
    stopRecorder();
    transcriber.cancel();
    flow.live = null;
    backToSetup(message);
  }

  async function finishListening() {
    if (flow.phase !== 'listening') return;
    const stopped = stopRecorder();
    flow.player?.pauseVideo?.();
    flow.phase = 'writing';
    layout();
    hint('');
    const seconds = flow.live ? flow.pushed : stopped.recorder.seconds();
    const blob = await stopped.done;
    if (seconds < 1.5 || !blob.size) {
      backToSetup(
        flow.source === 'youtube' && seconds < 1.5
          ? "No sound came through from the video. Make sure it plays, and that \"Share tab audio\" is on when you share."
          : 'That recording is too short. Record at least a few seconds.'
      );
      transcriber.cancel();
      flow.live = null;
      return;
    }
    const name = flow.source === 'youtube' ? flow.name : 'Recording';
    const artist = flow.source === 'youtube' ? flow.artist : '';
    let url = URL.createObjectURL(blob);
    try {
      let result;
      if (flow.live) {
        const live = flow.live;
        flow.live = null;
        live.end();
        // Usually only the last moment is left; on a slow computer, more.
        const started = performance.now();
        const heardAtStop = flow.heard;
        setProgress(Math.min(0.99, heardAtStop / seconds), 'Writing out the last notes…');
        flow.onProgress = ({ seconds: heard }) => {
          const left = Math.max(0, seconds - heard);
          const elapsed = (performance.now() - started) / 1000;
          const speed = elapsed > 2 && heard > heardAtStop ? (heard - heardAtStop) / elapsed : null;
          setProgress(Math.min(0.99, heard / seconds), left > 3 && speed ? `Writing out the notes… about ${formatLeft(left / speed)} left` : 'Writing out the last notes…');
        };
        result = await live.result;
        // Play back exactly what was transcribed (no ads or pauses), in step with the music.
        if (result.audio?.length) {
          URL.revokeObjectURL(url);
          url = URL.createObjectURL(wavBlob(result.audio, 22050));
        }
      } else {
        const buffer = await decodeAudio(blob);
        result = await runModel(await forModel(buffer));
      }
      await complete(result, { name, artist, url, mode: flow.mode });
    } catch (err) {
      URL.revokeObjectURL(url);
      if (!err.cancelled) backToSetup(`Couldn't transcribe this recording: ${err.message || err}`);
    }
  }

  /** Transcribes a whole recording, showing progress and the notes as they are found. */
  function runModel(audio) {
    const started = performance.now();
    const total = audio.length / 22050;
    roll.clear();
    roll.placeholder('Notes appear here as they are found');
    roll.setView({ from: 0, to: total, now: null });
    setProgress(0, 'Getting the listener ready…');
    return transcriber.transcribe(audio, workerSettings(), {
      onPartial: ({ notes, from }) => roll.update(notes, from),
      onProgress: ({ value }) => {
        if (value == null) return;
        const elapsed = (performance.now() - started) / 1000;
        const left = value > 0.1 ? (elapsed / value) * (1 - value) : null;
        setProgress(value, `Writing out the notes… ${Math.round(value * 100)}%${left != null && left > 3 ? `, about ${formatLeft(left)} left` : ''}`);
        roll.setView({ now: value * total });
      }
    });
  }

  async function transcribeFile() {
    const part = readPart(flow.buffer.duration);
    if (!part) return;
    showError('');
    flow.phase = 'writing';
    flow.mode = mode();
    layout();
    $('listen-note').textContent = `Writing out ${MODE_NAMES[flow.mode]}`;
    $('record-time').textContent = formatTime((part.to ?? flow.buffer.duration) - part.from);
    try {
      const audio = await forModel(flow.buffer, part.from, part.to ?? flow.buffer.duration);
      const result = await runModel(audio);
      const url = flow.url;
      flow.url = null; // the panel's player owns it now
      await complete(result, { name: flow.name, url, mode: flow.mode, offset: part.from });
      forgetFile();
    } catch (err) {
      if (!err.cancelled) backToSetup(`Couldn't transcribe this recording: ${err.message || err}`);
    }
  }

  function backToSetup(message = '') {
    flow.phase = 'setup';
    setProgress(null);
    layout();
    setupHint();
    showError(message);
  }

  /** Finds the beats, chords and bars, writes the music and shows it. */
  async function complete(result, { name, artist = '', url, mode: chosen, offset = 0 }) {
    if (!result.notes.length) throw new Error('No notes were heard. Check that the recording has sound, or try a louder part.');
    setProgress(1, 'Laying out the music…');
    await new Promise((r) => setTimeout(r, 30)); // let the message show
    let analysis = null;
    try {
      analysis = analyzeRecording({ notes: result.notes, ...result.features });
    } catch (err) {
      console.warn('Beat tracking failed; using a steady tempo.', err);
    }
    if (current?.url) URL.revokeObjectURL(current.url);
    current = {
      id: result.id,
      notes: result.notes,
      analysis,
      name,
      artist,
      url,
      offset,
      settings: { mode: chosen, meter: 'auto', tempoScale: 1, bpm: null, beatTime: null, barShift: 0, grid: null, sensitivity: 'normal' }
    };
    const shown = await render();
    // Automated tests read the result here; nothing is kept otherwise.
    if (window.__tab2sheetTest) window.__tab2sheetTest({ notes: result.notes, features: result.features, analysis, bundle: current.bundle, seconds: result.seconds, backend: result.backend });
    flow.phase = 'setup';
    setProgress(null);
    if (shown) {
      dialog.close();
      if (document.hidden) {
        // Finished while the person was in the YouTube tab: say so in this tab's title.
        const title = document.title;
        document.title = '✓ Music written out · Tab to Sheet';
        document.addEventListener('visibilitychange', () => (document.title = title), { once: true });
      }
    } else {
      backToSetup("Couldn't show the music.");
    }
  }

  // -------------------------------------------------------------------------
  // The score and the Transcription panel
  // -------------------------------------------------------------------------

  async function render() {
    const s = current.settings;
    const bundle = notesToBundle(current.notes, {
      mode: s.mode,
      analysis: current.analysis,
      tempoScale: s.tempoScale,
      bpm: s.bpm || undefined,
      beatTime: s.beatTime ?? undefined,
      beatsPerBar: s.meter === 'auto' ? undefined : Number(s.meter),
      barShift: s.barShift,
      grid: s.grid || undefined,
      minVelocity: SENSITIVITY[s.sensitivity].minVelocity,
      title: current.name,
      artist: current.artist || 'Transcribed from a recording'
    });
    current.bundle = bundle;
    current.written = bundle.transcription;
    const shown = await host.show(bundle);
    if (shown) syncPanel();
    return shown;
  }

  function syncPanel() {
    const s = current.settings;
    const w = current.written;
    if ($('tx-audio').getAttribute('src') !== current.url) $('tx-audio').src = current.url;
    $('tx-mode').value = s.mode;
    const key = current.bundle.key;
    const pretty = (name) => name.replace(/^([A-G])b/, '$1♭').replace(/^([A-G])#/, '$1♯');
    $('tx-summary').textContent = [key ? `Key of ${pretty(key.name)}` : '', `${w.bpm} bpm`, `${w.beatsPerBar}/4`].filter(Boolean).join(' · ');
    $('tx-bpm').value = String(w.bpm);
    $('tx-bpm-note').textContent = w.followsBeats ? 'follows the recording' : 'steady';
    $('tx-meter').value = s.meter;
    $('tx-meter').options[0].textContent = s.meter === 'auto' ? `Automatic (${w.beatsPerBar})` : 'Automatic';
    $('tx-grid').value = String(w.grid);
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

  /** Half or double tempo: follows the beats found when it can, else a steady pulse. */
  function scaleTempo(factor) {
    if (!current) return;
    const s = current.settings;
    const scale = s.tempoScale * factor;
    if (!s.bpm && current.analysis && scale >= 0.5 && scale <= 2) update({ tempoScale: scale });
    else update({ bpm: Math.max(30, Math.min(300, Math.round(current.written.bpm * factor))), beatTime: current.written.beatTime });
  }

  /** Called whenever the app shows a score: the panel only belongs to transcriptions. */
  function scoreShown(bundle) {
    const isTranscription = !!current && bundle === current.bundle;
    $('tx-panel').hidden = !isTranscription;
    if (!isTranscription && current && flow.phase === 'setup') {
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
    if (flow.phase === 'listening') stopRecorder();
    if (flow.phase !== 'setup') transcriber.cancel();
    flow.live = null;
    flow.phase = 'setup';
    clearVideo();
    forgetFile();
    setProgress(null);
    showError('');
  });
  for (const tab of dialog.querySelectorAll('.source-tab')) tab.addEventListener('click', () => selectSource(tab.dataset.source));
  $('youtube-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadVideo($('youtube-input').value);
  });
  $('youtube-input').addEventListener('paste', () => setTimeout(() => youtubeId($('youtube-input').value) && loadVideo($('youtube-input').value)));
  $('switch-to-mic').addEventListener('click', () => selectSource('mic'));
  $('dialog-file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) useFile(file);
  });
  const drop = $('file-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) useFile(file);
  });
  $('file-change').addEventListener('click', () => {
    forgetFile();
    layout();
    $('dialog-file-input').click();
  });
  $('tx-go').addEventListener('click', () => {
    if (flow.source === 'youtube' && !canRecordTab()) selectSource('mic');
    else if (flow.source === 'file') transcribeFile();
    else startListening();
  });
  $('record-stop').addEventListener('click', finishListening);
  $('tx-cancel').addEventListener('click', () => {
    transcriber.cancel();
    backToSetup('');
  });
  window.addEventListener('resize', () => !$('listen').hidden && roll.draw());

  $('tx-mode').addEventListener('change', (e) => update({ mode: e.target.value, grid: null }));
  $('tx-meter').addEventListener('change', (e) => update({ meter: e.target.value, barShift: 0 }));
  $('tx-grid').addEventListener('change', (e) => update({ grid: Number(e.target.value) }));
  $('tx-sensitivity').addEventListener('change', (e) => update({ sensitivity: e.target.value }));
  $('tx-bpm').addEventListener('change', (e) => {
    const bpm = Math.round(Number(e.target.value));
    if (bpm >= 30 && bpm <= 300) update({ bpm, beatTime: current?.written.beatTime });
    else syncPanel();
  });
  $('tx-half').addEventListener('click', () => scaleTempo(0.5));
  $('tx-double').addEventListener('click', () => scaleTempo(2));
  $('tx-shift-left').addEventListener('click', () => current && update({ barShift: current.settings.barShift + 1 }));
  $('tx-shift-right').addEventListener('click', () => current && update({ barShift: current.settings.barShift - 1 }));
  $('tx-new').addEventListener('click', () => host.home());

  return { open, scoreShown, isYouTubeLink: (text) => !!youtubeId(text) };
}
