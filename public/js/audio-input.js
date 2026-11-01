// Getting audio in for transcription: YouTube links, recording a browser tab
// or the microphone, decoding files, and talking to the transcriber worker.

const MODEL_RATE = 22050; // the transcription model listens at 22.05 kHz, mono

/** The video id in a YouTube link (watch, youtu.be, shorts, embed, music), or null. */
export function youtubeId(text) {
  let url;
  try {
    url = new URL(String(text || '').trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1] || null;
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** Whether this browser can record the sound of a tab (Chrome and Edge on a computer). */
export function canRecordTab() {
  const ua = navigator.userAgent;
  const chromium = /Chrome\/|Edg\//.test(ua) && !/Mobile|Android/.test(ua);
  return chromium && !!navigator.mediaDevices?.getDisplayMedia;
}

export function canRecordMic() {
  return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

// Recording settings that keep the music as it is (no voice-call processing).
const CLEAN_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

// An audio worklet that hands the sound to the page in pieces, for
// transcribing while recording. Mono, at the context's sample rate.
const TAP_SOURCE = `
class Tab2SheetTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const a = input[0], b = input[1];
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? (a[i] + b[i]) / 2 : a[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tab2sheet-tap', Tab2SheetTap);
`;
let tapUrl = null;

/**
 * Records a stream's sound. Returns { stop() -> Promise<Blob>, level() -> 0..1,
 * seconds() -> number, onEnd(fn), live } where live says whether onSamples
 * receives the sound while recording. level() is for a meter showing sound is coming in.
 */
async function recordStream(stream, { onSamples = null } = {}) {
  const audioTracks = stream.getAudioTracks();
  const audioStream = new MediaStream(audioTracks);
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t));
  const recorder = new MediaRecorder(audioStream, type ? { mimeType: type, audioBitsPerSecond: 160000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ctx = new AudioContext();
  ctx.resume().catch(() => {}); // created after an await, so make sure it runs
  const source = ctx.createMediaStreamSource(audioStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  let live = false;
  if (onSamples && ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      tapUrl ||= URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(tapUrl);
      const tap = new AudioWorkletNode(ctx, 'tab2sheet-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      // Silent output: the node only runs when connected to the speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(tap);
      tap.connect(mute).connect(ctx.destination);
      tap.port.onmessage = ({ data }) => onSamples(data, ctx.sampleRate);
      live = true;
    } catch {
      live = false; // transcribed after recording instead
    }
  }

  const started = performance.now();
  let endHandlers = [];
  let finished = null;
  const stop = () => {
    if (!finished) {
      finished = new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      });
      if (recorder.state !== 'inactive') recorder.stop();
      for (const t of stream.getTracks()) t.stop();
      ctx.close().catch(() => {});
    }
    return finished;
  };
  // Sharing stopped from the browser's own bar: finish the recording.
  for (const t of audioTracks) t.addEventListener('ended', () => endHandlers.forEach((fn) => fn()));
  recorder.start(1000);
  return {
    stop,
    live,
    seconds: () => (performance.now() - started) / 1000,
    level() {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      return Math.min(1, peak * 1.6);
    },
    onEnd(fn) {
      endHandlers.push(fn);
    }
  };
}

/**
 * Records the sound of a browser tab: the browser asks which tab to share.
 * Throws a friendly error when no sound is shared.
 */
export async function startTabRecording(options = {}) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // browsers require it; only the sound is kept
    audio: { ...CLEAN_AUDIO, suppressLocalAudioPlayback: false },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    systemAudio: 'include'
  });
  if (!stream.getAudioTracks().length) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error('No sound was shared. Try again, choose this tab, and turn on "Share tab audio".');
  }
  for (const t of stream.getVideoTracks()) t.stop();
  return recordStream(stream, options);
}

export async function startMicRecording(options = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: CLEAN_AUDIO });
  return recordStream(stream, options);
}

/** Decodes any audio or video file the browser can play. Returns an AudioBuffer. */
export async function decodeAudio(blob) {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error("This file's sound couldn't be read. Try an MP3, WAV or M4A file.");
  } finally {
    ctx.close().catch(() => {});
  }
}

/** Mixes to mono at the model's rate, keeping only from..to seconds. */
export async function forModel(buffer, from = 0, to = buffer.duration) {
  const start = Math.max(0, Math.min(from, buffer.duration));
  const end = Math.max(start + 0.5, Math.min(to || buffer.duration, buffer.duration));
  const ctx = new OfflineAudioContext(1, Math.ceil((end - start) * MODEL_RATE), MODEL_RATE);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0, start, end - start);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

/** Talks to the transcriber worker (src/transcriber-worker.js). */
export class Transcriber {
  constructor(workerUrl, modelUrl) {
    this.workerUrl = workerUrl;
    this.modelUrl = modelUrl;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(this.workerUrl);
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      if (data.type === 'progress') job.onProgress?.(data);
      else if (data.type === 'partial') job.onPartial?.(data);
      else {
        this.pending.delete(data.id);
        if (data.type === 'error') job.reject(new Error(data.message));
        else job.resolve({ ...data, id: data.id });
      }
    };
    this.worker.onerror = (e) => {
      for (const job of this.pending.values()) job.reject(new Error(e.message || "The transcriber couldn't start in this browser."));
      this.pending.clear();
      this.worker = null;
    };
    return this.worker;
  }

  /** Loads the listening model ahead of time, so transcribing starts at once. */
  warm() {
    this.ensureWorker().postMessage({ type: 'start', id: 0, modelUrl: this.modelUrl, settings: {} });
  }

  job(id, handlers) {
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, ...handlers }));
  }

  /**
   * Transcribes while recording. Returns { push(samples, sampleRate), end(), result }
   * where result resolves with { id, notes, features, seconds, backend }.
   */
  live(settings, handlers = {}) {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    const result = this.job(id, handlers);
    worker.postMessage({ type: 'start', id, modelUrl: this.modelUrl, settings, live: true });
    return {
      id,
      result,
      push: (samples, sampleRate) => worker.postMessage({ type: 'audio', id, samples, sampleRate }, [samples.buffer]),
      end: () => worker.postMessage({ type: 'end', id })
    };
  }

  /** Transcribes a whole recording (mono, 22050 Hz). Resolves like live().result. */
  transcribe(audio, settings, handlers = {}) {
    const id = this.nextId++;
    const result = this.job(id, handlers);
    this.ensureWorker().postMessage({ type: 'transcribe', id, audio, modelUrl: this.modelUrl, settings }, [audio.buffer]);
    return result;
  }

  /** Reads the notes of the last transcription again with other settings. */
  notes(id, settings) {
    const result = this.job(id, {});
    this.ensureWorker().postMessage({ type: 'notes', id, settings });
    return result;
  }

  /** Stops whatever is running (the worker is restarted next time). */
  cancel() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    for (const job of this.pending.values()) job.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    this.pending.clear();
  }
}
