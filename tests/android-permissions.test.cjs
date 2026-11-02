const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const GRANTED = 0;
const DENIED = -1;
const RECORD_AUDIO = 'android.permission.RECORD_AUDIO';

/**
 * app/g2/android-permissions.ts against a stubbed Android: `granted` is the set
 * of permissions already held, `activity` the foreground/start Activity (null
 * when Android started the process in the background, e.g. for a home-widget
 * update, and the app has not been opened yet).
 */
function permissions({ granted = [], activity = null } = {}) {
  const held = new Set(granted);
  const requests = [];
  const Application = {
    android: {
      foregroundActivity: activity,
      startActivity: activity,
      activityRequestPermissionsEvent: 'activityRequestPermissions',
      on() {},
      off() {},
    },
  };
  const globals = {
    global: { isAndroid: true },
    Array: { create: (_type, length) => new Array(length) },
    android: {
      content: { pm: { PackageManager: { PERMISSION_GRANTED: GRANTED } } },
      os: { Build: { VERSION: { SDK_INT: 34 } } },
      Manifest: { permission: { BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN', BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT' } },
    },
    androidx: {
      core: {
        content: { ContextCompat: { checkSelfPermission: (_context, permission) => (held.has(permission) ? GRANTED : DENIED) } },
        app: { ActivityCompat: { requestPermissions: (requester, list, code) => requests.push({ requester, list: [...list], code }) } },
      },
    },
  };
  const load = loader(globals, {
    '@nativescript/core': { Application, Utils: { android: { getApplicationContext: () => ({}) } } },
  });
  return { api: load('app/g2/android-permissions.ts'), requests };
}

test('a granted permission needs no Activity, so voice works after a background start', async () => {
  const { api, requests } = permissions({ granted: [RECORD_AUDIO], activity: null });
  await api.ensureVoicePermissions();
  assert.equal(requests.length, 0);
});

test('BLE permissions that are all granted need no Activity either', async () => {
  const { api } = permissions({
    granted: ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT', 'android.permission.POST_NOTIFICATIONS'],
    activity: null,
  });
  await api.ensureBlePermissions();
});

test('a missing permission is requested through the Activity', async () => {
  const activity = { name: 'main' };
  const { api, requests } = permissions({ granted: [], activity });
  void api.ensureVoicePermissions();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requester, activity);
  assert.deepEqual(requests[0].list, [RECORD_AUDIO]);
});

test('a missing permission with no Activity still fails, since nothing can show the prompt', async () => {
  const { api } = permissions({ granted: [], activity: null });
  await assert.rejects(api.ensureVoicePermissions(), /No Android activity/);
});
