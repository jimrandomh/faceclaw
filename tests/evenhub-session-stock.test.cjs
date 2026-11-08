// EvenHubSession behaviors that follow stock (the Even phone app plus
// firmware 2.2.9.22, as decompiled and run in the firmware emulator): text
// scrolling and its boundary events, text upgrades, image routing, and what a
// page the firmware can't build does.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loader } = require('./helpers/load-typescript.cjs');

// A face with 10px characters and 27px lines, wrapping only at '\n'.
const face = {
  lineHeight: 27,
  measureLine: text => text.length * 10,
  wrap: text => text.split('\n'),
  drawText() {},
  drawTextWrapped() {},
};

function harness() {
  const timers = [];
  const load = loader({ global: { isIOS: true }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, Promise }, {
    '@nativescript/core': { ApplicationSettings: { getString: (_k, d) => d, setString() {} } },
    'upng-js': require('upng-js'),
    '../../graphics/evenhub-font': { EvenHubFont: { get: () => face } },
    './fonts': { containerFace: () => face, availableFontFamilies: () => [], measureContainerText: () => ({ width: 0, lineHeight: 27 }) },
    '../../ui/dashboard-settings': {}, '../../ui/sound-effects': {}, './api-key-dialog': {},
    './mic-router': { evenHubMicRouter: {} }, './imu-router': { evenHubImuRouter: {} },
    './compass-router': { evenHubCompassRouter: {} }, '../../assistant/tool-registry': {},
    '../../native/location': {}, '../../native/location-tracker': {}, '../../native/location-permissions': {},
    '../../native/image-rgba': { decodeImageRgba: () => null },
  });
  const api = load('app/apps/evenhub/session.ts');
  const session = new api.EvenHubSession({ name: 'Probe', packageId: 'test.stock', permissions: [] }, '/test/dist', () => {}, '');
  let windowClosed = false;
  session.attachWindow({ requestRender() {}, windowId: 'probe', closeWindow: () => { windowClosed = true; } });
  const web = vm.createContext({ Promise, Map, Date, console });
  web.window = web;
  web.__faceclawEvenHub = { postMessage: (name, args, id) => session.handleBridgeCall(name, args, id) };
  session.attachWebView({ evaluateJs: script => vm.runInContext(script, web), destroy() {} });
  vm.runInContext(api.EVENHUB_BRIDGE_INJECT_SCRIPT, web);
  const events = [];
  web._listenEvenAppMessage = value => {
    const message = typeof value === 'string' ? JSON.parse(value) : value;
    if (message.method === 'evenHubEvent') events.push(JSON.parse(JSON.stringify(message.data)));
  };
  const call = (method, data = {}) => web.flutter_inappwebview.callHandler('evenAppMessage', JSON.stringify({ method, data }));
  const runTimers = () => { for (const fn of timers.splice(0)) fn(); };
  return { session, call, events, runTimers, windowClosed: () => windowClosed };
}

const lines = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const textPage = (content, extra = {}) => ({
  containerTotalNum: 1,
  textObject: [{ containerID: 1, containerName: 'body', xPosition: 0, yPosition: 0, width: 300, height: 100, content, isEventCapture: 1, ...extra }],
});
const swipe = (h, direction) => h.session.handleGesture({ type: direction === 'down' ? 'scroll-down' : 'scroll-up' });

test('an overflowing capture text container scrolls itself and reports only at its ends', async () => {
  const h = harness();
  // 6 lines = 162px in a 100px window: 62px to scroll, three 28px swipes.
  assert.equal(await h.call('createStartUpPageContainer', textPage(lines(6))), 0);
  h.events.length = 0;
  swipe(h, 'down'); swipe(h, 'down'); swipe(h, 'down');
  assert.deepEqual(h.events, [], 'no events while scrolling, nor for the swipe that reaches the end');
  swipe(h, 'down');
  assert.deepEqual(h.events, [{ type: 'textEvent', jsonData: { containerID: 1, containerName: 'body', eventType: 2 } }]);
  h.events.length = 0;
  swipe(h, 'up'); swipe(h, 'up'); swipe(h, 'up');
  assert.deepEqual(h.events, []);
  swipe(h, 'up');
  assert.deepEqual(h.events, [{ type: 'textEvent', jsonData: { containerID: 1, containerName: 'body', eventType: 1 } }]);
});

test('text that fits reports every swipe as reaching an end', async () => {
  const h = harness();
  await h.call('createStartUpPageContainer', textPage('short'));
  h.events.length = 0;
  swipe(h, 'down'); swipe(h, 'down');
  assert.equal(h.events.filter(e => e.type === 'textEvent' && e.jsonData.eventType === 2).length, 2);
});

test('text upgrades replace the whole text by id, ignore offsets, and keep old text when emptied', async () => {
  const h = harness();
  await h.call('createStartUpPageContainer', textPage('Hello world'));
  const body = () => h.session.page.containers[0];
  assert.equal(await h.call('textContainerUpgrade', { containerID: 1, containerName: 'other name', contentOffset: 3, contentLength: 2, content: 'XY' }), true);
  assert.equal(body().content, 'XY');
  assert.equal(await h.call('textContainerUpgrade', { containerID: 1, content: '' }), true);
  assert.equal(body().content, 'XY', 'an empty upgrade leaves the old text showing');
  assert.equal(await h.call('textContainerUpgrade', { containerID: 9, content: 'nope' }), false);
  assert.equal(await h.call('textContainerUpgrade', { containerID: 1, content: 'x', junk: 1 }), false, 'unknown keys are refused');
});

test('an upgrade scrolls the text back to the top', async () => {
  const h = harness();
  await h.call('createStartUpPageContainer', textPage(lines(6)));
  swipe(h, 'down');
  assert.equal(h.session.page.containers[0].scrollY, 28);
  await h.call('textContainerUpgrade', { containerID: 1, content: lines(7) });
  assert.equal(h.session.page.containers[0].scrollY, 0);
});

test('image updates need a page, an image at that id, and a usable payload', async () => {
  const h = harness();
  const raw = new Array(400).fill(0);
  assert.equal(await h.call('updateImageRawData', { containerID: 2, imageData: raw, compressMode: 2 }), 4, 'no page yet');
  await h.call('createStartUpPageContainer', {
    containerTotalNum: 3,
    textObject: [{ containerID: 1, containerName: 'body', width: 300, height: 100, content: 'x', isEventCapture: 1 },
      { containerID: 3, containerName: 'label', width: 50, height: 30, content: 'y' }],
    imageObject: [{ containerID: 2, containerName: 'icon', width: 20, height: 20 }, { containerID: 3, containerName: 'shadowed', width: 20, height: 20 }],
  });
  assert.equal(await h.call('updateImageRawData', { containerID: 2, imageData: raw, compressMode: 2 }), 0);
  assert.equal(await h.call('updateImageRawData', { containerID: 2, imageData: 'AAAA', compressMode: 2 }), 4, 'base64 is refused');
  assert.equal(await h.call('updateImageRawData', { containerID: 3, imageData: raw, compressMode: 2 }), 4, 'id 3 resolves to the text container');
  // With no image at that id the Even app has no size for raw pixels: 0x0 is out of range.
  assert.equal(await h.call('updateImageRawData', { containerID: 7, imageData: raw, compressMode: 2 }), 2);
});

test('a page the firmware cannot build fails create, and a failed rebuild closes the app', async () => {
  const h = harness();
  const tinyImage = { ...textPage('x'), imageObject: [{ containerID: 2, containerName: 'dot', width: 10, height: 10 }] };
  assert.equal(await h.call('createStartUpPageContainer', tinyImage), 1);
  assert.equal(await h.call('rebuildPageContainer', textPage('x')), false, 'nothing to rebuild before a page exists');
  assert.equal(await h.call('createStartUpPageContainer', textPage('x')), 0);
  h.events.length = 0;
  assert.equal(await h.call('rebuildPageContainer', tinyImage), false);
  assert.equal(h.session.page.containers.length, 0);
  assert.ok(h.events.some(e => e.type === 'sysEvent' && e.jsonData.eventType === 6), 'ABNORMAL_EXIT');
  h.runTimers();
  assert.equal(h.windowClosed(), true);
});

test('the Even app refuses malformed pages before they reach the glasses', async () => {
  const h = harness();
  assert.equal(await h.call('createStartUpPageContainer', textPage('x', { isEventCapture: true })), 1);
  assert.equal(await h.call('createStartUpPageContainer', textPage('x', { textColor: 7 })), 1);
  assert.equal(await h.call('createStartUpPageContainer', textPage('x')), 0);
  assert.equal(await h.call('rebuildPageContainer', { ...textPage('y'), Container_Total_Num: 1 }), false);
  assert.equal(h.session.page.containers[0].content, 'x', 'a refused rebuild leaves the page alone');
});

test('borders use the colour index, overflowing text gets a scrollbar, and images cover text', async () => {
  const h = harness();
  // 300x100 with a 2px border of colour 3; 6 lines overflow the 96px window by 66px.
  await h.call('createStartUpPageContainer', {
    containerTotalNum: 2,
    textObject: [{ containerID: 1, containerName: 'body', xPosition: 0, yPosition: 0, width: 300, height: 100, content: lines(6), isEventCapture: 1, borderWidth: 2, borderColor: 3 }],
    imageObject: [{ containerID: 2, containerName: 'icon', xPosition: 0, yPosition: 40, width: 20, height: 20 }],
  });
  await h.call('updateImageRawData', { containerID: 2, imageData: new Array(400).fill(0), compressMode: 2 });
  const image = h.session.paint({ width: 576, height: 288 }, true);
  const at = (x, y) => image.pixels[y * 576 + x];
  assert.equal(at(150, 0), 3 * 17, 'border grey');
  assert.equal(at(0, 50), 0, 'the black image covers the border under it');
  // Track 6..94 (88px); length floor(88 * 100 / 166) = 53; x 290..293.
  assert.deepEqual([at(290, 7), at(291, 7), at(293, 7), at(289, 7), at(294, 7)], [187, 187, 187, 0, 0]);
  assert.deepEqual([at(290, 6), at(291, 6), at(292, 6), at(293, 6)], [0, 187, 187, 0], 'chamfered top row');
  assert.equal(at(291, 58), 187);
  assert.equal(at(291, 59), 0, 'bar ends after 53 rows');
});
