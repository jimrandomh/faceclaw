const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const payload = new Uint8Array([5, 4, 1, 0xb8, 0x0b, 25, 80, 0]);

test('iOS game worker forwards an immutable byte payload through its host and ignores closed windows', async () => {
  const played = [], worker = { postMessage() {} };
  const load = loader({ global: { isIOS: true, postMessage: data => worker.onmessage({ data }) } }, {
    '../../graphics/image': {}, './chrome-layer': { windowIcon() {} },
    '../../assistant/tool-registry': { toolRegistry: { removeAppTools() {} } },
    './geometry': { appViewportSize: () => ({ width: 576, height: 260 }) },
    '../../native/frame-timings': {}, './worker-state': {},
    './shell': { shell: { registerWindow() {} } },
  });
  const { WorkerAppHost } = load('app/ui/shell/worker-window.ts');
  const bridge = load('app/native/worker-buzzer.ts');
  const host = new WorkerAppHost({ appId: 'blocks', worker, configureSurface: async () => {},
    requestShellRender() {}, removeSurface() {}, playBuzzerSequence: bytes => played.push(bytes) });
  bridge.playWorkerBuzzerSequence(payload);
  assert.equal(played.length, 0);
  const window = host.openWindow({ windowId: 'blocks', title: 'Blocks' });
  const backing = new Uint8Array(payload.length + 2); backing.set(payload, 1);
  bridge.playWorkerBuzzerSequence(backing.subarray(1, -1)); backing.fill(0);
  assert.deepEqual(played, [payload]);
  window.close(); bridge.playWorkerBuzzerSequence(payload);
  assert.equal(played.length, 1);
});

test('Android game bridge retains direct native playback and skips a missing communicator', () => {
  let active = null;
  const played = [];
  const bridge = loader({ global: { isIOS: false },
    com: { faceclaw: { app: { FaceclawBleCommunicator: { getActive: () => active } } } } })('app/native/worker-buzzer.ts');
  bridge.playWorkerBuzzerSequence(payload);
  active = { playBuzzerSequence: buffer => played.push(new Uint8Array(buffer)) };
  const backing = new Uint8Array(payload.length + 2); backing.set(payload, 1);
  bridge.playWorkerBuzzerSequence(backing.subarray(1, -1)); backing.fill(0);
  assert.deepEqual(played, [payload]);
});
