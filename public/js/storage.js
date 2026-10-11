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

// ---------------------------------------------------------------------------
// Saved edits (IndexedDB: songs can be too big for localStorage)
// ---------------------------------------------------------------------------

const DB_NAME = 'tab2sheet';
const EDITS = 'edits';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser has no storage for saved edits'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(EDITS, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDITS, mode);
    const result = fn(tx.objectStore(EDITS));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @param {{ key: string, json: string, title: string, artist: string, savedAt: number }} record */
export function saveEdits(record) {
  return withStore('readwrite', (store) => store.put(record));
}

export async function loadEdits(key) {
  try {
    return (await withStore('readonly', (store) => store.get(key))) || null;
  } catch {
    return null;
  }
}

export function deleteEdits(key) {
  return withStore('readwrite', (store) => store.delete(key));
}

export async function editedKeys() {
  try {
    return new Set(await withStore('readonly', (store) => store.getAllKeys()));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Per-song view (which tracks are shown, which bars)
// ---------------------------------------------------------------------------

const VIEWS_KEY = 'views';
const VIEWS_MAX = 60;

export function songView(key) {
  const views = read(VIEWS_KEY, {});
  return (views && views[key]) || null;
}

export function rememberSongView(key, view) {
  if (!key) return;
  const views = read(VIEWS_KEY, {}) || {};
  delete views[key];
  views[key] = { ...view, at: Date.now() };
  const keys = Object.keys(views);
  for (const old of keys.slice(0, Math.max(0, keys.length - VIEWS_MAX))) delete views[old];
  write(VIEWS_KEY, views);
}
