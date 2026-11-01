const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');
const generator = require('../scripts/generate-pebble-icons.cjs');

function setup(notifications) {
  const load = loader({}, {
    '../g2/ancs-client': { AncsClient: class {}, ANCS_CONNECT_MESSAGE: '' },
    './notification-sources': { rememberNotificationSources() {} },
  });
  const icons = load('app/native/notification-icons.ios.ts');
  icons.bindIosNotifications({ read: () => notifications });
  return { icons, pebble: load('app/graphics/pebble-icons.ts') };
}

const notification = (key, packageName, category, appName = '') => ({ key, packageName, category, appName });

/** Which bundled icon an image is (icons are compared by their pixels). */
function iconName(pebble, image) {
  const data = loader({}, {})('app/graphics/pebble-icons-data.ts').PEBBLE_ICON_DATA;
  return Object.keys(data).find(name => Buffer.from(pebble.pebbleIcon(name).pixels).equals(Buffer.from(image.pixels)));
}

test('tray icons come from the source app, else its notification category, one per source', () => {
  const { icons, pebble } = setup([
    notification('a', 'net.whatsapp.WhatsApp', '4'),
    notification('b', 'net.whatsapp.WhatsApp', '4'),
    notification('c', 'com.apple.mobilephone', '2', 'Phone'),
    notification('d', 'com.apple.MobileSMS', '4', 'Messages'),
    notification('e', 'com.example.tv', '11', 'Some TV App'),
  ]);
  const result = icons.readActiveNotificationIcons(10, false);
  assert.deepEqual([...result.keys], ['a', 'c', 'd', 'e']);
  assert.deepEqual([...result.icons].map(icon => iconName(pebble, icon)), ['whatsApp', 'missedCall', 'sms', 'tv']);
  assert.equal(icons.readActiveNotificationIcons(1, false).icons.length, 1);
});

test('apps match by bundle ID ignoring case, by regional prefix, then by display name', () => {
  const { icons, pebble } = setup([
    notification('a', 'NET.WHATSAPP.WHATSAPP', '0'),
    notification('b', 'com.abbott.librelink.de', '0', 'LibreLink'),
    notification('c', 'com.ABCDE12345.loopkit.Loop', '0', 'Loop'),
    notification('d', 'com.example.unknown', '0', 'loopfollow'),
    notification('e', 'com.example.unknown2', '0', 'Some Loop App'),
  ]);
  const byKey = key => iconName(pebble, icons.readNotificationIconByKey(key, false).icon);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(byKey), ['whatsApp', 'glucose', 'glucose', 'glucose', 'generic']);
});

test('unknown categories use the generic bell; an unknown key has no icon', () => {
  const { icons, pebble } = setup([notification('a', 'x', '0'), notification('b', 'y', '12'), notification('c', 'z', '')]);
  assert.deepEqual([...icons.readActiveNotificationIcons(10, false).icons].map(icon => iconName(pebble, icon)), ['generic', 'generic', 'generic']);
  assert.equal(icons.readNotificationIconByKey('missing', false).icon, null);
});

test('icons are copies, so callers can draw on them', () => {
  const { icons, pebble } = setup([notification('a', 'net.whatsapp.WhatsApp', '4')]);
  const first = icons.readNotificationIconByKey('a', false).icon;
  first.pixels.fill(77);
  assert.equal(iconName(pebble, icons.readNotificationIconByKey('a', false).icon), 'whatsApp');
});

test('every icon the tables use is bundled, 25px square, quantized, and not blank', () => {
  const load = loader({}, {});
  const table = load('app/native/notification-app-icons.ts');
  const { pebbleIcon, PEBBLE_ICON_SIZE } = load('app/graphics/pebble-icons.ts');
  const { PEBBLE_ICON_DATA } = load('app/graphics/pebble-icons-data.ts');
  assert.equal(PEBBLE_ICON_SIZE, load('app/native/notification-types.ts').NOTIFICATION_ICON_SIZE);
  for (const name of table.allNotificationAppIcons()) assert.ok(name in PEBBLE_ICON_DATA, `${name} is not bundled`);
  for (const name of Object.keys(PEBBLE_ICON_DATA)) {
    const icon = pebbleIcon(name);
    assert.deepEqual([icon.width, icon.height], [25, 25], name);
    assert.ok(icon.pixels.every(value => value === 0 || value === 128 || value === 255), `${name} has unquantized pixels`);
    assert.ok(icon.pixels.some(value => value === 255), `${name} is blank`);
  }
});

test('the icon generator inverts Pebble art: black ink lights up, white fills hide what is under them', () => {
  const svg = `<svg viewBox="0 0 25 25" xmlns="http://www.w3.org/2000/svg">
    <line x1="2" y1="4" x2="22" y2="4" stroke="#000" stroke-width="2"/>
    <line x1="2" y1="10" x2="22" y2="10" stroke="#000" stroke-width="2"/>
    <rect x="10" y="8" width="6" height="6" fill="#fff"/>
    <g transform="translate(0 10)"><rect x="4" y="6" width="3" height="3" fill="black"/></g>
    <g display="none"><rect x="0" y="0" width="25" height="25" fill="#000"/></g>
  </svg>`;
  const pixels = generator.renderIcon(svg);
  const at = (x, y) => pixels[y * 25 + x];
  // A 2px stroke on a grid line covers exactly the two pixel rows either side of it.
  assert.deepEqual([at(5, 2), at(5, 3), at(5, 4), at(5, 5)], [0, 255, 255, 0]);
  // Round caps reach a pixel past each end.
  assert.equal(at(1, 3), 255);
  assert.equal(at(0, 3), 0);
  // The white rect drawn later hides the second line where they overlap.
  assert.deepEqual([at(8, 9), at(12, 9), at(17, 9)], [255, 0, 255]);
  // Black fills light up, through a group's transform; hidden groups draw nothing.
  assert.deepEqual([at(5, 17), at(5, 20)], [255, 0]);
  assert.equal(at(24, 24), 0);

  // Its encoding round-trips through the app's decoder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-icons-'));
  const dataFile = path.join(dir, 'pebble-icons-data.ts');
  fs.writeFileSync(dataFile, `export const PEBBLE_ICON_SIZE = 25;\nexport const PEBBLE_ICON_DATA = { probe: "${generator.encode(pixels)}" } as const;\n`);
  const decoded = loader({}, { './pebble-icons-data': loader({}, {})(dataFile) })('app/graphics/pebble-icons.ts').pebbleIcon('probe');
  assert.deepEqual([...decoded.pixels], [...pixels]);
});
