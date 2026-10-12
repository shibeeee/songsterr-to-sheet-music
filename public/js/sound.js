// Instrument sounds for playback.
//
// Two sets: the small one that ships with alphaTab (1.3 MB, thin sounding)
// and GeneralUser GS (32 MB, much fuller). Downloads are kept in the
// browser's Cache Storage so later visits (and offline use) load instantly.

export const SOUND_SETS = {
  better: { path: 'vendor/sounds/GeneralUser-GS.sf2', label: 'Better', megabytes: 32 },
  small: { path: 'vendor/alphatab/soundfont/sonivox.sf2', label: 'Small', megabytes: 1.3 }
};

const CACHE_NAME = 'tab2sheet-sounds-v2';
const OLD_CACHES = ['tab2sheet-sounds-v1']; // held the previous 24 MB set

async function openCache() {
  try {
    if (!('caches' in window)) return null;
    for (const old of OLD_CACHES) caches.delete(old).catch(() => {});
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // not available (private mode, insecure context)
  }
}

/** True when the set is already stored in this browser. */
export async function isSoundCached(url) {
  const cache = await openCache();
  if (!cache) return false;
  try {
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * Returns the sound set's bytes, from Cache Storage or the network.
 * @param {(loaded: number, total: number) => void} onProgress
 */
export async function fetchSound(url, onProgress = () => {}) {
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch {
      // fall through to the network
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`the sounds couldn't be downloaded (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let bytes;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    onProgress(bytes.length, bytes.length);
  }

  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
      // storage full or blocked: it still plays, it just downloads again next time
    }
  }
  return bytes;
}
