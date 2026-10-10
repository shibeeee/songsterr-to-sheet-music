# Tab to Sheet

Paste a Songsterr link and get printable sheet music. Choose **standard notation**, **tab (fret numbers)**, or **both** stacked together, then print it, save it as a PDF, or download it in another format.

![Notes + Tab view](docs/screenshot.png)

## Features

- **Songsterr links in, sheet music out.** Paste a link like `https://www.songsterr.com/a/wsa/artist-song-tab-s12345`. If the link ends in `t2` (or another track number), that track opens first.
- **Notes, Tab, or both.** Switch any time. Tab-only view can show rhythm stems under the numbers, and there's an optional slash-rhythm staff.
- **Pick your tracks.** Show one instrument or stack several (guitar, bass, drums, and so on) in one score.
- **Print / PDF.** Opens a clean A4 print window; choose "Save as PDF" in the print dialog to get a PDF.
- **Download** as Guitar Pro (`.gp`), MIDI (`.mid`), alphaTex text (`.atex`), or the raw Songsterr data (`.json`). The JSON can be reopened later without an internet connection.
- **Listen along** with built-in playback, a speed control and a metronome click. The current note is highlighted as it plays.
- **Open your own files too:** Guitar Pro 3–7, MusicXML, alphaTex, or saved Songsterr JSON. Use the button or drag the file onto the page.
- Page or single-line layout, zoom, and a layout that works on phones.

Supported techniques include ties, hammer-ons/pull-offs, slides, bends, vibrato, palm mutes, let ring, dead and ghost notes, harmonics, accents, staccato, grace notes, tuplets, strums, pick strokes, dynamics, chord names, sections, repeats, alternate endings, time signature changes and tempo changes.

## Use it online

**<https://shibeeee.github.io/songsterr-to-sheet-music/>**

Songsterr doesn't let other websites read its tabs, so the online version gets songs through a bookmark:

1. On the site, open **"Get any song from Songsterr in one click"** and drag the **Tab to Sheet** button to your bookmarks bar.
2. Open any song on songsterr.com.
3. Click the bookmark. The song opens on the site as sheet music, starting on the track you were viewing.

If your browser blocks the pop-up, the bookmark saves the song as a `.json` file instead; open it on the site with **Open a file**. Opening Guitar Pro or MusicXML files and the demo work online with no bookmark needed. Bookmarks are easiest on a computer; on a phone, use a saved `.json` file or run your own copy.

The site is rebuilt and published automatically by GitHub Actions (`.github/workflows/pages.yml`) every time the main branch changes.

## Run it yourself

Running your own copy lets you paste Songsterr links directly, no bookmark needed. You need [Node.js](https://nodejs.org) 18.17 or newer.

```bash
npm install
npm start
```

Then open <http://localhost:3000>. Click **Try the demo** to see an example without a Songsterr link.

Set `PORT` to use a different port. Set `HOST=0.0.0.0` to open it to other devices on your network.

## How it works

```
Browser                         server.js                      Songsterr
───────                         ─────────                      ─────────
paste link ──► /api/songsterr ──► read song id from the link
                                  find the latest revision ──► tab page / metadata API
                                  download every track     ──► CDN track JSON
           ◄── JSON bundle    ◄──
convert.js: Songsterr JSON ► alphaTab score
alphaTab: draws notation + tab, plays audio, prints, exports
```

- `server.js` is a small dependency-free Node server. It's needed because browsers can't fetch from Songsterr directly (cross-origin rules). Results are cached in memory for an hour.
- `lib/songsterr.js` finds the song's current revision and downloads each track's JSON. If one method fails it tries the next, including a mirror CDN.
- `public/js/convert.js` turns Songsterr's JSON into an [alphaTab](https://alphatab.net) score: notes, strings, tuning, durations, tuplets, techniques and song structure.
- `public/js/app.js` is the page: view options, track picker, player, print and downloads.
- `public/js/bookmarklet.js` is the bookmark used by the online version. It runs on the Songsterr page, downloads the song's tracks there, and sends them to the site.
- `scripts/build-static.js` (`npm run build`) builds the static site into `dist/` for GitHub Pages or any other static host.
- `public/demo/demo-song.json` is an original practice exercise used by the demo button and the tests.

Songsterr has no official public API for tab data, so if they change their site the fetch step may need updating. Files you open yourself (Guitar Pro, MusicXML, saved JSON) don't depend on Songsterr at all.

## Tests

```bash
npm test
```

The tests cover the converter (bar lengths, string and pitch mapping, techniques, structure, exports) and the Songsterr fetching logic, using a fake network.

## Notes

This is meant for personal practice. Tab data belongs to Songsterr and its contributors, and songs belong to their writers, so please respect Songsterr's terms of service and don't redistribute what you download.

Rendering, playback and file export are provided by [alphaTab](https://github.com/CoderLine/alphaTab) (MPL-2.0), which ships with the Bravura music font and the Sonivox sound font.
