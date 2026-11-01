#!/usr/bin/env node
/**
 * Rasterizes Pebble notification/timeline icons from a checkout of
 * https://github.com/pebble-dev/iconography (Apache-2.0) into
 * app/graphics/pebble-icons-data.ts, for notification sources that come
 * without an icon of their own (iPhone notifications over ANCS).
 *
 *   git clone https://github.com/pebble-dev/iconography ~/src/pebble-iconography
 *   node scripts/generate-pebble-icons.cjs ~/src/pebble-iconography [--preview sheet.pgm]
 *
 * The 25px icons are drawn black-on-white for Pebble's light screen, on a
 * 25x25 pixel grid. They are rendered here at 1:1 into 25x25 coverage
 * bitmaps for a black display: what was ink is lit, and white fills are
 * dark (painted in order, so a white fill still hides what is under it).
 * Strokes get round caps and joins, as Pebble's own renderer drew them.
 * Pixels are quantized to the 0 / 128 / 255 coverage levels the SVG icons
 * use (SvgIconSource.quantizeCoverage). --preview writes a contact sheet
 * (4x scale, ICONS order, 10 per row) to check the result by eye.
 *
 * Only the SVG subset these icons use is supported (path with
 * M/L/H/V/C/S/Q/Z, line, polyline, polygon, rect, circle, ellipse; nested
 * groups with translate/scale/matrix transforms); anything else fails
 * loudly rather than drawing wrong.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZE = 25;
const SUPERSAMPLE = 8;
const OUTPUT = path.join(__dirname, '..', 'app', 'graphics', 'pebble-icons-data.ts');

/** Icon name (as the app refers to it) -> source SVG within the iconography checkout. */
const ICONS = {
  // Generic pictograms, for notification categories and for apps without a brand icon.
  generic: 'pebbleos/Pebble_25x25_Generic_notification.svg',
  activity: 'pebbleos/Pebble_25x25_Activity.svg',
  alarmClock: 'pebbleos/Pebble_25x25_Alarm_clock.svg',
  appStore: 'icons/25px_Appstore.svg',
  calendar: 'pebbleos/Pebble_25x25_Calendar.svg',
  car: 'pebbleos/Pebble_25x25_Car_rental.svg',
  contacts: 'icons/25px_Contacts_book.svg',
  dinner: 'pebbleos/Pebble_25x25_Dinner_reservation.svg',
  email: 'pebbleos/Pebble_25x25_Generic_e-mail.svg',
  flight: 'pebbleos/Pebble_25x25_Scheduled_flight.svg',
  glucose: 'pebbleos/Pebble_25x25_Glucose_monitor.svg',
  heart: 'pebbleos/Pebble_25x25_Heart.svg',
  incomingCall: 'pebbleos/Pebble_25x25_Incoming_call.svg',
  location: 'pebbleos/Pebble_25x25_Location.svg',
  microphone: 'icons/25px_Microphone.svg',
  missedCall: 'pebbleos/Pebble_25x25_Missed_call.svg',
  movie: 'pebbleos/Pebble_25x25_Movie_event.svg',
  music: 'icons/25px_Music_note.svg',
  news: 'pebbleos/Pebble_25x25_News_event.svg',
  payBill: 'pebbleos/Pebble_25x25_Pay_bill.svg',
  phone: 'pebbleos/Pebble_25x25_During_phone_call.svg',
  podcast: 'pebbleos/Pebble_25x25_Radio_show.svg',
  reminder: 'pebbleos/Pebble_25x25_Generic_reminder.svg',
  settings: 'pebbleos/Pebble_25x25_Settings.svg',
  shopping: 'icons/25px_Shopping_bag.svg',
  sms: 'icons/25px_SMS.svg',
  stocks: 'pebbleos/Pebble_25x25_Stocks_event.svg',
  tv: 'pebbleos/Pebble_25x25_TV_show.svg',
  voicemail: 'icons/25px_Phone.svg',
  warning: 'pebbleos/Pebble_25x25_Generic_warning.svg',
  weather: 'pebbleos/Pebble_25x25_Generic_weather.svg',
  // Brands.
  airmail: 'brand-logos/Airmail_25px.svg',
  amazon: 'pebbleos/Pebble_25x25_Amazon.svg',
  appleShortcuts: 'brand-logos/Apple_Shortcuts_25px.svg',
  bbcNews: 'brand-logos/BBC_News_25px.svg',
  beeper: 'brand-logos/Beeper_25px.svg',
  bluesky: 'brand-logos/Bluesky_25px.svg',
  discord: 'brand-logos/Discord_25px.svg',
  duolingo: 'brand-logos/Duolingo_25px.svg',
  ebay: 'brand-logos/eBay_25px.svg',
  element: 'brand-logos/Element_25px.svg',
  facebook: 'pebbleos/Pebble_25x25_Facebook_notification.svg',
  facetime: 'pebbleos/Pebble_25x25_Facetime_incoming.svg',
  gmail: 'pebbleos/Pebble_25x25_Gmail_notification.svg',
  googleChat: 'brand-logos/Google_Chat_25px.svg',
  googleMaps: 'pebbleos/Pebble_25x25_Google_Maps.svg',
  googlePhotos: 'pebbleos/Pebble_25x25_Google_Photos.svg',
  googleTasks: 'brand-logos/Google_Tasks_25px.svg',
  homeAssistant: 'brand-logos/Home_Assistant_25px.svg',
  instagram: 'pebbleos/Pebble_25x25_Instagram.svg',
  iosPhotos: 'pebbleos/Pebble_25x25_iOS_Photos.svg',
  kakaoTalk: 'pebbleos/Pebble_25x25_KakaoTalk.svg',
  kik: 'pebbleos/Pebble_25x25_Kik.svg',
  line: 'pebbleos/Pebble_25x25_Line.svg',
  linkedIn: 'pebbleos/Pebble_25x25_LinkedIn.svg',
  messenger: 'pebbleos/Pebble_25x25_Facebook_messenger_notification.svg',
  omniFocus: 'brand-logos/OmniFocus_25px.svg',
  outlook: 'brand-logos/Outlook_25px.svg',
  reddit: 'brand-logos/Reddit_25px.svg',
  signal: 'brand-logos/Signal_25px.svg',
  simplex: 'brand-logos/SimpleX_25px.svg',
  slack: 'pebbleos/Pebble_25x25_Slack.svg',
  snapchat: 'pebbleos/Pebble_25x25_Snapchat.svg',
  steam: 'brand-logos/Steam_25px.svg',
  substack: 'brand-logos/Substack_25px.svg',
  swarm: 'brand-logos/Swarm_25px.svg',
  tapo: 'brand-logos/Tapo_25px.svg',
  teams: 'brand-logos/Teams_25px.svg',
  telegram: 'pebbleos/Pebble_25x25_Telegram_app.svg',
  threads: 'brand-logos/Threads_25px.svg',
  tiktok: 'brand-logos/TikTok_25px.svg',
  twitch: 'brand-logos/Twitch_25px.svg',
  twitter: 'pebbleos/Pebble_25x25_Twitter_notification.svg',
  unifiProtect: 'brand-logos/Unifi_Protect_25px.svg',
  viber: 'pebbleos/Pebble_25x25_Viber.svg',
  waze: 'brand-logos/Waze_25px.svg',
  weChat: 'pebbleos/Pebble_25x25_WeChat.svg',
  whatsApp: 'pebbleos/Pebble_25x25_WhatsApp_notification.svg',
  whatsAppBusiness: 'brand-logos/WhatsApp_Business_25px.svg',
  yahooMail: 'pebbleos/Pebble_25x25_Yahoo_mail.svg',
  youtube: 'brand-logos/Youtube_25px.svg',
  zoom: 'brand-logos/Zoom_25px.svg',
};

// ----- XML -----------------------------------------------------------------

/** A minimal well-formed-XML reader: elements and attributes; text, comments and PIs are skipped. */
function parseXml(text) {
  const root = { tag: '#document', attrs: {}, children: [] };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let match;
  while ((match = token.exec(text))) {
    if (match[1]) {
      const open = stack.pop();
      if (!open || open.tag !== match[1]) throw new Error(`mismatched </${match[1]}>`);
    } else if (match[2]) {
      const attrs = {};
      for (const a of match[3].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
      const element = { tag: match[2], attrs, children: [] };
      stack[stack.length - 1].children.push(element);
      if (!match[4]) stack.push(element);
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1].tag}>`);
  const svg = root.children.find((child) => child.tag === 'svg');
  if (!svg) throw new Error('no <svg> element');
  return svg;
}

// ----- Styles and transforms -----------------------------------------------

const INHERITED = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'fill-rule'];

/** Presentation attributes overlaid by the style attribute (which wins, as in CSS). */
function ownStyle(element) {
  const style = { ...element.attrs };
  for (const part of (element.attrs.style ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) style[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return style;
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function parseTransform(text) {
  let m = IDENTITY;
  if (!text) return m;
  for (const [, name, args] of text.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (name === 'translate') m = multiply(m, [1, 0, 0, 1, v[0], v[1] ?? 0]);
    else if (name === 'scale') m = multiply(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else if (name === 'matrix' && v.length === 6) m = multiply(m, v);
    else throw new Error(`unsupported transform ${name}(${args})`);
  }
  return m;
}

/** 0 (white) .. 1 (black): how lit a color's ink is once the icon is inverted. */
function inkOf(color) {
  if (!color || color === 'none' || color === 'transparent') return null;
  const named = { black: '#000000', white: '#ffffff', currentcolor: '#000000' };
  let hex = named[color.toLowerCase()] ?? color;
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('');
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`unsupported color ${color}`);
  const n = parseInt(hex.slice(1), 16);
  const luminance = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return 1 - luminance;
}

// ----- Geometry ------------------------------------------------------------

const CURVE_STEPS = 16;
const ARC_STEPS = 48;

/** Subpaths ({ points: [[x, y], ...], closed }) in the element's own coordinates. */
function shapeOf(element) {
  const a = element.attrs;
  const num = (name, fallback = 0) => (a[name] === undefined ? fallback : parseFloat(a[name]));
  switch (element.tag) {
    case 'path': return pathSubpaths(a.d ?? '');
    case 'line': return [{ points: [[num('x1'), num('y1')], [num('x2'), num('y2')]], closed: false }];
    case 'polyline':
    case 'polygon': {
      const v = (a.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
      const points = [];
      for (let i = 0; i + 1 < v.length; i += 2) points.push([v[i], v[i + 1]]);
      return points.length ? [{ points, closed: element.tag === 'polygon' }] : [];
    }
    case 'rect': {
      const x = num('x'), y = num('y'), w = num('width'), h = num('height');
      let rx = a.rx === undefined ? num('ry') : num('rx');
      let ry = a.ry === undefined ? rx : num('ry');
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (w <= 0 || h <= 0) return [];
      if (rx <= 0 || ry <= 0) return [{ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
      const points = [];
      const corners = [[x + w - rx, y + ry, -90], [x + w - rx, y + h - ry, 0], [x + rx, y + h - ry, 90], [x + rx, y + ry, 180]];
      for (const [cx, cy, start] of corners) {
        for (let i = 0; i <= ARC_STEPS / 4; i++) {
          const t = ((start + (90 * i) / (ARC_STEPS / 4)) * Math.PI) / 180;
          points.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
      }
      return [{ points, closed: true }];
    }
    case 'circle':
    case 'ellipse': {
      const rx = element.tag === 'circle' ? num('r') : num('rx');
      const ry = element.tag === 'circle' ? num('r') : num('ry');
      if (rx <= 0 || ry <= 0) return [];
      const points = [];
      for (let i = 0; i < ARC_STEPS; i++) {
        const t = (2 * Math.PI * i) / ARC_STEPS;
        points.push([num('cx') + rx * Math.cos(t), num('cy') + ry * Math.sin(t)]);
      }
      return [{ points, closed: true }];
    }
    default:
      return null;
  }
}

function pathSubpaths(d) {
  const tokens = d.match(/[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const subpaths = [];
  let current = null;
  let x = 0, y = 0, startX = 0, startY = 0;
  let lastControl = null;
  let command = '';
  let i = 0;
  const next = () => {
    if (i >= tokens.length || /[A-Za-z]/.test(tokens[i])) throw new Error(`path data ends early: ${d}`);
    return Number(tokens[i++]);
  };
  const lineTo = (nx, ny) => { current.points.push([nx, ny]); x = nx; y = ny; };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const [x0, y0] = [x, y];
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS, u = 1 - t;
      current.points.push([
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    x = x3; y = y3; lastControl = [x2, y2];
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++];
    else if (!command) throw new Error(`path data starts without a command: ${d}`);
    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    const upper = command.toUpperCase();
    if (upper !== 'C' && upper !== 'S') lastControl = null;
    switch (upper) {
      case 'M': {
        const nx = ox + next(), ny = oy + next();
        current = { points: [[nx, ny]], closed: false };
        subpaths.push(current);
        x = startX = nx; y = startY = ny;
        command = rel ? 'l' : 'L'; // further pairs are implicit line-tos
        break;
      }
      case 'L': lineTo(ox + next(), oy + next()); break;
      case 'H': lineTo(ox + next(), y); break;
      case 'V': lineTo(x, oy + next()); break;
      case 'C': cubic(ox + next(), oy + next(), ox + next(), oy + next(), ox + next(), oy + next()); break;
      case 'S': {
        const [cx, cy] = lastControl ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y];
        cubic(cx, cy, ox + next(), oy + next(), ox + next(), oy + next());
        break;
      }
      case 'Q': {
        const qx = ox + next(), qy = oy + next(), ex = ox + next(), ey = oy + next();
        cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        lastControl = null;
        break;
      }
      case 'Z':
        if (current) current.closed = true;
        x = startX; y = startY;
        // A drawing command straight after Z starts a new subpath at the start point.
        current = { points: [[x, y]], closed: false };
        subpaths.push(current);
        command = '';
        break;
      default:
        throw new Error(`unsupported path command ${command} in ${d}`);
    }
  }
  return subpaths.filter((subpath) => subpath.points.length > 1 || subpath.closed);
}

// ----- Rasterization -------------------------------------------------------

const GRID = SIZE * SUPERSAMPLE;

/** Mark the samples a shape's fill covers (scanline crossings, nonzero or evenodd). */
function fillMask(subpaths, evenOdd) {
  const mask = new Uint8Array(GRID * GRID);
  const edges = [];
  for (const { points } of subpaths) {
    for (let k = 0; k < points.length; k++) {
      const [x0, y0] = points[k], [x1, y1] = points[(k + 1) % points.length];
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  }
  for (let row = 0; row < GRID; row++) {
    const sy = (row + 0.5) / SUPERSAMPLE;
    const crossings = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
        crossings.push([x0 + ((sy - y0) * (x1 - x0)) / (y1 - y0), y1 > y0 ? 1 : -1]);
      }
    }
    crossings.sort((p, q) => p[0] - q[0]);
    let winding = 0;
    for (let k = 0; k + 1 < crossings.length; k++) {
      winding += crossings[k][1];
      const inside = evenOdd ? (k + 1) % 2 === 1 : winding !== 0;
      if (!inside) continue;
      const from = Math.max(0, Math.ceil(crossings[k][0] * SUPERSAMPLE - 0.5));
      const to = Math.min(GRID - 1, Math.floor(crossings[k + 1][0] * SUPERSAMPLE - 0.5));
      for (let col = from; col <= to; col++) mask[row * GRID + col] = 1;
    }
  }
  return mask;
}

/** Mark the samples within half the stroke width of any segment: round caps and joins. */
function strokeMask(subpaths, width) {
  const mask = new Uint8Array(GRID * GRID);
  const half = width / 2;
  const segment = (x0, y0, x1, y1) => {
    const minCol = Math.max(0, Math.floor((Math.min(x0, x1) - half) * SUPERSAMPLE));
    const maxCol = Math.min(GRID - 1, Math.ceil((Math.max(x0, x1) + half) * SUPERSAMPLE));
    const minRow = Math.max(0, Math.floor((Math.min(y0, y1) - half) * SUPERSAMPLE));
    const maxRow = Math.min(GRID - 1, Math.ceil((Math.max(y0, y1) + half) * SUPERSAMPLE));
    const dx = x1 - x0, dy = y1 - y0, length2 = dx * dx + dy * dy;
    for (let row = minRow; row <= maxRow; row++) {
      const sy = (row + 0.5) / SUPERSAMPLE;
      for (let col = minCol; col <= maxCol; col++) {
        const sx = (col + 0.5) / SUPERSAMPLE;
        const t = length2 ? Math.max(0, Math.min(1, ((sx - x0) * dx + (sy - y0) * dy) / length2)) : 0;
        const ex = sx - (x0 + t * dx), ey = sy - (y0 + t * dy);
        if (ex * ex + ey * ey <= half * half) mask[row * GRID + col] = 1;
      }
    }
  };
  for (const { points, closed } of subpaths) {
    if (points.length === 1) segment(points[0][0], points[0][1], points[0][0], points[0][1]);
    for (let k = 0; k + 1 < points.length; k++) segment(...points[k], ...points[k + 1]);
    if (closed && points.length > 2) segment(...points[points.length - 1], ...points[0]);
  }
  return mask;
}

function composite(ink, mask, value, alpha) {
  for (let k = 0; k < ink.length; k++) if (mask[k]) ink[k] = ink[k] * (1 - alpha) + value * alpha;
}

/** Render one SVG source to SIZE x SIZE coverage values (0..255, quantized). */
function renderIcon(svgText) {
  const svg = parseXml(svgText);
  const viewBox = (svg.attrs.viewBox ?? `0 0 ${SIZE} ${SIZE}`).trim().split(/[\s,]+/).map(Number);
  const [minX, minY, vw, vh] = viewBox;
  // 1:1 keeps the icons' pixel-grid strokes crisp; larger art scales down.
  const scale = Math.min(1, SIZE / vw, SIZE / vh);
  const offsetX = scale === 1 ? Math.round((SIZE - vw) / 2) : (SIZE - vw * scale) / 2;
  const offsetY = scale === 1 ? Math.round((SIZE - vh) / 2) : (SIZE - vh * scale) / 2;
  const base = [scale, 0, 0, scale, offsetX - minX * scale, offsetY - minY * scale];
  const ink = new Float32Array(GRID * GRID);

  const walk = (element, inherited, matrix, opacity) => {
    const own = ownStyle(element);
    if (own.display === 'none' || own.visibility === 'hidden') return;
    const style = { ...inherited };
    for (const key of INHERITED) if (own[key] !== undefined) style[key] = own[key];
    const m = multiply(matrix, parseTransform(element.attrs.transform));
    const alpha = opacity * (own.opacity === undefined ? 1 : parseFloat(own.opacity));
    if (element.tag === 'svg' || element.tag === 'g') {
      for (const child of element.children) walk(child, style, m, alpha);
      return;
    }
    const subpaths = shapeOf(element);
    if (subpaths === null) {
      // Not drawn: definitions, editor metadata, and the stray embedded
      // reference bitmap in one export (Pebble's converter skips them too).
      if (['defs', 'clipPath', 'mask', 'title', 'desc', 'metadata', 'image', 'style'].includes(element.tag) || element.tag.includes(':')) return;
      throw new Error(`unsupported element <${element.tag}>`);
    }
    const placed = subpaths.map(({ points, closed }) => ({
      closed,
      points: points.map(([px, py]) => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]),
    }));
    const fill = inkOf(style.fill ?? 'black');
    if (fill !== null) {
      const fillAlpha = alpha * parseFloat(style['fill-opacity'] ?? '1');
      composite(ink, fillMask(placed, style['fill-rule'] === 'evenodd'), fill, fillAlpha);
    }
    const stroke = inkOf(style.stroke);
    const width = parseFloat(style['stroke-width'] ?? '1') * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    if (stroke !== null && width > 0) {
      const strokeAlpha = alpha * parseFloat(style['stroke-opacity'] ?? '1');
      composite(ink, strokeMask(placed, width), stroke, strokeAlpha);
    }
  };
  walk(svg, {}, base, 1);

  const pixels = new Uint8Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let sum = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) sum += ink[(py * SUPERSAMPLE + sy) * GRID + px * SUPERSAMPLE + sx];
      }
      const coverage = (sum / (SUPERSAMPLE * SUPERSAMPLE)) * 255;
      pixels[py * SIZE + px] = coverage < 64 ? 0 : coverage >= 192 ? 255 : 128;
    }
  }
  return pixels;
}

// ----- Output --------------------------------------------------------------

const LEVEL_CODES = { 0: 0, 128: 1, 255: 2 };

/** 2 bits per pixel (0 / 128 / 255), four pixels per byte, high bits first; base64. */
function encode(pixels) {
  const bytes = Buffer.alloc(Math.ceil(pixels.length / 4));
  for (let k = 0; k < pixels.length; k++) bytes[k >> 2] |= LEVEL_CODES[pixels[k]] << (6 - 2 * (k & 3));
  return bytes.toString('base64');
}

function writePreview(file, rendered) {
  const SCALE = 4, CELL = (SIZE + 4) * SCALE, COLUMNS = 10;
  const rows = Math.ceil(rendered.length / COLUMNS);
  const width = COLUMNS * CELL, height = rows * CELL;
  const image = Buffer.alloc(width * height, 40);
  rendered.forEach(({ pixels }, index) => {
    const left = (index % COLUMNS) * CELL + 2 * SCALE, top = Math.floor(index / COLUMNS) * CELL + 2 * SCALE;
    for (let y = 0; y < SIZE * SCALE; y++) {
      for (let x = 0; x < SIZE * SCALE; x++) {
        image[(top + y) * width + left + x] = pixels[Math.floor(y / SCALE) * SIZE + Math.floor(x / SCALE)];
      }
    }
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), image]));
}

function main() {
  const args = process.argv.slice(2);
  const previewAt = args.indexOf('--preview');
  const preview = previewAt >= 0 ? args.splice(previewAt, 2)[1] : null;
  const checkout = args[0];
  if (!checkout) {
    console.error('usage: generate-pebble-icons.cjs <pebble-dev/iconography checkout> [--preview sheet.pgm]');
    process.exit(2);
  }
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const rendered = Object.entries(ICONS).map(([name, source]) => {
    try {
      return { name, source, pixels: renderIcon(fs.readFileSync(path.join(checkout, source), 'utf8')) };
    } catch (error) {
      throw new Error(`${source}: ${error.message}`);
    }
  });
  const lines = [
    '// Generated by scripts/generate-pebble-icons.cjs; do not edit by hand.',
    '//',
    '// Pebble notification icons from https://github.com/pebble-dev/iconography',
    `// (commit ${commit}): the original Pebble Technology icons and`,
    '// Rebble community additions, licensed under the Apache License 2.0 (see',
    '// app/graphics/pebble-icons.LICENSE). Modified: rasterized at 25x25 and',
    '// inverted for a black display (Pebble draws them black on white).',
    '//',
    '// Each icon is SIZE x SIZE pixels at 2 bits each (0, 1, 2 = coverage 0,',
    '// 128, 255), four pixels to a byte with the first in the high bits,',
    '// row-major, base64-encoded.',
    '',
    `export const PEBBLE_ICON_SIZE = ${SIZE};`,
    '',
    'export const PEBBLE_ICON_DATA = {',
    ...rendered.map(({ name, source, pixels }) => `  ${name}: "${encode(pixels)}", // ${source}`),
    '} as const;',
    '',
    'export type PebbleIconName = keyof typeof PEBBLE_ICON_DATA;',
    '',
  ];
  fs.writeFileSync(OUTPUT, lines.join('\n'));
  console.log(`wrote ${rendered.length} icons to ${path.relative(process.cwd(), OUTPUT)}`);
  if (preview) {
    writePreview(preview, rendered);
    console.log(`preview: ${preview}`);
    rendered.forEach(({ name }, index) => process.stdout.write(`${index % 10 === 0 ? '\n' : ' '}${name}`));
    process.stdout.write('\n');
  }
}

if (require.main === module) main();

module.exports = { renderIcon, encode, ICONS, SIZE };
