const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// FaceclawCommunicatorBridge over a fake Kotlin session that, like the real
// SurfaceCompositor, rejects calls for surfaces it does not hold. Configuring
// an id in `refused` fails the way IosGlassesSession reports it: false.
function harness(refused = new Set()) {
  const calls = [];
  const surfaces = new Set();
  const session = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    configureSurfaceIdXYWidthHeightZOrderTransparency(id) {
      calls.push(['configure', id]);
      if (refused.has(id)) return false;
      surfaces.add(id);
      return true;
    },
    removeSurfaceId(id) { calls.push(['remove', id]); surfaces.delete(id); },
    setSurfaceVisibleIdVisible(id) { calls.push(['visible', id]); if (!surfaces.has(id)) throw new Error(`unknown surface ${id}`); return true; },
    setSurfaceDepthIdDepth(id) { calls.push(['depth', id]); if (!surfaces.has(id)) throw new Error(`unknown surface ${id}`); return true; },
    submitSurfaceFramePixels8bppSurfaceIdRectXRectYRectWidthRectHeightContentFingerprintPaintMsFrameIdGlyphs(_pixels, id) {
      calls.push(['frame', id]);
      if (!surfaces.has(id)) throw new Error(`unknown surface ${id}`);
      return true;
    },
    isSurfaceCurrentSurfaceIdFingerprint: (id, fingerprint) => fingerprint === 'same',
  };
  class NSObject { static new() { return new this(); } }
  const timers = [];
  const load = loader({
    NSObject, NativeClass: () => cls => cls, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout: id => { timers[id - 1].cleared = true; },
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => session }) },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {}, console: { log() {}, warn() {} },
  }, {
    '@nativescript/core': { File: {}, knownFolders: {}, path: {} },
    '../g2/firmware-compat': { REQUIRED_FACECLAW_FIRMWARE_VERSION: 37 },
    './kotlin-data': { toData: bytes => bytes, fromData: data => data },
    './ios-graphics': { previewPixels() {} },
    './ios-bluetooth': { iosBluetooth: {} },
  });
  const { FaceclawCommunicatorBridge } = load('app/native/faceclaw-communicator.ios.ts');
  const bridge = new FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  // Run queued native calls (each is one setTimeout(0) hop) until none are left.
  async function drain() {
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const next = timers.find(timer => !timer.ran && !timer.cleared && timer.delay === 0);
      if (!next) { await new Promise(resolve => setImmediate(resolve)); if (!timers.some(t => !t.ran && !t.cleared && t.delay === 0)) return; continue; }
      next.ran = true; next.fn();
    }
  }
  return { bridge, calls, drain };
}

const rect = { x: 0, y: 0, width: 2, height: 1 };
const options = { x: 0, y: 0, width: 2, height: 1, zOrder: 0, transparency: 'opaque' };

test('a frame queued behind its surface removal is dropped instead of reaching Kotlin', async () => {
  const h = harness();
  const configured = h.bridge.configureSurface('window:transcribe', options); await h.drain(); await configured;
  // Close-window order: the removal is queued first, the in-flight render's frame lands behind it.
  const removed = h.bridge.removeSurface('window:transcribe');
  const frame = h.bridge.submitSurfaceFrame('window:transcribe', new Uint8Array(2), rect, 'f');
  const visible = h.bridge.setSurfaceVisible('window:transcribe', true);
  const depth = h.bridge.setSurfaceDepth('window:transcribe', 1);
  await h.drain();
  await Promise.all([removed, frame, visible, depth]);
  assert.deepEqual(h.calls, [['configure', 'window:transcribe'], ['remove', 'window:transcribe']]);
});

test('frames for a live surface still go through, including the idle inline path', async () => {
  const h = harness();
  const configured = h.bridge.configureSurface('window:calc', options); await h.drain(); await configured;
  await h.bridge.submitSurfaceFrame('window:calc', new Uint8Array(2), rect, 'f');
  assert.deepEqual(h.calls.at(-1), ['frame', 'window:calc']);
  const reconfigured = h.bridge.configureSurface('window:calc', options);
  const frame = h.bridge.submitSurfaceFrame('window:calc', new Uint8Array(2), rect, 'g');
  await h.drain(); await Promise.all([reconfigured, frame]);
  assert.deepEqual(h.calls.slice(-2), [['configure', 'window:calc'], ['frame', 'window:calc']]);
});

test('a surface Kotlin refuses to configure rejects, and its frames never reach Kotlin', async () => {
  const h = harness(new Set(['window:bad']));
  // Handler attached up front: the rejection lands while drain() runs.
  const configured = assert.rejects(h.bridge.configureSurface('window:bad', options), /Could not configure surface window:bad/);
  const frame = h.bridge.submitSurfaceFrame('window:bad', new Uint8Array(2), rect, 'f');
  await h.drain();
  await Promise.all([configured, frame]);
  assert.deepEqual(h.calls, [['configure', 'window:bad']]);
});

test('the preview target drops calls for surfaces it does not hold instead of reaching Kotlin', async () => {
  // Like IosSurfaceCompositor: these throw undeclared Kotlin exceptions, which abort the process.
  const calls = [];
  const surfaces = new Set();
  const held = (what, id) => { calls.push([what, id]); if (!surfaces.has(id)) throw new Error(`unknown surface ${id}`); };
  const native = {
    setPreviewAnimationListenerListener() {},
    configureIdXYWidthHeightZOrderTransparent(id) { calls.push(['configure', id]); surfaces.add(id); },
    removeId(id) { calls.push(['remove', id]); surfaces.delete(id); },
    visibleIdVisible: id => held('visible', id),
    depthIdDepth: id => held('depth', id),
    submitDrawsIdDataXYWidthHeightDraws: id => held('frame', id),
  };
  const kotlinData = { toData: bytes => bytes, fromData: data => data };
  const load = loader({
    FaceclawKitIosSurfaceCompositor: { alloc: () => ({ initWithWidthHeight: () => native }) }, console: { log() {} },
  }, {
    '@nativescript/core': { File: {}, knownFolders: {}, path: {} },
    '../graphics/image': { G2_LENS_WIDTH: 576, G2_LENS_HEIGHT: 288 },
    './ios-graphics': { previewPixels() {} },
    './kotlin-data': kotlinData, '../native/kotlin-data': kotlinData,
  });
  const { PreviewDisplayTarget } = load('app/native/preview-display.ios.ts');
  const target = new PreviewDisplayTarget();
  // A Glanceboard show() that outlived the session: the preview target replacing it never configured glance.
  await target.setSurfaceDepth('glance', 2);
  await target.setSurfaceVisible('glance', true);
  await target.submitSurfaceFrame('glance', new Uint8Array(2), rect, 'f');
  await target.configureSurface('window:calc', options);
  await target.submitSurfaceFrame('window:calc', new Uint8Array(2), rect, 'f');
  await target.removeSurface('window:calc');
  // A worker frame that lands after its window closed.
  await target.submitSurfaceFrame('window:calc', new Uint8Array(2), rect, 'g');
  await target.setSurfaceVisible('window:calc', false);
  assert.deepEqual(calls, [['configure', 'window:calc'], ['frame', 'window:calc'], ['remove', 'window:calc']]);
});
