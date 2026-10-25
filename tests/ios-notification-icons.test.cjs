const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

class FakeImage {
  constructor(name) { this.name = name; }
  clone() { return new FakeImage(this.name); }
  fillRoundedRect() {}
  fillRect() {}
}

function setup(notifications, render = name => new FakeImage(name)) {
  const icons = loader({}, {
    '../graphics/image': { GrayImage: class extends FakeImage { constructor() { super('drawn-bell'); } } },
    '../graphics/icons': { renderIcon: (name, size) => { assert.equal(size, 24); return render(name); } },
    '../g2/ancs-client': { AncsClient: class {}, ANCS_CONNECT_MESSAGE: '' },
    './notification-sources': { rememberNotificationSources() {} },
  })('app/native/notification-icons.ios.ts');
  icons.bindIosNotifications({ read: () => notifications });
  return icons;
}

const notification = (key, packageName, category) => ({ key, packageName, category });

test('tray icons follow each source\'s first notification category', () => {
  const icons = setup([
    notification('a', 'com.apple.mobilephone', '2'),
    notification('b', 'com.apple.mobilephone', '1'),
    notification('c', 'com.apple.mobilemail', '6'),
    notification('d', 'com.example.tv', '11'),
  ]);
  const result = icons.readActiveNotificationIcons(10, false);
  assert.deepEqual([...result.keys], ['a', 'c', 'd']);
  assert.deepEqual([...result.icons].map(icon => icon.name), ['phone-missed', 'mail', 'tv']);
  assert.equal(icons.readActiveNotificationIcons(1, false).icons.length, 1);
});

test('unknown categories use the bell; a failed rasterization uses the drawn bell', () => {
  const icons = setup([notification('a', 'x', '0'), notification('b', 'y', '12'), notification('c', 'z', '')]);
  assert.deepEqual([...icons.readActiveNotificationIcons(10, false).icons].map(icon => icon.name), ['bell', 'bell', 'bell']);
  assert.equal(icons.readNotificationIconByKey('missing', false).icon, null);

  const failing = setup([notification('a', 'x', '4')], () => null);
  assert.equal(failing.readNotificationIconByKey('a', false).icon.name, 'drawn-bell');
});

test('icons are copies, so callers can draw on them', () => {
  const shared = new FakeImage('message-circle');
  const icons = setup([notification('a', 'x', '4')], () => shared);
  assert.notEqual(icons.readNotificationIconByKey('a', false).icon, shared);
});
