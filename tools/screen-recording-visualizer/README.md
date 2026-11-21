# Screen recording visualizer

A page for looking at what Faceclaw sent to the glasses over a stretch of time: which frames
were rendered and how long each took to reach the display, what every Bluetooth message
carried, where the bytes went, and what was on the screen at each moment.

It reads the recordings the phone app makes from *Record screen* (FORMAT.md).

## Making and opening a recording

1. In the phone app's menu choose **Record screen**, do the thing you want to look at on the
   glasses, then tap **Stop recording**. The file is saved beside the screenshots.
2. `scripts/pull-screen-recording.sh` copies the newest recording to the current directory
   (`--all` for every one; other arguments go to `adb`, e.g. `-s <device>`).
3. Open `index.html` in a browser (straight from disk is fine: there is no build step and
   nothing is uploaded) and drop the file on it. A gzipped recording opens too.

When the page is served over HTTP, `index.html?file=<url>` opens a recording by URL, and
`?theme=light` or `?theme=dark` overrides the system's color scheme.

## What it shows

- **The display**, replayed from the messages: the recording starts with the glasses' display
  state (screen buffer, resource cache, root display list), and each message is applied to a
  lens at the moment that lens acknowledged it. *Display* is what the lens shows (the last
  presented frame, with display-list animations running), *Screen buffer* is what has been drawn
  so far whether or not it has been presented, and *Phone preview* is the phone's own composite
  of what it meant to show. *By source* tints every pixel by the kind of bytes that put it
  there: sent as screen pixels, drawn from a shell surface or an uploaded image or font, or drawn
  on the glasses.
- **The timeline**: each frame tree from its start to the end of everything it caused (with a
  notch where its first pixels reached the glasses), each message from written to acknowledged,
  each change of the display, and the bytes sent per second split by category.
- **Frames**: a frame's timing log, as in `frame-timings.txt`, with its spans drawn as bars and
  the messages it produced.
- **Messages**: what a message carried, call by call, its size before and after the link's
  compression, and when each lens acknowledged it. Selecting one outlines where it drew.
- **Bandwidth**: totals by category for the whole recording or the visible range.
- **Resources**: the resource cache at the playhead.
- **Log**: the session log around the playhead.

The *Replay check* compares the replayed display with the phone's own composite at the start
and end of the recording. A difference at the end usually means frames were still in flight
when recording stopped; one at the start means the replay (or the recorded state) is wrong.

## Files

- `recording.js`: reads a recording into messages, frames and per-lens lists of what to replay;
  decodes messages and attributes their bytes.
- `emulator.js`: the glasses' side of the draw protocol, a port of the phone's reference
  interpreter (`DisplayListRenderer.kt`), with seeking.
- `app.js`, `index.html`, `style.css`: the page.

`recording.js` and `emulator.js` also load under Node. `tests/screen-recording.test.cjs` (part of
`npm test`) replays recordings that the Kotlin tests produced and compares the result, pixel for
pixel, with what the Kotlin reference renderer drew. After changing the draw protocol, the
recorder or those tests, refresh the fixtures with `scripts/update-screen-recording-fixtures.sh`.
