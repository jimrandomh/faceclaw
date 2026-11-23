// Reads a screen recording (FORMAT.md) into a model the page can draw: messages with their
// decoded contents and where their bytes went, the frame-timing trees, the session log, and
// per-lens lists of what to replay through emulator.js.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./emulator.js') : root.FcEmulator);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcRecording = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Emulator) {
  'use strict';

  const FORMAT = 'faceclaw-screen-recording';
  const VERSION = 1;
  const CFW_SID = 0xf0;

  // Where the bytes went. The order is fixed: it is the order of the chart colors, and the
  // index is what emulator.js's ORIGIN stores per pixel.
  const CATEGORIES = [
    null,
    { key: 'screen', label: 'Screen pixels', detail: 'Pixel runs drawn into the screen buffer: content sent as an image.' },
    { key: 'surface', label: 'Surface pixels', detail: 'Pixel runs drawn into a shell surface (top bar, sidebar, dialogs).' },
    { key: 'images', label: 'Image uploads', detail: 'Images put in the resource cache, then drawn by reference.' },
    { key: 'fonts', label: 'Font uploads', detail: 'Fonts put in the resource cache; text is then sent as characters.' },
    { key: 'lists', label: 'Display lists', detail: 'Display lists put in the resource cache, including the root list.' },
    { key: 'draws', label: 'Draw calls', detail: 'Calls that draw from the cache or on the glasses: images, text, copies, rectangles.' },
    { key: 'control', label: 'Control & other', detail: 'Present, evictions, surface creation, brightness, heartbeats, settings.' },
  ];
  const CATEGORY = { SCREEN: 1, SURFACE: 2, IMAGES: 3, FONTS: 4, LISTS: 5, DRAWS: 6, CONTROL: 7 };

  const MESSAGE_NAMES = {
    5: 'buzzer', 7: 'diagnostics', 10: 'compass', 11: 'cleanup', 16: 'ambient light', 17: 'ring battery',
    21: 'upload', 22: 'evict', 23: 'panel read', 24: 'panel write', 25: 'panel pattern', 26: 'draw',
    27: 'set root', 28: 'present', 29: 'create surface', 30: 'brightness', 31: 'enter EvenHub', 32: 'lens battery',
  };
  const OP_NAMES = {
    1: 'pixels', 2: 'copy', 3: 'stock text', 4: 'image', 5: 'text', 6: 'color remap', 7: 'play list', 8: 'rounded rect', 9: 'clear',
    10: 'line',
  };
  const RESOURCE_TYPES = ['image', 'font', 'display list', 'reserved'];

  function base64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function decompress(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);

  /** What an image resource's header says, or null if these bytes don't start one. */
  function describeImage(bytes, start = 0) {
    try {
      const image = Emulator.decodeImage(bytes, start, false);
      return image.width + '×' + image.height;
    } catch (error) {
      return null;
    }
  }

  /**
   * Split a message into the things it carries. Each item has a `category`, its `bytes` of the
   * payload, and a `text` saying what it is; `types` remembers each resource's type from the
   * chunk that carried its header, for the chunks that follow.
   */
  function decodeMessage(message, types) {
    const payload = message.payload;
    const items = [];
    const item = (category, bytes, text, extra) => items.push(Object.assign({ category, bytes, text }, extra));
    if (message.sid !== CFW_SID) {
      item(CATEGORY.CONTROL, payload.length, message.label || message.kind || 'message');
      return { name: message.kind || 'message', items };
    }
    const type = payload[0] & 127;
    const name = MESSAGE_NAMES[type] || 'message ' + type;
    try {
      if (type === 21) {
        const count = u16(payload, 1);
        let p = 3;
        for (let i = 0; i < count && p + 10 <= payload.length; i++) {
          const id = u16(payload, p);
          const total = (u16(payload, p + 2) | (u16(payload, p + 4) << 16)) >>> 0;
          const offset = u16(payload, p + 6);
          const size = u16(payload, p + 8);
          if (offset === 0 && size > 0) types.set(id, { type: payload[p + 10] & 3, size: describeImage(payload.subarray(p + 10, p + 10 + size)) });
          const known = types.get(id);
          const kind = known ? RESOURCE_TYPES[known.type] : 'resource';
          const category = !known || known.type === 0 ? CATEGORY.IMAGES : known.type === 1 ? CATEGORY.FONTS : CATEGORY.LISTS;
          const part = size === total ? '' : ' bytes ' + offset + '–' + (offset + size) + ' of ' + total;
          item(category, 10 + size, 'upload ' + kind + ' #' + id + (known && known.type === 0 && known.size ? ' ' + known.size : '') + part,
            { resource: id, resourceType: kind, total });
          p += 10 + size;
        }
      } else if (type === 22) {
        const count = u16(payload, 1);
        item(CATEGORY.CONTROL, payload.length, count >= 512 ? 'evict every resource' : 'evict ' + count + ' resource' + (count === 1 ? '' : 's'));
        for (let i = 0; i < count && 4 + i * 2 < payload.length; i++) types.delete(u16(payload, 3 + i * 2));
      } else if (type === 29) {
        const count = u16(payload, 1);
        for (let i = 0; i < count && 3 + i * 6 + 6 <= payload.length; i++) {
          const p = 3 + i * 6;
          item(CATEGORY.CONTROL, 6, 'create surface #' + u16(payload, p) + ' ' + u16(payload, p + 2) + '×' + u16(payload, p + 4), { resource: u16(payload, p) });
        }
      } else if (type === 26) {
        decodeCalls(payload, 1, payload.length, items, false);
      } else if (type === 27) {
        const id = u16(payload, 1);
        item(CATEGORY.CONTROL, payload.length, id === Emulator.SCREEN ? 'clear the root list' : 'set root list #' + id);
      } else {
        item(CATEGORY.CONTROL, payload.length, name);
      }
    } catch (error) {
      item(CATEGORY.CONTROL, 0, 'undecodable: ' + error.message);
    }
    // Message and sequence headers belong to nothing in particular.
    const counted = items.reduce((sum, entry) => sum + entry.bytes, 0);
    if (counted < payload.length) item(CATEGORY.CONTROL, payload.length - counted, 'framing', { framing: true });
    return { name, items };
  }

  /** The calls of a draw sequence (`[count:u16]{length:u16, call}`) as items. */
  function decodeCalls(bytes, start, end, items, inList) {
    const reader = new Emulator.Reader(bytes, start, end);
    const count = reader.u16();
    for (let i = 0; i < count; i++) {
      const length = reader.u16();
      const call = reader.slice(length);
      const opcode = call.u8();
      const flags = call.u8();
      const target = flags & 1 ? call.u16() : null;
      const depth = flags & 2 ? call.s8() : null;
      if (flags & 4) call.take(8);
      // An animated clip: four extended values, each a literal or 0xff and a framed expression.
      if (flags & 8) for (let field = 0; field < 4; field++) {
        const first = call.u8();
        if (first === 0xff) call.take(Emulator.readVarint(call, false) >>> 0);
        else Emulator.readVarint(call, true, first);
      }
      let text = OP_NAMES[opcode] || 'opcode ' + opcode;
      let category = CATEGORY.DRAWS;
      try {
        if (opcode === 1) {
          const wide = call.u8() & 1;
          const x = wide ? call.u16() : call.u8() * 4;
          const y = wide ? call.u16() : call.u8() * 2;
          const w = wide ? call.u16() : call.u8() * 4;
          const h = wide ? call.u16() : call.u8() * 2;
          text = 'pixels ' + w + '×' + h + ' at ' + x + ',' + y;
          category = target === null ? CATEGORY.SCREEN : CATEGORY.SURFACE;
        } else if (opcode === 2) {
          const source = call.u16();
          text = 'copy from ' + (source === Emulator.SCREEN ? 'the screen' : source === Emulator.CURRENT ? 'itself' : '#' + source);
        } else if (opcode === 3) {
          const x = call.s16();
          const y = call.s16();
          call.u8();
          text = 'stock text ' + JSON.stringify(new TextDecoder().decode(call.take(call.u8()))) + ' at ' + x + ',' + y;
        } else if (opcode === 4) {
          text = 'image #' + call.u16();
        } else if (opcode === 5) {
          text = 'text in font #' + call.u16();
        } else if (opcode === 7) {
          text = 'play list #' + call.u16();
        }
      } catch (error) {
        text += ' (truncated)';
      }
      if (target !== null) text += ' → #' + target;
      if (depth !== null && depth !== 0) text += ' depth ' + depth;
      items.push({ category: inList ? CATEGORY.LISTS : category, bytes: 2 + length, text, op: opcode, target });
    }
  }

  /** A display-list resource's calls, for showing what a list does. */
  function describeDisplayList(bytes) {
    const items = [];
    try {
      decodeCalls(bytes, 1, bytes.length, items, true);
    } catch (error) {
      items.push({ category: CATEGORY.LISTS, bytes: 0, text: 'undecodable: ' + error.message });
    }
    return items;
  }

  // ---------------------------------------------------------------------

  /** Frame-log lines the timings core writes for spans. */
  const SPAN_START = /^span (.+) start$/;
  const SPAN_END = /^span (.+) end \((\d+)ms\)$/;

  class Recording {
    constructor() {
      this.header = null;
      this.states = [];
      this.messages = [];
      this.messagesById = new Map();
      this.frames = [];
      this.framesById = new Map();
      this.roots = [];
      this.logs = [];
      this.marks = [];
      this.screens = [];
      this.stockGlyphs = new Map();
      this.stockAdvances = new Map();
      this.end = null;
      this.warnings = [];
      /** Per lens (0 left, 1 right): {t, payload, message} in the order that lens acknowledged them. */
      this.ops = [[], []];
      /** The recording runs from t0 (the header) to t1; tMin is the earliest time anything in it mentions. */
      this.t0 = 0;
      this.t1 = 0;
      this.tMin = 0;
      this.width = 0;
      this.height = 0;
    }

    /** The stock-font glyph for `cp` followed by `next`, as emulator.js's `builtin` wants it. */
    builtin(cp, next) {
      const glyph = this.stockGlyphs.get(cp);
      let advance = this.stockAdvances.get(cp + ',' + next);
      if (advance === undefined) advance = this.stockAdvances.get(cp + ',*');
      if (advance === undefined) advance = glyph ? glyph.width + glyph.x + 1 : 0;
      return glyph ? { image: glyph.image, advance, x: glyph.x, y: glyph.y } : { image: EMPTY_GLYPH, advance, x: 0, y: 0 };
    }

    /** Lenses loaded with the starting state, ready for a Player. */
    createLenses() {
      return [0, 1].map((index) => {
        const lens = new Emulator.Lens(index === 1);
        lens.builtin = (cp, next) => this.builtin(cp, next);
        if (this.width > 0 && this.height > 0) lens.resize(this.width, this.height);
        for (const state of this.states) {
          if (state.lenses & (1 << index)) lens.loadState(state);
        }
        return lens;
      });
    }

    /** True when the messages can be replayed into a picture (rather than only counted). */
    get replayable() {
      return this.states.length > 0 || this.ops[0].length > 0 || this.ops[1].length > 0;
    }

    /** The phone's own composite most recently taken at or before `t`, or null. */
    screenAt(t) {
      let found = null;
      for (const screen of this.screens) {
        if (screen.t <= t) found = screen;
        else break;
      }
      return found || this.screens[0] || null;
    }
  }

  const EMPTY_GLYPH = new Uint8Array([0, 1, 1, 0]);

  function parseLines(text) {
    const records = [];
    let start = 0;
    let line = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      line++;
      if (end > start) {
        const source = text.slice(start, end).trim();
        if (source) {
          try {
            records.push(JSON.parse(source));
          } catch (error) {
            // A recording cut short ends mid-line; anything else is damage worth reporting.
            if (end < text.length) throw new Error('Line ' + line + ' is not JSON: ' + error.message);
          }
        }
      }
      start = end + 1;
    }
    return records;
  }

  /** Build a Recording from the file's text. Phone composites stay deflated until `inflateScreens`. */
  function parse(text) {
    const records = parseLines(text);
    const recording = new Recording();
    const header = records[0];
    if (!header || header.type !== 'header' || header.format !== FORMAT) throw new Error('Not a Faceclaw screen recording');
    if (header.version !== VERSION) throw new Error('Recording format version ' + header.version + ' is not supported (this tool reads version ' + VERSION + ')');
    recording.header = header;
    recording.width = header.width || 0;
    recording.height = header.height || 0;
    recording.t0 = header.t;
    recording.tMin = header.t;
    let last = header.t;
    const types = new Map();
    const applied = new Set();

    for (const record of records) {
      if (typeof record.t === 'number') {
        last = Math.max(last, record.t);
        // Frames already open when the recording started are replayed with their own, earlier times.
        recording.tMin = Math.min(recording.tMin, record.t);
      }
      switch (record.type) {
        case 'state': {
          const state = {
            t: record.t,
            lenses: record.lenses,
            width: record.width,
            height: record.height,
            root: record.root,
            screen: record.screen ? base64(record.screen) : null,
            resources: (record.resources || []).map((resource) => ({ id: resource.id, owner: resource.owner || null, data: base64(resource.data) })),
          };
          recording.states.push(state);
          if (!recording.width) {
            recording.width = state.width;
            recording.height = state.height;
          }
          for (const resource of state.resources) {
            types.set(resource.id, { type: resource.data[0] & 3, size: describeImage(resource.data) });
          }
          break;
        }
        case 'msg': {
          let message = recording.messagesById.get(record.id);
          if (!message) {
            if (record.payload === undefined) {
              recording.warnings.push('Message ' + record.id + ' is replayed here but was first written before the recording');
              break;
            }
            message = {
              id: record.id,
              kind: record.kind || '',
              label: record.label || '',
              sid: record.sid,
              magic: record.magic,
              arm: record.arm,
              lenses: record.lenses || 0,
              frame: record.frame || 0,
              update: record.update || 0,
              part: record.part || 0,
              parts: record.parts || 0,
              baseline: record.baseline === true,
              payload: base64(record.payload),
              attempts: [],
              lensAcks: [null, null],
              nacks: [],
              timeouts: [],
              ackT: null,
            };
            message.t = record.t;
            Object.assign(message, decodeMessage(message, types));
            recording.messages.push(message);
            recording.messagesById.set(message.id, message);
          }
          const wire = record.wire || [];
          message.attempts.push({ attempt: record.attempt || 1, t: record.t, magic: record.magic, wire, wireBytes: wire.reduce((sum, n) => sum + n, 0), sentT: null, ok: null });
          break;
        }
        case 'write': {
          // Packets written outside the message queue: traffic with nothing to decode or replay.
          const wire = record.wire || [];
          const message = {
            id: -(recording.messages.length + 1), kind: 'write', label: record.label || 'write', sid: -1, magic: 0, arm: record.arm,
            lenses: 0, frame: 0, update: 0, part: 0, parts: 0, baseline: false, payload: new Uint8Array(0), t: record.t,
            attempts: [{ attempt: 1, t: record.t, magic: 0, wire, wireBytes: wire.reduce((sum, n) => sum + n, 0), sentT: record.t, ok: true }],
            lensAcks: [null, null], nacks: [], timeouts: [], ackT: null, unqueued: true,
            name: 'write', items: [{ category: CATEGORY.CONTROL, bytes: 0, text: record.label || 'write' }],
          };
          recording.messages.push(message);
          break;
        }
        case 'sent': {
          const message = recording.messagesById.get(record.id);
          const attempt = message && message.attempts.find((entry) => entry.attempt === record.attempt && entry.sentT === null);
          if (attempt) {
            attempt.sentT = record.t;
            attempt.ok = record.ok !== false;
          }
          break;
        }
        case 'lens-ack': {
          const message = recording.messagesById.get(record.id);
          if (!message) break;
          if (record.nack) {
            message.nacks.push({ t: record.t, lens: record.lens });
            break;
          }
          const index = record.lens - 1;
          if (index !== 0 && index !== 1) break;
          if (message.lensAcks[index] === null) message.lensAcks[index] = record.t;
          // A message takes effect on a lens once, when that lens first acknowledges it. What was
          // planned before the recording is already in the starting state.
          const key = record.id * 4 + record.lens;
          if (message.sid === CFW_SID && !message.baseline && (message.lenses & record.lens) && !applied.has(key)) {
            applied.add(key);
            recording.ops[index].push({ t: record.t, payload: message.payload, message });
          }
          break;
        }
        case 'ack': {
          const message = recording.messagesById.get(record.id);
          if (message && message.ackT === null) message.ackT = record.t;
          break;
        }
        case 'timeout': {
          const message = recording.messagesById.get(record.id);
          if (message) message.timeouts.push(record.t);
          break;
        }
        case 'frame': {
          const frame = {
            id: record.id, parent: record.parent || 0, reason: record.reason || '', t: record.t, wallClockMs: record.wallClockMs || 0,
            endT: null, outcome: null, lines: [], spans: [], children: [], messages: [],
          };
          recording.frames.push(frame);
          recording.framesById.set(frame.id, frame);
          break;
        }
        case 'frame-note': {
          const frame = recording.framesById.get(record.id);
          if (frame) frame.reason = frame.reason ? frame.reason + ' ' + record.text : record.text;
          break;
        }
        case 'frame-log': {
          const frame = recording.framesById.get(record.id);
          if (!frame) break;
          const line = { t: record.t, thread: record.thread || '', text: record.text || '' };
          frame.lines.push(line);
          const started = SPAN_START.exec(line.text);
          const ended = !started && SPAN_END.exec(line.text);
          if (started) frame.spans.push({ name: started[1], t: line.t, endT: null });
          if (ended) {
            const span = frame.spans.findLast((entry) => entry.name === ended[1] && entry.endT === null);
            if (span) span.endT = line.t;
            line.span = span || { name: ended[1], t: line.t - Number(ended[2]), endT: line.t };
          }
          break;
        }
        case 'frame-end': {
          const frame = recording.framesById.get(record.id);
          if (frame && frame.endT === null) {
            frame.endT = record.t;
            frame.outcome = record.outcome || '';
          }
          break;
        }
        case 'log':
          recording.logs.push({ t: record.t, level: record.level || 'I', text: record.text || '' });
          break;
        case 'mark':
          recording.marks.push({ t: record.t, text: record.text || '' });
          break;
        case 'screen':
          recording.screens.push({
            t: record.t, source: record.source || 'phone', width: record.width, height: record.height,
            encoding: record.encoding || 'raw', data: base64(record.pixels), pixels: null,
          });
          break;
        case 'stock-font':
          for (const glyph of record.glyphs || []) {
            const pixels = base64(glyph.pixels);
            const image = new Uint8Array(3 + pixels.length);
            image.set([0, glyph.width, glyph.height]);
            image.set(pixels, 3);
            recording.stockGlyphs.set(glyph.cp, { image, x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height });
          }
          for (const [cp, next, advance] of record.advances || []) {
            recording.stockAdvances.set(cp + ',' + next, advance);
            // Before any other glyph the firmware's kerning is unknown: the first advance seen stands in.
            if (!recording.stockAdvances.has(cp + ',*')) recording.stockAdvances.set(cp + ',*', advance);
          }
          break;
        case 'end':
          recording.end = record;
          break;
        default:
          break;
      }
    }

    recording.t1 = Math.max(last, recording.t0 + 1);
    finishFrames(recording);
    finishMessages(recording);
    return recording;
  }

  function finishFrames(recording) {
    for (const frame of recording.frames) {
      const parent = frame.parent ? recording.framesById.get(frame.parent) : null;
      if (parent) parent.children.push(frame);
      else recording.roots.push(frame);
      frame.lines.sort((a, b) => a.t - b.t);
    }
    const finish = (frame, root) => {
      frame.root = root;
      let end = frame.endT === null ? recording.t1 : frame.endT;
      let sent = frame.outcome !== null && frame.outcome.startsWith('sent') ? frame.endT : null;
      for (const child of frame.children) {
        finish(child, root);
        end = Math.max(end, child.treeEndT);
        if (child.sentT !== null && (sent === null || child.sentT < sent)) sent = child.sentT;
      }
      frame.treeEndT = end;
      // When the first pixels of this frame's tree reached the glasses: its user-visible latency.
      frame.sentT = sent;
      frame.open = frame.endT === null || frame.children.some((child) => child.open);
    };
    for (const root of recording.roots) finish(root, root);
    recording.roots.sort((a, b) => a.t - b.t);
  }

  function finishMessages(recording) {
    for (const message of recording.messages) {
      message.bytes = message.payload.length;
      message.wireBytes = message.attempts.reduce((sum, attempt) => sum + attempt.wireBytes, 0);
      const byCategory = new Array(CATEGORIES.length).fill(0);
      for (const item of message.items) byCategory[item.category] += item.bytes;
      message.byCategory = byCategory;
      // The category most of its bytes are in names the message on the timeline.
      message.category = byCategory.indexOf(Math.max(...byCategory));
      if (message.category <= 0) message.category = CATEGORY.CONTROL;
      const lastAttempt = message.attempts[message.attempts.length - 1];
      message.endT = message.ackT !== null ? message.ackT : lastAttempt && lastAttempt.sentT !== null ? lastAttempt.sentT : message.t;
      const frame = message.frame ? recording.framesById.get(message.frame) : null;
      if (frame) frame.messages.push(message);
    }
  }

  /** Bring every phone composite to packed 4bpp rows. */
  async function inflateScreens(recording) {
    for (const screen of recording.screens) {
      if (screen.pixels) continue;
      screen.pixels = screen.encoding === 'deflate' ? await decompress(screen.data, 'deflate') : screen.data;
    }
  }

  /** Parse a recording file's bytes; a gzipped file is unpacked first. */
  async function load(bytes) {
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await decompress(bytes, 'gzip');
    const recording = parse(new TextDecoder().decode(bytes));
    await inflateScreens(recording);
    return recording;
  }

  // ---------------------------------------------------------------------
  // Where the bytes went

  /**
   * A message's bytes on the wire, split among its categories in proportion to their share of
   * the payload. (The link compresses the message stream as a whole, so the wire bytes of one
   * part of a message can't be known exactly.)
   */
  function wireShare(message, wireBytes) {
    const share = new Array(CATEGORIES.length).fill(0);
    if (message.bytes <= 0) {
      share[message.category] = wireBytes;
      return share;
    }
    for (let i = 1; i < CATEGORIES.length; i++) share[i] = (wireBytes * message.byCategory[i]) / message.bytes;
    return share;
  }

  /** Totals per category between `from` and `to` (by when each attempt was written). */
  function totals(recording, from = -Infinity, to = Infinity) {
    const rows = CATEGORIES.map((category, index) => category && { index, key: category.key, label: category.label, payload: 0, wire: 0, messages: 0, items: 0 });
    let payload = 0;
    let wire = 0;
    let messages = 0;
    let resent = 0;
    for (const message of recording.messages) {
      let counted = false;
      for (const attempt of message.attempts) {
        if (attempt.t < from || attempt.t > to) continue;
        const share = wireShare(message, attempt.wireBytes);
        for (let i = 1; i < CATEGORIES.length; i++) rows[i].wire += share[i];
        wire += attempt.wireBytes;
        if (attempt.attempt > 1) resent += attempt.wireBytes;
        if (counted) continue;
        counted = true;
        messages++;
        payload += message.bytes;
        for (let i = 1; i < CATEGORIES.length; i++) rows[i].payload += message.byCategory[i];
        const seen = new Set();
        for (const item of message.items) {
          // Framing is every message's overhead, not something it carried.
          if (item.framing) continue;
          rows[item.category].items++;
          if (!seen.has(item.category)) {
            seen.add(item.category);
            rows[item.category].messages++;
          }
        }
      }
    }
    return { rows: rows.slice(1), payload, wire, messages, resent };
  }

  /** Wire bytes per category in `count` equal buckets across [from, to). */
  function buckets(recording, from, to, count) {
    const width = (to - from) / count;
    const result = Array.from({ length: count }, (_, index) => ({ t: from + index * width, endT: from + (index + 1) * width, byCategory: new Array(CATEGORIES.length).fill(0), total: 0 }));
    for (const message of recording.messages) {
      for (const attempt of message.attempts) {
        if (attempt.t < from || attempt.t >= to) continue;
        const bucket = result[Math.min(count - 1, Math.floor((attempt.t - from) / width))];
        const share = wireShare(message, attempt.wireBytes);
        for (let i = 1; i < CATEGORIES.length; i++) bucket.byCategory[i] += share[i];
        bucket.total += attempt.wireBytes;
      }
    }
    return result;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
  }

  /** Root-to-first-pixels latency, as the frame-timings export reports it. */
  function latency(recording) {
    const input = [];
    const render = [];
    let sent = 0;
    let discarded = 0;
    let timedOut = 0;
    for (const frame of recording.frames) {
      if (frame.outcome === null) continue;
      if (frame.outcome.startsWith('sent')) sent++;
      else if (frame.outcome.startsWith('timeout')) timedOut++;
      else discarded++;
    }
    for (const root of recording.roots) {
      if (root.sentT === null || root.t < recording.t0) continue;
      (root.reason.startsWith('input:') ? input : render).push(root.sentT - root.t);
    }
    input.sort((a, b) => a - b);
    render.sort((a, b) => a - b);
    const summary = (values) => ({ count: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: values.length ? values[values.length - 1] : null });
    return { input: summary(input), render: summary(render), sent, discarded, timedOut, started: recording.frames.length };
  }

  return {
    FORMAT, VERSION, CFW_SID, CATEGORIES, CATEGORY, MESSAGE_NAMES, OP_NAMES, RESOURCE_TYPES,
    Recording, parse, load, inflateScreens, decodeMessage, describeDisplayList, describeImage,
    totals, buckets, latency, wireShare, base64,
  };
});
