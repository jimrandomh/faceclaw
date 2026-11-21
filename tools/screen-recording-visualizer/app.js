// The page: a replayed display, a timeline of frames / messages / bytes, and detail tabs.
// recording.js reads the file; emulator.js turns its messages back into pixels.
(function () {
  'use strict';

  const Rec = window.FcRecording;
  const Emu = window.FcEmulator;
  const { CATEGORIES } = Rec;
  const $ = (id) => document.getElementById(id);

  /** Build an element. Text always goes in as text: labels in a recording are untrusted. */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /** A color token as the browser resolves it now ("rgb(…)"); the tokens are light-dark() pairs. */
  const resolved = new Map();
  function css(name) {
    let value = resolved.get(name);
    if (value === undefined) {
      const probe = $('probe');
      probe.style.color = 'var(' + name + ')';
      value = getComputedStyle(probe).color;
      resolved.set(name, value);
    }
    return value;
  }
  const categoryColor = (index) => css('--series-' + index);

  function formatBytes(bytes) {
    const n = Math.round(bytes);
    if (n < 10000) return n.toLocaleString('en-US') + ' B';
    if (n < 1e6) return (n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' kB';
    return (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' MB';
  }

  function formatRate(bytesPerSecond) {
    if (bytesPerSecond < 1000) return Math.round(bytesPerSecond) + ' B/s';
    return (bytesPerSecond / 1000).toLocaleString('en-US', { maximumFractionDigits: bytesPerSecond < 10000 ? 1 : 0 }) + ' kB/s';
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return '–';
    if (Math.abs(ms) < 1000) return Math.round(ms) + ' ms';
    if (Math.abs(ms) < 60000) return (ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' s';
    return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
  }

  let app = null;

  /** Seconds since the recording started, to the millisecond. */
  function formatAt(t) {
    const ms = Math.round(t - app.rec.t0);
    return (ms < 0 ? '−' : '') + (Math.abs(ms) / 1000).toFixed(3) + ' s';
  }

  // ---------------------------------------------------------------------
  // Opening a file

  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = false;
  }

  async function openBytes(bytes, name) {
    let rec;
    try {
      rec = await Rec.load(bytes);
    } catch (error) {
      $('app').hidden = true;
      $('empty').hidden = false;
      showError(name + ': ' + error.message);
      return;
    }
    $('error').hidden = true;
    const lenses = rec.createLenses();
    app = {
      rec,
      name,
      lenses,
      players: lenses.map((lens, index) => new Emu.Player(lens, rec.ops[index])),
      /** Per lens, when each PRESENT took effect: the moments the display changed. */
      presents: rec.ops.map((ops) => ops.filter((op) => (op.payload[0] & 127) === Emu.MSG.PRESENT).map((op) => op.t)),
      cursor: rec.t0,
      view: { from: rec.tMin, to: rec.t1 },
      lens: 0,
      source: rec.replayable ? 'display' : 'phone',
      color: 'green',
      speed: 1,
      playing: false,
      tab: 'frame',
      frame: null,
      message: null,
      outlines: [],
      hover: null,
      bandwidthScope: 'all',
      dirty: { screen: true, timeline: true, panel: true },
    };
    padView();
    assignLanes(rec.roots, (frame) => frame.t, (frame) => frame.treeEndT, 5);
    assignLanes(rec.messages, (message) => message.t, (message) => message.endT, 4);
    for (const root of rec.roots) sumFrameBytes(root);
    app.check = replayCheck(rec);
    $('file-name').textContent = name;
    document.title = name + ' – Screen recording';
    $('empty').hidden = true;
    $('app').hidden = false;
    buildControls();
    renderStats();
    schedule();
  }

  function padView() {
    const span = app.rec.t1 - app.rec.tMin;
    app.full = { from: app.rec.tMin - span * 0.01, to: app.rec.t1 + span * 0.02 };
    app.view = { from: app.full.from, to: app.full.to };
  }

  /** Greedy lanes so bars that overlap in time sit on different rows; past `limit`, they share. */
  function assignLanes(items, start, end, limit) {
    const ends = [];
    for (const item of [...items].sort((a, b) => start(a) - start(b))) {
      let lane = ends.findIndex((t) => t <= start(item));
      if (lane < 0) {
        if (ends.length < limit) lane = ends.length;
        else lane = ends.indexOf(Math.min(...ends));
      }
      ends[lane] = Math.max(end(item), start(item) + 1);
      item.lane = lane;
    }
    items.lanes = Math.max(1, ends.length);
  }

  function sumFrameBytes(frame) {
    frame.wireBytes = frame.messages.reduce((sum, message) => sum + message.wireBytes, 0);
    frame.messageCount = frame.messages.length;
    for (const child of frame.children) {
      sumFrameBytes(child);
      frame.wireBytes += child.wireBytes;
      frame.messageCount += child.messageCount;
    }
  }

  function differingPixels(a, b) {
    let count = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) continue;
      if ((a[i] >> 4) !== (b[i] >> 4)) count++;
      if ((a[i] & 15) !== (b[i] & 15)) count++;
    }
    return count;
  }

  /** Compare the replay with the phone's own composites, where a recording has just a few. */
  function replayCheck(rec) {
    if (!rec.replayable || rec.screens.length === 0 || rec.screens.length > 8) return null;
    const lens = rec.createLenses()[0];
    const player = new Emu.Player(lens, rec.ops[0]);
    return rec.screens.map((screen) => {
      player.seek(player.positionAt(screen.t));
      const same = lens.width === screen.width && lens.height === screen.height;
      return { t: screen.t, differing: same ? differingPixels(lens.display(null).pixels, screen.pixels) : -1 };
    });
  }

  // ---------------------------------------------------------------------
  // Controls

  function segmented(container, options, current, onChange) {
    container.replaceChildren(...options.map(([value, label, title]) => el('button', {
      'aria-pressed': String(value === current()),
      title,
      onclick: (event) => {
        for (const button of container.children) button.setAttribute('aria-pressed', String(button === event.currentTarget));
        onChange(value);
      },
    }, label)));
  }

  function buildControls() {
    const { rec } = app;
    const sources = [];
    if (rec.replayable) {
      sources.push(['display', 'Display', 'What the lens shows: the last presented frame']);
      sources.push(['buffer', 'Screen buffer', 'The screen buffer as drawn so far, before it is presented']);
    }
    if (rec.screens.length) sources.push(['phone', 'Phone preview', 'The phone\'s own composite of what it means to show']);
    segmented($('source'), sources, () => app.source, (value) => { app.source = value; invalidate('screen', 'timeline'); });
    segmented($('lens'), [['0', 'Left'], ['1', 'Right']], () => String(app.lens), (value) => {
      app.lens = Number(value);
      selectMessage(app.message, false);
      invalidate('screen', 'timeline', 'panel');
    });
    segmented($('color'), [['green', 'Green'], ['gray', 'Gray'], ['origin', 'By source', 'Tint each pixel by the kind of bytes that put it there']],
      () => app.color, (value) => { app.color = value; app.lut = null; invalidate('screen'); });
    segmented($('speed'), [[0.1, '0.1×'], [0.5, '0.5×'], [1, '1×']], () => app.speed, (value) => { app.speed = value; });

    const tabs = [['frame', 'Frames'], ['message', 'Messages'], ['bandwidth', 'Bandwidth'], ['resources', 'Resources'], ['log', 'Log']];
    $('tabs').replaceChildren(...tabs.map(([key, label]) => el('button', {
      role: 'tab', 'data-tab': key, 'aria-selected': String(key === app.tab), onclick: () => showTab(key),
    }, label)));

    const swatch = (color, line) => el('span', { class: 'swatch' + (line ? ' line' : ''), style: { background: color } });
    $('frame-legend').replaceChildren(
      el('span', { class: 'key' }, swatch('var(--frame-sent)'), 'Frame sent'),
      el('span', { class: 'key' }, swatch('var(--frame-discarded)'), 'Frame discarded'),
      el('span', { class: 'key' }, swatch('var(--status-critical)'), '⚠ Frame timed out or still open'),
    );
    const keys = CATEGORIES.slice(1).map((category, index) => el('span', { class: 'key', title: category.detail }, swatch('var(--series-' + (index + 1) + ')'), category.label));
    $('category-legend').replaceChildren(...keys);
    $('origin-legend').replaceChildren(
      ...[1, 2, 3, 4, 6].map((index) => el('span', { class: 'key', title: CATEGORIES[index].detail }, swatch('var(--series-' + index + ')'),
        ['', 'Sent as screen pixels', 'From a shell surface', 'From an uploaded image', 'Text in an uploaded font', '', 'Drawn on the glasses (stock text, shapes, copies)'][index])),
      el('span', { class: 'key' }, swatch('#8a8a8a'), 'On screen before the recording'),
    );
  }

  function showTab(key) {
    app.tab = key;
    for (const button of $('tabs').children) button.setAttribute('aria-selected', String(button.dataset.tab === key));
    invalidate('panel');
  }

  function invalidate(...parts) {
    for (const part of parts) app.dirty[part] = true;
    schedule();
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame((now) => {
      scheduled = false;
      if (!app) return;
      advance(now);
      if (app.dirty.screen) renderScreen();
      if (app.dirty.timeline) renderTimeline();
      if (app.dirty.panel) renderPanel();
      app.dirty = { screen: false, timeline: false, panel: false };
      if (app.playing || app.animating) invalidate('screen', 'timeline');
    });
  }

  // ---------------------------------------------------------------------
  // The playhead

  function setCursor(t, follow = true) {
    const { rec } = app;
    app.cursor = Math.max(rec.tMin, Math.min(rec.t1, t));
    if (follow && (app.cursor < app.view.from || app.cursor > app.view.to)) {
      const span = app.view.to - app.view.from;
      setView(app.cursor - span * 0.2, app.cursor + span * 0.8);
    }
    app.dirty.screen = app.dirty.timeline = true;
    if (app.tab === 'resources' || app.tab === 'log') app.dirty.panel = true;
    schedule();
  }

  function setView(from, to) {
    const { full } = app;
    const span = Math.max(20, Math.min(full.to - full.from, to - from));
    from = Math.max(full.from, Math.min(full.to - span, from));
    app.view = { from, to: from + span };
    app.dirty.timeline = true;
    // The list views and a visible-range total follow the view.
    if ((app.tab === 'frame' && !app.frame) || (app.tab === 'message' && !app.message) || (app.tab === 'bandwidth' && app.bandwidthScope === 'view')) {
      app.dirty.panel = true;
    }
    schedule();
  }

  /** The moments the picture being shown changes. */
  function changeTimes() {
    if (app.source === 'phone') return app.rec.screens.map((screen) => screen.t);
    if (app.source === 'buffer') return app.rec.ops[app.lens].map((op) => op.t);
    return app.presents[app.lens];
  }

  function stepChange(direction) {
    const times = changeTimes();
    let target = null;
    if (direction > 0) target = times.find((t) => t > app.cursor);
    else target = times.findLast((t) => t < app.cursor);
    if (target === undefined || target === null) target = direction > 0 ? app.rec.t1 : app.rec.tMin;
    setPlaying(false);
    setCursor(target);
  }

  function setPlaying(playing) {
    app.playing = playing;
    app.lastTick = null;
    $('play').textContent = playing ? '⏸' : '▶';
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (playing && app.cursor >= app.rec.t1) app.cursor = app.rec.tMin;
    schedule();
  }

  function advance(now) {
    if (!app.playing) return;
    if (app.lastTick !== null) {
      const next = app.cursor + (now - app.lastTick) * app.speed;
      if (next >= app.rec.t1) {
        setCursor(app.rec.t1);
        setPlaying(false);
        return;
      }
      setCursor(next);
    }
    app.lastTick = now;
  }

  // ---------------------------------------------------------------------
  // The display

  const channels = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);

  /** RGBA (little-endian uint32) per [origin][gray level]. */
  function palette() {
    if (app.lut) return app.lut;
    const lut = new Uint32Array(8 * 16);
    for (let origin = 0; origin < 8; origin++) {
      for (let level = 0; level < 16; level++) {
        const light = Math.pow(level / 15, 0.8);
        let rgb;
        if (app.color === 'origin') {
          // A wash of the category's color over the whole area it drew, brighter where it is lit.
          const base = origin === 0 || origin === 5 || origin === 7 ? [138, 138, 138] : channels(categoryColor(origin));
          const amount = origin === 0 ? light : 0.3 + 0.7 * light;
          rgb = base.map((channel) => channel * amount);
        } else if (app.color === 'green') {
          rgb = [40 * light, 255 * light, 90 * light];
        } else {
          rgb = [255 * light, 255 * light, 255 * light];
        }
        lut[origin * 16 + level] = (255 << 24) | (Math.round(rgb[2]) << 16) | (Math.round(rgb[1]) << 8) | Math.round(rgb[0]);
      }
    }
    app.lut = lut;
    return lut;
  }

  /** The pixels to show at the playhead, and a line of text about them. */
  function picture() {
    const { rec, lens } = app;
    const player = app.players[lens];
    const position = player.positionAt(app.cursor);
    player.seek(position);
    const emulator = app.lenses[lens];
    if (app.source === 'phone') {
      const screen = rec.screenAt(app.cursor);
      if (!screen) return { note: 'No phone composite yet.' };
      return { width: screen.width, height: screen.height, pixels: screen.pixels, origin: null, note: 'Phone composite taken at ' + formatAt(screen.t) + '.' };
    }
    if (!emulator.width) return { note: 'The screen size is unknown until the first frame.' };
    const rejected = [...player.errors].filter(([index]) => index < position);
    const problem = rejected.length ? ' ' + rejected.length + ' message' + (rejected.length === 1 ? ' was' : 's were') + ' rejected (last: ' + rejected[rejected.length - 1][1] + ').' : '';
    if (app.source === 'buffer') {
      return { width: emulator.width, height: emulator.height, pixels: emulator.screen, origin: emulator.screenOrigin,
        note: 'Screen buffer after ' + position + ' of ' + player.ops.length + ' messages.' + problem };
    }
    const shown = emulator.display(app.cursor);
    const since = emulator.presented && emulator.presented.t !== null ? emulator.presented.t : null;
    const pending = position > 0 && since !== null ? player.ops.slice(0, position).filter((op) => op.t > since).length : 0;
    let note = !emulator.presented ? 'Nothing has been presented yet.'
      : since === null ? 'As it was when the recording started.' : 'Presented at ' + formatAt(since) + '.';
    if (pending) note += ' ' + pending + ' later message' + (pending === 1 ? ' is' : 's are') + ' drawn but not yet presented.';
    if (shown.animationPending) note += ' Animating.';
    if (shown.error) note += ' The root list was rejected: ' + shown.error + '.';
    return { width: emulator.width, height: emulator.height, pixels: shown.pixels, origin: shown.origin, animating: shown.animationPending, note: note + problem };
  }

  function renderScreen() {
    const canvas = $('screen');
    const shown = picture();
    app.animating = Boolean(shown.animating) && app.playing;
    $('screen-note').textContent = shown.note || '';
    $('time').textContent = formatAt(app.cursor) + ' of ' + formatAt(app.rec.t1);
    $('origin-legend').hidden = app.color !== 'origin' || app.source === 'phone';
    if (!shown.pixels) {
      canvas.width = app.rec.width || 640;
      canvas.height = app.rec.height || 480;
      return;
    }
    const { width, height, pixels, origin } = shown;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      app.image = null;
    }
    const context = canvas.getContext('2d');
    if (!app.image) app.image = context.createImageData(width, height);
    const out = new Uint32Array(app.image.data.buffer);
    const lut = palette();
    const stride = (width + 1) >> 1;
    for (let y = 0, i = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 0; x < width; x++, i++) {
        const value = pixels[row + (x >> 1)];
        out[i] = lut[(origin ? origin[i] & 7 : 0) * 16 + (x & 1 ? value & 15 : value >> 4)];
      }
    }
    context.putImageData(app.image, 0, 0);
    renderOutlines(width, height);
  }

  /** Where the selected message's draw calls landed. */
  function renderOutlines(width, height) {
    const canvas = $('outlines');
    const scale = 2;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext('2d');
    if (!app.outlines.length || app.source === 'phone') return;
    context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    context.lineWidth = 1;
    for (const rect of app.outlines) {
      context.strokeRect((rect.x + rect.shiftX) * scale + 0.5, rect.y * scale + 0.5, rect.width * scale - 1, rect.height * scale - 1);
    }
  }

  // ---------------------------------------------------------------------
  // Selection

  function selectFrame(frame, moveCursor = true) {
    app.frame = frame;
    if (frame) {
      app.tab = 'frame';
      // Where its pixels landed, if they did; else where it ended.
      if (moveCursor) setCursor(frame.sentT !== null ? frame.sentT : frame.endT !== null ? frame.endT : frame.t);
    }
    showTab(app.tab);
    invalidate('timeline');
  }

  function selectMessage(message, moveCursor = true) {
    app.message = message;
    app.outlines = [];
    if (message) {
      app.tab = 'message';
      const player = app.players[app.lens];
      const index = player.ops.findIndex((op) => op.message === message);
      if (index >= 0) {
        // Replay it alone, noting each rectangle its calls touch.
        const trace = [];
        player.seek(index);
        player.step(trace);
        app.outlines = trace.filter((rect) => rect.target === null && rect.width > 0 && rect.height > 0);
      }
      if (moveCursor) {
        const landed = message.lensAcks[app.lens];
        setCursor(landed !== null ? landed : message.endT);
      }
    }
    showTab(app.tab);
    invalidate('screen', 'timeline');
  }

  // ---------------------------------------------------------------------
  // Timeline

  const TL = { left: 92, right: 14, bar: 6, laneGap: 3, rowGap: 12 };

  function timelineLayout(width) {
    const { rec } = app;
    const rows = {};
    let y = 6;
    const lanes = (count) => count * TL.bar + (count - 1) * TL.laneGap;
    rows.frames = { y, height: lanes(rec.roots.lanes || 1) };
    y += rows.frames.height + TL.rowGap;
    rows.messages = { y, height: lanes(rec.messages.lanes || 1) };
    y += rows.messages.height + TL.rowGap;
    rows.changes = { y, height: 10 };
    y += rows.changes.height + TL.rowGap;
    rows.bytes = { y: y + 4, height: 96 };
    y = rows.bytes.y + rows.bytes.height;
    rows.axis = { y, height: 22 };
    return { rows, height: y + rows.axis.height, plot: { x: TL.left, width: Math.max(50, width - TL.left - TL.right) } };
  }

  const NICE = [1, 2, 5];

  /** The smallest 1/2/5 × 10^n that is at least `minimum`. */
  function niceStep(minimum) {
    let power = Math.pow(10, Math.floor(Math.log10(Math.max(minimum, 1e-9))));
    for (;;) {
      for (const factor of NICE) {
        if (factor * power >= minimum) return factor * power;
      }
      power *= 10;
    }
  }

  /** A filled bar. With `squareBottom` only its top (the data end) is rounded: it stands on a baseline. */
  function rounded(context, x, y, width, height, radius, squareBottom = false) {
    context.beginPath();
    if (squareBottom) {
      const r = Math.max(0, Math.min(radius, width / 2, height));
      context.moveTo(x, y + height);
      context.lineTo(x, y + r);
      context.arcTo(x, y, x + r, y, r);
      context.lineTo(x + width - r, y);
      context.arcTo(x + width, y, x + width, y + r, r);
      context.lineTo(x + width, y + height);
      context.closePath();
    } else {
      context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
    }
    context.fill();
  }

  function renderTimeline() {
    const canvas = $('timeline');
    const { rec, view } = app;
    const width = canvas.clientWidth;
    const layout = timelineLayout(width);
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(layout.height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(layout.height * ratio);
      canvas.style.height = layout.height + 'px';
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, layout.height);
    const { rows, plot } = layout;
    const x = (t) => plot.x + ((t - view.from) / (view.to - view.from)) * plot.width;
    const ink = css('--ink');
    const secondary = css('--ink-secondary');
    const muted = css('--ink-muted');
    const grid = css('--grid');
    const surface = css('--surface');
    const critical = css('--status-critical');
    const warning = css('--status-warning');
    const colors = CATEGORIES.map((category, index) => (category ? categoryColor(index) : null));
    const hits = [];
    context.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    context.textBaseline = 'middle';

    // Row names, in the gutter.
    context.fillStyle = secondary;
    context.textAlign = 'left';
    context.fillText('Frames', 0, rows.frames.y + rows.frames.height / 2);
    context.fillText('Messages', 0, rows.messages.y + rows.messages.height / 2);
    context.fillText(app.source === 'phone' ? 'Composites' : app.source === 'buffer' ? 'Draws' : 'Presents', 0, rows.changes.y + rows.changes.height / 2);
    context.fillText('Sent', 0, rows.bytes.y + 6);

    context.save();
    context.beginPath();
    context.rect(plot.x, 0, plot.width, layout.height);
    context.clip();

    // Time gridlines: hairlines, one step off the surface.
    const tickStep = niceStep(((view.to - view.from) / plot.width) * 90);
    const firstTick = Math.ceil((view.from - rec.t0) / tickStep) * tickStep + rec.t0;
    context.fillStyle = grid;
    for (let t = firstTick; t <= view.to; t += tickStep) context.fillRect(Math.round(x(t)), 0, 1, rows.axis.y);

    // Frames: one bar per root, from its start to the end of everything it caused.
    for (const frame of rec.roots) {
      if (frame.treeEndT < view.from || frame.t > view.to) continue;
      const left = x(frame.t);
      const right = Math.max(left + 2, x(frame.treeEndT));
      const top = rows.frames.y + frame.lane * (TL.bar + TL.laneGap);
      const trouble = frame.open || (frame.outcome || '').startsWith('timeout');
      context.fillStyle = trouble ? critical : frame.sentT !== null ? css('--frame-sent') : css('--frame-discarded');
      rounded(context, left, top, right - left, TL.bar, 2);
      if (frame.sentT !== null && frame.sentT < frame.treeEndT) {
        // The moment its first pixels reached the glasses.
        context.fillStyle = surface;
        context.fillRect(Math.round(x(frame.sentT)), top, 1, TL.bar);
      }
      hits.push({ kind: 'frame', ref: frame, left, right, top, bottom: top + TL.bar });
    }

    // Messages: from written to acknowledged, colored by what most of their bytes were.
    for (const message of rec.messages) {
      if (message.endT < view.from || message.t > view.to) continue;
      const left = x(message.t);
      const right = Math.max(left + 2, x(message.endT));
      const top = rows.messages.y + message.lane * (TL.bar + TL.laneGap);
      context.globalAlpha = message.baseline || (message.ackT === null && expectsAck(message)) ? 0.45 : 1;
      context.fillStyle = colors[message.category];
      rounded(context, left, top, right - left, TL.bar, 2);
      context.globalAlpha = 1;
      hits.push({ kind: 'message', ref: message, left, right, top, bottom: top + TL.bar });
    }

    // Each change of the picture being shown.
    context.fillStyle = muted;
    for (const t of changeTimes()) {
      if (t < view.from || t > view.to) continue;
      context.fillRect(Math.round(x(t)), rows.changes.y, 1, rows.changes.height);
    }
    // Warnings and errors from the session log ride the same row, as status marks.
    for (const line of rec.logs) {
      if (line.level === 'I' || line.t < view.from || line.t > view.to) continue;
      const at = x(line.t);
      context.fillStyle = line.level === 'E' ? critical : warning;
      context.beginPath();
      context.moveTo(at, rows.changes.y - 1);
      context.lineTo(at + 5, rows.changes.y + rows.changes.height);
      context.lineTo(at - 5, rows.changes.y + rows.changes.height);
      context.closePath();
      context.fill();
      hits.push({ kind: 'log', ref: line, left: at - 6, right: at + 6, top: rows.changes.y - 2, bottom: rows.changes.y + rows.changes.height });
    }

    // Bytes sent: stacked columns, bucketed on fixed boundaries so they hold still while panning.
    const bucketMs = niceStep(((view.to - view.from) / plot.width) * 10);
    const from = Math.floor((view.from - rec.t0) / bucketMs) * bucketMs + rec.t0;
    const count = Math.ceil((view.to - from) / bucketMs);
    const buckets = Rec.buckets(rec, from, from + count * bucketMs, count);
    const perSecond = 1000 / bucketMs;
    const peak = Math.max(...buckets.map((bucket) => bucket.total * perSecond), 1);
    const rateStep = niceStep(peak / 2.5);
    const top = Math.ceil(peak / rateStep) * rateStep;
    const baseline = rows.bytes.y + rows.bytes.height;
    const barHeight = (rate) => (rate / top) * (rows.bytes.height - 6);
    context.restore();
    context.textAlign = 'right';
    for (let rate = 0; rate <= top + 1e-6; rate += rateStep) {
      const y = Math.round(baseline - barHeight(rate));
      context.fillStyle = rate === 0 ? css('--axis') : grid;
      context.fillRect(plot.x, y, plot.width, 1);
      if (rate > 0) {
        context.fillStyle = muted;
        context.fillText(formatRate(rate), plot.x - 8, y);
      }
    }
    context.save();
    context.beginPath();
    context.rect(plot.x, 0, plot.width, layout.height);
    context.clip();
    const slot = (plot.width / (view.to - view.from)) * bucketMs;
    const barWidth = Math.max(2, Math.min(24, slot - 2));
    const hovered = app.hover && app.hover.hit && app.hover.hit.kind === 'bucket' ? app.hover.hit.ref.t : null;
    for (const bucket of buckets) {
      if (bucket.total <= 0) continue;
      if (bucket.t === hovered) {
        context.fillStyle = css('--wash');
        context.fillRect(x(bucket.t), rows.bytes.y - 4, slot, rows.bytes.height + 4);
      }
      const left = x(bucket.t) + (slot - barWidth) / 2;
      let y = baseline;
      const present = [];
      for (let i = 1; i < CATEGORIES.length; i++) {
        if (bucket.byCategory[i] > 0) present.push(i);
      }
      present.forEach((index, order) => {
        const height = Math.max(1, barHeight(bucket.byCategory[index] * perSecond));
        const last = order === present.length - 1;
        context.fillStyle = colors[index];
        // A 2px gap in the surface color separates the segments; only the column's end is rounded.
        const gap = order > 0 && height > 3 ? 2 : 0;
        if (last) rounded(context, left, y - height, barWidth, height - gap, 4, true);
        else context.fillRect(left, y - height, barWidth, height - gap);
        y -= height;
      });
      hits.push({ kind: 'bucket', ref: bucket, left: x(bucket.t), right: x(bucket.endT), top: rows.bytes.y - 4, bottom: baseline });
    }

    // Playhead and hover line.
    if (app.hover && app.hover.x >= plot.x) {
      context.fillStyle = muted;
      context.fillRect(Math.round(app.hover.x), 0, 1, rows.axis.y);
    }
    const playhead = Math.round(x(app.cursor));
    context.fillStyle = ink;
    context.fillRect(playhead, 0, 1, rows.axis.y + 4);
    context.beginPath();
    context.moveTo(playhead - 4, rows.axis.y + 4);
    context.lineTo(playhead + 5, rows.axis.y + 4);
    context.lineTo(playhead + 0.5, rows.axis.y - 2);
    context.closePath();
    context.fill();

    // The selected and hovered marks lift with a ring.
    const ring = (hit, color) => {
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(hit.left - 1.5, hit.top - 1.5, hit.right - hit.left + 3, hit.bottom - hit.top + 3, 3);
      context.stroke();
    };
    for (const hit of hits) {
      if (hit.kind === 'bucket' || hit.kind === 'log') continue;
      const selected = (hit.kind === 'frame' && app.frame && hit.ref === app.frame.root) || (hit.kind === 'message' && hit.ref === app.message);
      if (selected) ring(hit, ink);
      else if (app.hover && app.hover.hit && app.hover.hit.ref === hit.ref) ring(hit, secondary);
    }
    context.restore();

    // Time axis.
    context.fillStyle = css('--axis');
    context.fillRect(plot.x, rows.axis.y, plot.width, 1);
    context.fillStyle = muted;
    context.textAlign = 'center';
    const decimals = tickStep >= 1000 ? 0 : tickStep >= 100 ? 1 : tickStep >= 10 ? 2 : 3;
    for (let t = firstTick; t <= view.to; t += tickStep) {
      const at = x(t);
      if (at < plot.x + 14 || at > plot.x + plot.width - 14) continue;
      context.fillText(((t - rec.t0) / 1000).toFixed(decimals) + ' s', at, rows.axis.y + 13);
    }
    app.timeline = { layout, hits, x, bucketMs };
  }

  function timeAt(clientX) {
    const canvas = $('timeline');
    const { plot } = app.timeline.layout;
    const offset = clientX - canvas.getBoundingClientRect().left;
    return app.view.from + ((offset - plot.x) / plot.width) * (app.view.to - app.view.from);
  }

  function hitAt(offsetX, offsetY) {
    // The target is bigger than the mark: a few pixels of slack on every side.
    let best = null;
    for (const hit of app.timeline.hits) {
      const slack = hit.kind === 'bucket' ? 0 : 4;
      if (offsetX < hit.left - slack || offsetX > hit.right + slack || offsetY < hit.top - slack || offsetY > hit.bottom + slack) continue;
      if (!best || (best.kind === 'bucket' && hit.kind !== 'bucket') || hit.right - hit.left < best.right - best.left) best = hit;
    }
    return best;
  }

  function tooltipRow(color, value, name) {
    return el('div', { class: 'row' }, color && el('span', { class: 'swatch line', style: { background: color } }), el('span', { class: 'value' }, value), el('span', { class: 'name' }, name));
  }

  function describeHit(hit, t) {
    const lines = [el('div', { class: 'when' }, formatAt(t))];
    if (!hit) return lines;
    if (hit.kind === 'frame') {
      const frame = hit.ref;
      lines.push(el('div', { class: 'title' }, 'frame#' + frame.id + ' ' + frame.reason));
      lines.push(tooltipRow(null, frame.sentT !== null ? formatDuration(frame.sentT - frame.t) : '–', 'to first pixels on the glasses'));
      lines.push(tooltipRow(null, formatDuration(frame.treeEndT - frame.t), 'until everything it caused finished'));
      lines.push(tooltipRow(null, formatBytes(frame.wireBytes), 'sent in ' + frame.messageCount + ' message' + (frame.messageCount === 1 ? '' : 's')));
      lines.push(el('div', { class: 'name' }, frame.outcome === null ? 'still open' : frame.outcome));
    } else if (hit.kind === 'message') {
      const message = hit.ref;
      lines.push(el('div', { class: 'title' }, messageSummary(message)));
      lines.push(tooltipRow(categoryColor(message.category), formatBytes(message.wireBytes), 'on the wire (' + formatBytes(message.bytes) + ' before compression)'));
      if (expectsAck(message)) {
        lines.push(tooltipRow(null, message.ackT !== null ? formatDuration(message.ackT - message.t) : '–', message.ackT !== null ? 'from written to acknowledged' : 'never acknowledged'));
      }
      if (message.attempts.length > 1) lines.push(el('div', { class: 'name' }, 'written ' + message.attempts.length + ' times'));
      if (message.baseline) lines.push(el('div', { class: 'name' }, 'planned before the recording started'));
    } else if (hit.kind === 'bucket') {
      const bucket = hit.ref;
      const seconds = (bucket.endT - bucket.t) / 1000;
      lines[0].textContent = formatAt(bucket.t) + ' – ' + formatAt(bucket.endT);
      lines.push(tooltipRow(null, formatRate(bucket.total / seconds), formatBytes(bucket.total) + ' sent'));
      for (let i = 1; i < CATEGORIES.length; i++) {
        if (bucket.byCategory[i] >= 0.5) lines.push(tooltipRow(categoryColor(i), formatBytes(bucket.byCategory[i]), CATEGORIES[i].label));
      }
    } else if (hit.kind === 'log') {
      lines.push(el('div', { class: 'status ' + (hit.ref.level === 'E' ? 'critical' : 'warning') }, hit.ref.level === 'E' ? 'Error' : 'Warning'));
      lines.push(el('div', { class: 'name' }, hit.ref.text.slice(0, 300)));
    }
    return lines;
  }

  function timelineEvents() {
    const canvas = $('timeline');
    const tooltip = $('tooltip');
    let drag = null;

    const local = (event) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (!app || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      const at = local(event);
      drag = { x: at.x, moved: false, hit: hitAt(at.x, at.y) };
      setPlaying(false);
      // A press on empty timeline moves the playhead at once; on a mark, the click decides.
      if (!drag.hit || drag.hit.kind === 'bucket') setCursor(timeAt(event.clientX), false);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!app) return;
      const at = local(event);
      if (drag) {
        if (Math.abs(at.x - drag.x) > 3) drag.moved = true;
        if (drag.moved) setCursor(timeAt(event.clientX), false);
      }
      const hit = drag && drag.moved ? null : hitAt(at.x, at.y);
      app.hover = { x: at.x, hit };
      tooltip.replaceChildren(...describeHit(hit, timeAt(event.clientX)));
      tooltip.hidden = false;
      const wrap = canvas.parentElement.getBoundingClientRect();
      const left = Math.min(at.x + 14, wrap.width - tooltip.offsetWidth - 4);
      tooltip.style.left = Math.max(0, left) + 'px';
      const fitsBelow = event.clientY + 20 + tooltip.offsetHeight < window.innerHeight;
      tooltip.style.top = (fitsBelow ? at.y + 16 : at.y - tooltip.offsetHeight - 10) + 'px';
      invalidate('timeline');
    });

    canvas.addEventListener('pointerup', (event) => {
      if (!app || !drag) return;
      const { hit, moved } = drag;
      drag = null;
      if (moved || !hit) return;
      if (hit.kind === 'frame') selectFrame(hit.ref);
      else if (hit.kind === 'message') selectMessage(hit.ref);
      else if (hit.kind === 'log') {
        setCursor(hit.ref.t);
        showTab('log');
      }
    });

    canvas.addEventListener('pointerleave', () => {
      if (!app) return;
      app.hover = null;
      tooltip.hidden = true;
      invalidate('timeline');
    });

    canvas.addEventListener('wheel', (event) => {
      if (!app) return;
      event.preventDefault();
      const { view } = app;
      const span = view.to - view.from;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const delta = ((event.deltaX || event.deltaY) / app.timeline.layout.plot.width) * span;
        setView(view.from + delta, view.to + delta);
        return;
      }
      const factor = Math.exp(event.deltaY * 0.0022);
      const anchor = timeAt(event.clientX);
      const from = anchor - (anchor - view.from) * factor;
      setView(from, from + span * factor);
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      if (app) setView(app.full.from, app.full.to);
    });
  }

  // ---------------------------------------------------------------------
  // Headline numbers

  function tile(label, value, note, warn) {
    return el('div', { class: 'card tile' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), note && el('div', { class: 'note' + (warn ? ' warn' : '') }, note));
  }

  function renderStats() {
    const { rec } = app;
    const totals = Rec.totals(rec);
    const latency = Rec.latency(rec);
    const duration = rec.t1 - rec.t0;
    const glasses = { g2: 'Even G2', g1: 'Even G1', 'rayneo-io': 'RayNeo iO', none: 'No glasses (preview only)' }[rec.header.glasses] || rec.header.glasses;
    const tiles = [
      tile('Recording', formatDuration(duration), glasses + ' · ' + (rec.header.localTime || '')),
      tile('Sent over Bluetooth', formatBytes(totals.wire), totals.messages.toLocaleString('en-US') + ' messages' + (totals.resent > 0 ? ' · ' + formatBytes(totals.resent) + ' resent' : '')),
      tile('Average rate', formatRate(totals.wire / Math.max(0.001, duration / 1000)), formatBytes(totals.payload) + ' before compression'),
      tile('Frames sent', latency.sent.toLocaleString('en-US'), 'of ' + latency.started.toLocaleString('en-US') + ' started · ' + latency.discarded + ' discarded' + (latency.timedOut ? ' · ' + latency.timedOut + ' timed out' : '')),
    ];
    if (latency.input.count) {
      tiles.push(tile('Input to display', formatDuration(latency.input.p50), 'median of ' + latency.input.count + ' · p90 ' + formatDuration(latency.input.p90) + ' · max ' + formatDuration(latency.input.max)));
    } else if (latency.render.count) {
      tiles.push(tile('Render to display', formatDuration(latency.render.p50), 'median of ' + latency.render.count + ' · p90 ' + formatDuration(latency.render.p90)));
    }
    if (app.check) {
      const off = app.check.filter((entry) => entry.differing !== 0);
      const worst = off.reduce((max, entry) => Math.max(max, entry.differing), 0);
      tiles.push(off.length === 0
        ? tile('Replay check', 'Matches', 'the phone\'s own composite, at ' + app.check.map((entry) => formatAt(entry.t)).join(' and '))
        : tile('Replay check', worst < 0 ? 'Size differs' : worst.toLocaleString('en-US') + ' px differ', 'from the phone\'s composite at ' + off.map((entry) => formatAt(entry.t)).join(' and ') + ': frames still in flight, or a replay bug', true));
    }
    if (rec.end && rec.end.truncated) tiles.push(tile('Truncated', 'Size limit', 'the recording stopped early', true));
    if (!rec.end) tiles.push(tile('Incomplete', 'No end record', 'the file was cut short', true));
    $('stats').replaceChildren(...tiles);
  }

  // ---------------------------------------------------------------------
  // Detail tabs

  /** Fire-and-forget writes (no stream id) and writes outside the message queue are never acknowledged. */
  const expectsAck = (message) => !message.unqueued && message.magic !== 0;

  function messageSummary(message) {
    const items = message.items.filter((item) => !item.framing);
    if (items.length === 1) return items[0].text;
    if (items.length === 0) return message.name;
    const noun = message.name === 'draw' ? 'call' : message.name === 'upload' ? 'chunk' : 'item';
    return message.name + ': ' + items.length + ' ' + noun + 's';
  }

  const swatchFor = (category) => el('span', { class: 'swatch', style: { background: 'var(--series-' + category + ')' }, title: CATEGORIES[category].label });

  function table(headers, rows) {
    return el('table', null,
      el('thead', null, el('tr', null, headers.map((header) => el('th', { class: header.num ? 'num' : null }, header.label)))),
      el('tbody', null, rows));
  }

  function inView(t0, t1 = t0) {
    return t1 >= app.view.from && t0 <= app.view.to;
  }

  function renderPanel() {
    const body = $('panel');
    const scroll = app.panelKey === panelKey() ? body.scrollTop : 0;
    app.panelKey = panelKey();
    const render = { frame: renderFrames, message: renderMessages, bandwidth: renderBandwidth, resources: renderResources, log: renderLog }[app.tab];
    body.replaceChildren(...render().flat(Infinity).filter(Boolean));
    body.scrollTop = scroll;
  }

  /** Scroll position survives a re-render of the same thing, not a change of subject. */
  function panelKey() {
    return app.tab + ':' + (app.tab === 'frame' && app.frame ? app.frame.id : app.tab === 'message' && app.message ? app.message.id : '');
  }

  function renderFrames() {
    if (app.frame) return renderFrameDetail(app.frame.root || app.frame);
    const roots = app.rec.roots.filter((frame) => inView(frame.t, frame.treeEndT));
    if (!app.rec.roots.length) return [el('p', { class: 'secondary' }, 'This recording has no frame timings.')];
    const limit = 300;
    return [
      el('p', { class: 'secondary' }, roots.length.toLocaleString('en-US') + ' frame tree' + (roots.length === 1 ? '' : 's') + ' in the visible range' +
        (roots.length > limit ? ' (first ' + limit + ' shown; zoom in for the rest)' : '') + '. Select one for its timing log.'),
      table([{ label: 'At' }, { label: 'Frame' }, { label: 'Outcome' }, { label: 'To first pixels', num: true }, { label: 'Sent', num: true }],
        roots.slice(0, limit).map((frame) => el('tr', { class: 'clickable', onclick: () => selectFrame(frame) },
          el('td', { class: 'num' }, formatAt(frame.t)),
          el('td', null, 'frame#' + frame.id + ' ' + frame.reason),
          el('td', null, frameOutcome(frame)),
          el('td', { class: 'num' }, frame.sentT !== null ? formatDuration(frame.sentT - frame.t) : '–'),
          el('td', { class: 'num' }, frame.wireBytes ? formatBytes(frame.wireBytes) : '–')))),
    ];
  }

  function frameOutcome(frame) {
    if (frame.outcome === null) return el('span', { class: 'status critical' }, 'still open');
    if (frame.outcome.startsWith('timeout')) return el('span', { class: 'status critical' }, frame.outcome);
    return frame.outcome;
  }

  function renderFrameDetail(root) {
    const span = Math.max(1, root.treeEndT - root.t);
    const percent = (t) => Math.max(0, Math.min(100, ((t - root.t) / span) * 100));
    const block = (frame) => {
      const rows = frame.lines.map((line) => {
        const mark = line.span
          ? el('i', { style: { left: percent(line.span.t) + '%', width: Math.max(0, percent(line.t) - percent(line.span.t)) + '%' } })
          : el('i', { class: 'tick', style: { left: percent(line.t) + '%' } });
        return el('div', { class: 'log-row' },
          el('span', { class: 'offset' }, (line.t - root.t >= 0 ? '+' : '−') + Math.abs(line.t - root.t) + ' ms'),
          el('span', { class: 'lane' }, mark),
          el('span', { class: 'text' }, line.text, ' ', el('span', { class: 'thread' }, '[' + line.thread + ']')));
      });
      return el('div', { class: 'frame-block' },
        el('div', { class: 'frame-head' }, 'frame#' + frame.id + ' ' + frame.reason + ' ',
          el('span', { class: 'outcome' }, '· ', frameOutcome(frame), frame.endT !== null ? ' · ' + formatDuration(frame.endT - frame.t) : '')),
        rows,
        frame.children.map(block));
    };
    const messages = [];
    const collect = (frame) => {
      messages.push(...frame.messages);
      frame.children.forEach(collect);
    };
    collect(root);
    messages.sort((a, b) => a.t - b.t);
    return [
      el('p', null, el('button', { class: 'link', onclick: () => selectFrame(null) }, '← All frames')),
      el('h2', null, 'frame#' + root.id + ' ' + root.reason),
      el('dl', { class: 'facts' },
        el('dt', null, 'Started'), el('dd', null, formatAt(root.t)),
        el('dt', null, 'First pixels on the glasses'), el('dd', null, root.sentT !== null ? formatDuration(root.sentT - root.t) + ' later, at ' + formatAt(root.sentT) : 'never'),
        el('dt', null, 'Everything finished'), el('dd', null, formatDuration(root.treeEndT - root.t) + ' later' + (root.open ? ' (still open when the recording ended)' : '')),
        el('dt', null, 'Sent'), el('dd', null, formatBytes(root.wireBytes) + ' in ' + root.messageCount + ' message' + (root.messageCount === 1 ? '' : 's'))),
      el('h3', null, 'Timing log (offsets from this frame\'s start; bars are spans)'),
      block(root),
      messages.length ? el('h3', null, 'Messages it produced') : null,
      messages.length ? messageTable(messages) : null,
    ];
  }

  function messageTable(messages) {
    return table([{ label: 'At' }, { label: 'Message' }, { label: 'On the wire', num: true }, { label: 'Payload', num: true }, { label: 'Acknowledged', num: true }],
      messages.map((message) => el('tr', { class: 'clickable' + (message === app.message ? ' current' : ''), onclick: () => selectMessage(message) },
        el('td', { class: 'num' }, formatAt(message.t)),
        el('td', null, swatchFor(message.category), messageSummary(message), message.baseline ? ' (planned earlier)' : ''),
        el('td', { class: 'num' }, formatBytes(message.wireBytes)),
        el('td', { class: 'num' }, formatBytes(message.bytes)),
        el('td', { class: 'num' }, message.ackT !== null ? '+' + formatDuration(message.ackT - message.t) : '–'))));
  }

  function renderMessages() {
    if (app.message) return renderMessageDetail(app.message);
    const messages = app.rec.messages.filter((message) => inView(message.t, message.endT));
    if (!app.rec.messages.length) return [el('p', { class: 'secondary' }, 'No Bluetooth messages were written during this recording.')];
    const limit = 400;
    return [
      el('p', { class: 'secondary' }, messages.length.toLocaleString('en-US') + ' message' + (messages.length === 1 ? '' : 's') + ' in the visible range' +
        (messages.length > limit ? ' (first ' + limit + ' shown; zoom in for the rest)' : '') + '. Select one to see what it carried and where it drew.'),
      messageTable(messages.slice(0, limit)),
    ];
  }

  function renderMessageDetail(message) {
    const { rec } = app;
    const frame = message.frame ? rec.framesById.get(message.frame) : null;
    const since = (t) => (t === null ? '–' : '+' + formatDuration(t - message.t));
    const player = app.players[app.lens];
    const index = player.ops.findIndex((op) => op.message === message);
    const rejected = index >= 0 ? player.errors.get(index) : null;
    const lists = message.items.filter((item) => item.resourceType === 'display list' && item.total + 10 === item.bytes);
    const packets = message.attempts.reduce((sum, attempt) => sum + attempt.wire.length, 0);
    return [
      el('p', null, el('button', { class: 'link', onclick: () => selectMessage(null) }, '← All messages')),
      el('h2', null, messageSummary(message)),
      el('dl', { class: 'facts' },
        el('dt', null, 'Written'), el('dd', null, formatAt(message.t) + ' to the ' + (message.arm === 'L' ? 'left' : 'right') + ' arm' +
          (message.attempts.length > 1 ? ', ' + message.attempts.length + ' times (replayed after a lost or refused acknowledgement)' : '')),
        el('dt', null, 'Size'), el('dd', null, formatBytes(message.wireBytes) + ' on the wire in ' + packets + ' packet' + (packets === 1 ? '' : 's') + '; ' + formatBytes(message.bytes) + ' before compression'),
        el('dt', null, 'Write returned'), el('dd', null, since(message.attempts[0].sentT)),
        message.sid === Rec.CFW_SID ? [el('dt', null, 'Left lens acknowledged'), el('dd', null, since(message.lensAcks[0])),
          el('dt', null, 'Right lens acknowledged'), el('dd', null, since(message.lensAcks[1]))] : null,
        el('dt', null, 'Complete'), el('dd', null, message.ackT !== null ? since(message.ackT) : expectsAck(message) ? 'never acknowledged' : 'no acknowledgement expected'),
        message.nacks.length ? [el('dt', null, 'Refused'), el('dd', null, message.nacks.map((nack) => 'lens ' + nack.lens + ' at ' + since(nack.t)).join(', '))] : null,
        message.timeouts.length ? [el('dt', null, 'Timed out'), el('dd', null, message.timeouts.map(since).join(', '))] : null,
        frame ? [el('dt', null, 'For'), el('dd', null, el('button', { class: 'link', onclick: () => selectFrame(frame) }, 'frame#' + frame.id + ' ' + frame.reason))] : null,
        message.unqueued ? null : [el('dt', null, 'Stream'), el('dd', null, 'sid 0x' + message.sid.toString(16) + ', id ' + message.magic + ', kind "' + message.kind + '"' +
          (message.update ? ', image update #' + message.update + ' part ' + message.part + ' of ' + message.parts : ''))]),
      message.baseline ? el('p', { class: 'secondary' }, 'Planned before the recording started: its effect is already in the starting state, so the replay skips it. Its bytes still count.') : null,
      rejected ? el('p', null, el('span', { class: 'status critical' }, 'Rejected in the replay: ' + rejected)) : null,
      app.outlines.length ? el('p', { class: 'secondary' }, 'Outlined on the display: the ' + app.outlines.length + ' rectangle' + (app.outlines.length === 1 ? '' : 's') + ' its calls touched.') : null,
      el('h3', null, 'Contents'),
      table([{ label: 'What' }, { label: 'Payload', num: true }],
        message.items.map((item) => el('tr', null, el('td', null, swatchFor(item.category), item.text), el('td', { class: 'num' }, formatBytes(item.bytes))))),
      lists.map((item) => {
        const start = message.items.slice(0, message.items.indexOf(item)).reduce((sum, entry) => sum + entry.bytes, 3);
        const calls = Rec.describeDisplayList(message.payload.subarray(start + 10, start + item.bytes));
        return [el('h3', null, 'Display list #' + item.resource), table([{ label: 'Call' }, { label: 'Bytes', num: true }],
          calls.map((call) => el('tr', null, el('td', null, call.text), el('td', { class: 'num' }, call.bytes))))];
      }),
    ];
  }

  function renderBandwidth() {
    const { rec, view } = app;
    const whole = app.bandwidthScope === 'all';
    const from = whole ? rec.tMin : view.from;
    const to = whole ? rec.t1 : view.to;
    const totals = Rec.totals(rec, from, to);
    const seconds = Math.max(0.001, (Math.min(to, rec.t1) - Math.max(from, rec.t0)) / 1000);
    const scope = el('span', { class: 'segmented', role: 'group', 'aria-label': 'Range' });
    segmented(scope, [['all', 'Whole recording'], ['view', 'Visible range']], () => app.bandwidthScope, (value) => {
      app.bandwidthScope = value;
      invalidate('panel');
    });
    const share = (row) => (totals.wire > 0 ? (row.wire / totals.wire) * 100 : 0);
    return [
      el('p', null, scope),
      el('h2', null, formatBytes(totals.wire) + ' sent, ' + formatRate(totals.wire / seconds) + ' on average'),
      el('p', { class: 'secondary' }, totals.messages.toLocaleString('en-US') + ' messages; ' + formatBytes(totals.payload) + ' before the link\'s compression' +
        (totals.resent > 0 ? '; ' + formatBytes(totals.resent) + ' of the total was sent again after a lost acknowledgement' : '') + '.'),
      // The split at a glance; the table below gives each part's figures.
      el('div', { class: 'split', role: 'img', 'aria-label': 'Share of bytes sent by category' },
        totals.rows.filter((row) => row.wire > 0).map((row) => el('span', { style: { flex: String(row.wire), background: 'var(--series-' + row.index + ')' }, title: row.label + ': ' + formatBytes(row.wire) }))),
      table([{ label: 'Where the bytes went' }, { label: 'On the wire', num: true }, { label: 'Share', num: true }, { label: 'Payload', num: true }, { label: 'Messages', num: true }],
        totals.rows.map((row) => el('tr', { title: CATEGORIES[row.index].detail },
          el('td', null, swatchFor(row.index), row.label),
          el('td', { class: 'num' }, formatBytes(row.wire)),
          el('td', { class: 'num' }, share(row).toFixed(share(row) >= 10 ? 0 : 1) + '%'),
          el('td', { class: 'num' }, formatBytes(row.payload)),
          el('td', { class: 'num' }, row.messages.toLocaleString('en-US'))))),
      el('p', { class: 'muted' }, 'The link compresses the message stream as a whole, so a message\'s wire bytes are exact but their split between categories is in proportion to the uncompressed payload. Screen and surface pixels are content sent as images; uploads, display lists and draw calls are the display-list mechanism.'),
    ];
  }

  function imageCanvas(image) {
    const canvas = el('canvas', { class: 'thumb', width: image.width, height: image.height });
    const context = canvas.getContext('2d');
    const data = context.createImageData(image.width, image.height);
    for (let i = 0; i < image.pixels.length; i++) {
      const level = Math.round(Math.pow(image.pixels[i] / 15, 0.8) * 255);
      data.data.set([level, level, level, 255], i * 4);
    }
    context.putImageData(data, 0, 0);
    return canvas;
  }

  function describeResource(id, bytes) {
    const type = bytes[0] & 3;
    try {
      if (type === 0) {
        const image = Emu.decodeImage(bytes);
        const kind = app.lenses[app.lens].origins.get(id) === Emu.ORIGIN.SURFACE ? 'surface' : 'image';
        return { kind, detail: image.width + '×' + image.height + (bytes[0] & 8 ? ', run-length coded' : ''), preview: imageCanvas(image) };
      }
      if (type === 1) {
        // The glyphs side by side, as far as a thumbnail goes.
        const glyphs = [];
        for (let code = 0; code < 96; code++) {
          const offset = bytes[1 + code * 2] | (bytes[2 + code * 2] << 8);
          if (offset >= 193) glyphs.push(Emu.decodeImage(bytes, offset));
        }
        const height = Math.max(1, ...glyphs.map((glyph) => glyph.height));
        const strip = { width: 0, height, pixels: null };
        const placed = [];
        for (const glyph of glyphs) {
          if (strip.width + glyph.width > 320) break;
          placed.push([glyph, strip.width]);
          strip.width += glyph.width + 1;
        }
        strip.width = Math.max(1, strip.width);
        strip.pixels = new Uint8Array(strip.width * height);
        for (const [glyph, left] of placed) {
          for (let i = 0; i < glyph.pixels.length; i++) strip.pixels[((i / glyph.width) | 0) * strip.width + left + (i % glyph.width)] = glyph.pixels[i];
        }
        return { kind: 'font', detail: glyphs.length + ' glyph' + (glyphs.length === 1 ? '' : 's'), preview: imageCanvas(strip) };
      }
      if (type === 2) {
        const calls = Rec.describeDisplayList(bytes);
        const root = app.lenses[app.lens].root === id;
        return { kind: root ? 'root list' : 'display list', detail: calls.length + ' call' + (calls.length === 1 ? '' : 's'),
          preview: el('details', null, el('summary', null, 'calls'), calls.map((call) => el('div', null, call.text))) };
      }
    } catch (error) {
      return { kind: Rec.RESOURCE_TYPES[type], detail: 'incomplete: ' + error.message, preview: null };
    }
    return { kind: 'reserved', detail: '', preview: null };
  }

  function renderResources() {
    if (!app.rec.replayable) return [el('p', { class: 'secondary' }, 'This recording has no replayable messages, so there is no resource cache to show.')];
    const lens = app.lenses[app.lens];
    const entries = [...lens.resources.entries()].sort((a, b) => a[0] - b[0]);
    // As the firmware's arena counts it: a 16-byte block header and 4-byte alignment each.
    const used = entries.reduce((sum, [, bytes]) => sum + 16 + ((bytes.length + 3) & ~3), 0);
    return [
      el('h2', null, entries.length + ' resource' + (entries.length === 1 ? '' : 's') + ' in the ' + (app.lens ? 'right' : 'left') + ' lens\'s cache at ' + formatAt(app.cursor)),
      el('p', { class: 'secondary' }, formatBytes(used) + ' of the cache used. Root list: ' + (lens.root === Emu.SCREEN ? 'none (the screen buffer is presented as it is)' : '#' + lens.root) + '.'),
      table([{ label: '#', num: true }, { label: 'Kind' }, { label: 'Size', num: true }, { label: 'Contents' }, { label: '' }],
        entries.slice(0, 250).map(([id, bytes]) => {
          const described = describeResource(id, bytes);
          return el('tr', null, el('td', { class: 'num' }, id), el('td', null, described.kind), el('td', { class: 'num' }, formatBytes(bytes.length)), el('td', null, described.detail), el('td', null, described.preview));
        })),
      entries.length > 250 ? el('p', { class: 'muted' }, 'Only the first 250 are listed.') : null,
    ];
  }

  function renderLog() {
    const { logs } = app.rec;
    if (!logs.length) return [el('p', { class: 'secondary' }, 'This recording has no session log lines.')];
    let next = logs.findIndex((line) => line.t > app.cursor);
    if (next < 0) next = logs.length;
    const from = Math.max(0, next - 150);
    const to = Math.min(logs.length, next + 150);
    const rows = [];
    for (let i = from; i < to; i++) {
      if (i === next) rows.push(el('span', { class: 'now', title: 'The playhead' }));
      const line = logs[i];
      rows.push(el('div', null, el('span', { class: 'at' }, formatAt(line.t)),
        el('span', null, line.level === 'I' ? null : el('span', { class: 'status ' + (line.level === 'E' ? 'critical' : 'warning') }, line.level === 'E' ? 'Error ' : 'Warning '), line.text)));
    }
    if (next === to) rows.push(el('span', { class: 'now', title: 'The playhead' }));
    return [
      el('p', { class: 'secondary' }, 'Session log around the playhead (lines ' + (from + 1) + '–' + to + ' of ' + logs.length.toLocaleString('en-US') + ').'),
      el('div', { class: 'session-log' }, rows),
    ];
  }

  // ---------------------------------------------------------------------
  // Page wiring

  async function openFile(file) {
    openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  function start() {
    $('open').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', (event) => {
      if (event.target.files[0]) openFile(event.target.files[0]);
    });
    document.addEventListener('dragover', (event) => {
      event.preventDefault();
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
    document.addEventListener('drop', (event) => {
      event.preventDefault();
      document.body.classList.remove('dragging');
      if (event.dataTransfer.files[0]) openFile(event.dataTransfer.files[0]);
    });
    $('to-start').addEventListener('click', () => { setPlaying(false); setCursor(app.rec.tMin); });
    $('to-end').addEventListener('click', () => { setPlaying(false); setCursor(app.rec.t1); });
    $('previous').addEventListener('click', () => stepChange(-1));
    $('next').addEventListener('click', () => stepChange(1));
    $('play').addEventListener('click', () => setPlaying(!app.playing));
    document.addEventListener('keydown', (event) => {
      if (!app || event.metaKey || event.ctrlKey || event.altKey) return;
      if (['INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(event.target.tagName)) return;
      if (event.key === ' ' && event.target.tagName !== 'BUTTON') setPlaying(!app.playing);
      else if (event.key === 'ArrowLeft') stepChange(-1);
      else if (event.key === 'ArrowRight') stepChange(1);
      else return;
      event.preventDefault();
    });
    timelineEvents();
    window.addEventListener('resize', () => app && invalidate('timeline'));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      resolved.clear();
      if (!app) return;
      app.lut = null;
      invalidate('screen', 'timeline');
    });
    // ?theme=light or ?theme=dark overrides the system's choice.
    const theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    // ?file=<url> opens a recording served next to the page (handy when developing the tool).
    const url = new URLSearchParams(location.search).get('file');
    if (url) {
      fetch(url).then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.arrayBuffer();
      }).then((buffer) => openBytes(new Uint8Array(buffer), url.split('/').pop()), (error) => showError(url + ': ' + error.message));
    }
  }

  start();
})();
