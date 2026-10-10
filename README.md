# Tab to Sheet

Turn any Songsterr tab into printable sheet music: standard notation, tablature, or both. Paste a link or search for a song, pick your tracks, and print it or save it as a PDF.

**Use it online: <https://shibeeee.github.io/songsterr-to-sheet-music/>**

![The score view](docs/screenshot.png)

## What it does

- **Paste a Songsterr link or search by name.** If the link ends in `t2` (or another track number), that track opens first.
- **Notes + Tab, Notes, or Tab**, plus optional rhythm under the tab, rhythm slashes, chord names, section names and tempo marks.
- **Choose tracks.** Show one instrument or several stacked in one score; each track shows its tuning.
- **Print or save as PDF** on A4 or US Letter, always laid out as pages. Choose how many bars go on each line.
- **Download** as Guitar Pro (`.gp`), MIDI (`.mid`), alphaTex (`.atex`) or the raw Songsterr data (`.json`, which reopens later without an internet connection).
- **Listen along**: play, pause, seek, loop (drag across bars to loop a section), count-in, metronome, speed from 25% to 150%, and per-track mute and solo.
- **Open your own files**: Guitar Pro 3 to 7, MusicXML, alphaTex or saved Songsterr data. Drag a file onto the page or use **Open file**.
- **Remembers** your recent songs and display settings in your browser.
- Keyboard shortcuts: <kbd>Space</kbd> play or pause, <kbd>Esc</kbd> stop, <kbd>L</kbd> loop, <kbd>M</kbd> metronome, <kbd>+</kbd>/<kbd>-</kbd> size, <kbd>P</kbd> print.
- Works on phones, and follows your system's light or dark setting.

Supported techniques include ties, hammer-ons and pull-offs, slides, bends, vibrato, palm mutes, let ring, dead and ghost notes, harmonics, accents, staccato, grace notes, tuplets, strums, pick strokes, dynamics, repeats, alternate endings, and time signature and tempo changes.

## How the website gets songs

The website is static (GitHub Pages), so your browser does the fetching. It tries these routes in order and remembers the one that worked:

1. **Directly from Songsterr.**
2. **A relay of your own**, if the site or you have one configured (see below).
3. **Public relays** (free CORS relay services, which come and go).

If none of them answers, the page explains the fallbacks: a **bookmark** you click on the Songsterr page, setting up a relay, or running the app yourself. Most of the time you won't need any of them.

### Optional: a relay of your own

`relay/worker.js` is a small Cloudflare Worker (free plan) that fetches from Songsterr for the site. It only forwards requests to Songsterr's own addresses, so it can't be used as an open proxy. To set it up:

1. In Cloudflare: **Workers & Pages → Create → Create Worker**, paste `relay/worker.js`, and deploy.
2. In this GitHub repo: **Settings → Secrets and variables → Actions → Variables**, add `RELAY_URL` with the worker's address (for example `https://tab-relay.yourname.workers.dev`).
3. Re-run the **Deploy website** workflow. The site will use your relay for everyone.

You can also paste a relay address under "If a Songsterr link won't load" on the home page, which only affects your browser.

## Run it yourself

With your own copy, links always work, because the small server fetches from Songsterr on your behalf. You need [Node.js](https://nodejs.org) 18.17 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. Set `PORT` to use another port, or `HOST=0.0.0.0` to reach it from other devices on your network.

## Project layout

| Path | What it is |
| --- | --- |
| `public/index.html`, `public/css/styles.css` | The page. |
| `public/js/app.js` | The interface: loading, options, tracks, player, print, export. |
| `public/js/convert.js` | Turns Songsterr's JSON into an [alphaTab](https://alphatab.net) score. |
| `public/js/songsterr.js` | Talks to Songsterr: link parsing, search, song and track download. Shared by the browser and the server. |
| `public/js/sources.js` | How the browser reaches Songsterr (server, direct, relays). |
| `public/js/bookmarklet.js` | The fallback bookmark. |
| `public/js/storage.js` | Recent songs and saved settings. |
| `server.js` | Optional local server (`npm start`). |
| `relay/worker.js` | Optional relay for the hosted site. |
| `scripts/build-static.js` | Builds the static site into `dist/` (`npm run build`). |
| `.github/workflows/pages.yml` | Tests, builds and publishes the site on every push. |
| `public/demo/demo-song.json` | An original practice exercise used for the example and the tests. |

Songsterr has no official public API for tab data, so if they change their site the fetching code may need updating. Files you open yourself don't depend on Songsterr at all.

## Tests

```bash
npm test
```

## Notes

For personal practice. Tabs belong to Songsterr and its contributors, and songs to their writers, so please respect Songsterr's terms and don't redistribute what you download.

Notation, playback and file export come from [alphaTab](https://github.com/CoderLine/alphaTab) (MPL-2.0), which ships with the Bravura music font and the Sonivox sound font.
