// The "Tab to Sheet" bookmarklet.
//
// Songsterr doesn't allow other websites to read its tabs, so the static
// (GitHub Pages) version of the app can't fetch them itself. The bookmarklet
// runs on the Songsterr tab page instead, where those requests are allowed,
// then opens the app and hands it the song with postMessage. If the hand-off
// can't happen (pop-up blocked, browser isolation), it saves the song as a
// .json file that the app can open.

const SONGSTERR_ORIGIN = /^https:\/\/(www\.)?songsterr\.com$/;
const READY = 'tab2sheet-ready';
const BUNDLE = 'tab2sheet-bundle';

// Runs on songsterr.com. Must be self-contained: it is serialised into the
// bookmark, so it can't reference anything outside its own body.
/* eslint-disable */
function bookmarkletMain(app) {
  var m = location.pathname.match(/-s(\d+)(?:t\d+)?\/?$/);
  if (location.hostname.indexOf('songsterr.com') < 0 || !m) {
    alert('Tab to Sheet: open a song tab on songsterr.com, then click this bookmark.');
    return;
  }
  var songId = Number(m[1]);
  var target = new URL(app).origin;
  var win = window.open(app + '#receive', '_blank');

  function parseState(text) {
    try {
      var c = JSON.parse(text).meta.current;
      return c && c.revisionId ? c : null;
    } catch (e) {
      return null;
    }
  }
  function fromHtml(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var el = doc.getElementById('state');
    return el ? parseState(el.textContent) : null;
  }
  function getState() {
    var el = document.getElementById('state');
    var cur = el ? parseState(el.textContent) : null;
    if (cur && Number(cur.songId) === songId) return Promise.resolve(cur);
    return fetch(location.href).then(function (r) { return r.text(); }).then(fromHtml);
  }
  var hosts = ['https://dqsljvtekg760.cloudfront.net', 'https://d3d3l6a6rcgkaf.cloudfront.net'];
  function getTrack(cur, part, i) {
    var path = '/' + cur.songId + '/' + cur.revisionId + '/' + cur.image + '/' + part + '.json';
    i = i || 0;
    return fetch(hosts[i] + path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function (err) {
      if (i + 1 < hosts.length) return getTrack(cur, part, i + 1);
      throw err;
    });
  }
  function saveFile(bundle) {
    var blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((bundle.artist ? bundle.artist + ' - ' : '') + bundle.title).replace(/[\\/:*?"<>|]+/g, '') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    alert('Tab to Sheet: saved "' + a.download + '". Open it on the Tab to Sheet page with "Open a file".');
  }
  function fail(message) {
    if (win) try { win.postMessage({ type: 'tab2sheet-error', message: message }, target); } catch (e) {}
    alert('Tab to Sheet: ' + message);
  }

  getState().then(function (cur) {
    if (!cur) throw new Error('could not find the song data on this page.');
    var tracks = cur.tracks || [];
    return Promise.all(tracks.map(function (t, i) {
      var part = t.partId == null ? i : t.partId;
      return getTrack(cur, part).then(function (d) { return { meta: t, data: d }; }, function () { return null; });
    })).then(function (list) {
      var bundle = {
        songId: cur.songId, revisionId: cur.revisionId, title: cur.title || 'Untitled', artist: cur.artist || '',
        source: location.href, warnings: [], tracks: []
      };
      list.forEach(function (t, i) {
        if (t) bundle.tracks.push(t);
        else bundle.warnings.push('Track "' + (tracks[i].title || tracks[i].name || i) + '" could not be downloaded.');
      });
      if (!bundle.tracks.length) throw new Error('none of the tracks could be downloaded.');
      if (!win) return saveFile(bundle);
      var sent = false;
      function onMessage(e) {
        if (e.source !== win || e.data !== 'tab2sheet-ready' || sent) return;
        sent = true;
        removeEventListener('message', onMessage);
        win.postMessage({ type: 'tab2sheet-bundle', bundle: bundle }, target);
      }
      addEventListener('message', onMessage);
      setTimeout(function () {
        if (sent) return;
        removeEventListener('message', onMessage);
        saveFile(bundle);
      }, 15000);
    });
  }).catch(function (err) {
    fail(err.message || String(err));
  });
}
/* eslint-enable */

export function bookmarkletSource(appUrl) {
  return `javascript:${encodeURIComponent(`(${bookmarkletMain.toString()})(${JSON.stringify(appUrl)});void 0`)}`;
}

/** Points the drag-me link at this copy of the app. */
export function setupBookmarklet(anchor, appUrl) {
  if (!anchor) return;
  anchor.href = bookmarkletSource(appUrl);
  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    alert('Drag this button to your bookmarks bar, then click it while viewing a tab on songsterr.com.');
  });
}

/**
 * When the app was opened by the bookmarklet (#receive), tell it we're ready
 * and wait for the song.
 */
export function listenForBookmarklet({ onWaiting, onBundle, onError }) {
  if (window.location.hash !== '#receive') return;
  const clearHash = () => history.replaceState(null, '', window.location.pathname + window.location.search);
  const opener = window.opener;
  if (!opener) {
    onError(
      'This page lost its connection to Songsterr (your browser isolates the two). The bookmark will save the song as a .json file in a few seconds; open that file here with "Open a file".'
    );
    clearHash();
    return;
  }

  onWaiting();
  let done = false;
  const ping = setInterval(() => opener.postMessage(READY, '*'), 300);
  const stop = () => {
    done = true;
    clearInterval(ping);
    clearHash();
  };
  setTimeout(() => {
    if (done) return;
    stop();
    onError('No song arrived from Songsterr. If a .json file was downloaded instead, open it here with "Open a file".');
  }, 20000);

  window.addEventListener('message', (e) => {
    if (done || !SONGSTERR_ORIGIN.test(e.origin) || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === BUNDLE && e.data.bundle) {
      stop();
      onBundle(e.data.bundle);
    } else if (e.data.type === 'tab2sheet-error') {
      stop();
      onError(`Songsterr: ${e.data.message}`);
    }
  });
}
