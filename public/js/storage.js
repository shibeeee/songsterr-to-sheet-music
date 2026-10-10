// Small wrappers around localStorage. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded and failures are
// silently ignored: preferences are a convenience, never a requirement.

const PREFIX = 'tab2sheet:';

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export const prefs = { get: read, set: write };

const RECENT_KEY = 'recent';
const RECENT_MAX = 12;

/** @returns {{ url: string, title: string, artist: string, at: number }[]} */
export function recentSongs() {
  const list = read(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.url === 'string') : [];
}

export function rememberSong({ url, title, artist }) {
  if (!url) return;
  const list = recentSongs().filter((s) => s.url !== url);
  list.unshift({ url, title: title || 'Untitled', artist: artist || '', at: Date.now() });
  write(RECENT_KEY, list.slice(0, RECENT_MAX));
}

export function forgetSong(url) {
  write(
    RECENT_KEY,
    recentSongs().filter((s) => s.url !== url)
  );
}
