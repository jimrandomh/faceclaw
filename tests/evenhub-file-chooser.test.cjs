const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function androidDouble(options = {}) {
  const listeners = new Map();
  const activities = [];
  let currentActivity = null;
  const application = {
    activityResultEvent: 'activityResult',
    activityDestroyedEvent: 'activityDestroyed',
    on(event, callback) { listeners.set(event, callback); },
    off(event, callback) {
      if (listeners.get(event) === callback) listeners.delete(event);
    },
  };
  const android = {
    app: { Activity: { RESULT_OK: -1 } },
    content: {
      Intent: class {
        static ACTION_OPEN_DOCUMENT = 'android.intent.action.OPEN_DOCUMENT';
        static CATEGORY_OPENABLE = 'android.intent.category.OPENABLE';
        static EXTRA_ALLOW_MULTIPLE = 'android.intent.extra.ALLOW_MULTIPLE';
        static EXTRA_MIME_TYPES = 'android.intent.extra.MIME_TYPES';
        constructor(action) { this.action = action; this.categories = []; this.extras = {}; }
        addCategory(category) { this.categories.push(category); }
        setType(type) { this.type = type; }
        putExtra(name, value) { this.extras[name] = value; }
      },
    },
    webkit: { WebChromeClient: { FileChooserParams: { MODE_OPEN_MULTIPLE: 1 } } },
  };
  const globals = {
    android,
    // Java-array double; the context's normal Array behavior remains intact.
    Array: class extends Array {
      static create(type, length) {
        const value = new globals.Array(length);
        value.nativeType = type;
        return value;
      }
    },
  };
  // Opt-in fake clock: the production module arms a watchdog only when timers
  // exist, so tests that do not ask for it keep the minimal sandbox.
  const timers = [];
  if (options.timers) {
    globals.setTimeout = (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    globals.clearTimeout = timer => { if (timer) timer.cleared = true; };
  }
  const api = loader(globals, {
    '@nativescript/core': {
      Application: { android: new Proxy(application, {
        get(target, property) {
          if (property === 'foregroundActivity' || property === 'startActivity') return currentActivity;
          return target[property];
        },
      }) },
    },
  })('app/apps/evenhub/file-chooser.ts');
  function activity(name) {
    const value = {
      name,
      launches: [],
      startActivityForResult(intent, requestCode) { this.launches.push({ intent, requestCode }); },
    };
    activities.push(value);
    return value;
  }
  return {
    api, listeners, activities, timers,
    activity,
    setCurrent(value) { currentActivity = value; },
    result(requestCode, resultCode = -1, intent = null) {
      listeners.get('activityResult')?.({ requestCode, resultCode, intent });
    },
    destroyed(value) { listeners.get('activityDestroyed')?.({ activity: value }); },
  };
}

function callbackDouble() {
  const values = [];
  return { values, callback: { onReceiveValue: value => values.push(value) } };
}

function params(accept = [], multiple = false) {
  return { getAcceptTypes: () => accept, getMode: () => multiple ? 1 : 0 };
}

function dataUri(uri) {
  return { getData: () => uri, getClipData: () => null };
}

function clipUris(...uris) {
  return {
    getData: () => { throw new Error('single data must not be read for ClipData'); },
    getClipData: () => ({
      getItemCount: () => uris.length,
      getItemAt: index => ({ getUri: () => uris[index] }),
    }),
  };
}

test('file chooser opens ACTION_OPEN_DOCUMENT from the current activity with ebook accept types', () => {
  const h = androidDouble();
  const old = h.activity('old'), current = h.activity('current');
  const chooser = new h.api.EvenHubFileChooser();
  const { callback } = callbackDouble();
  h.setCurrent(old);
  // Construction must not retain an activity; only the actual launch uses it.
  h.setCurrent(current);
  assert.equal(chooser.show({}, callback, params(['.epub', '.pdf', '.mobi'])), true);
  assert.equal(old.launches.length, 0);
  assert.equal(current.launches.length, 1);
  const { intent, requestCode } = current.launches[0];
  assert.equal(requestCode, h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE);
  assert.equal(intent.action, 'android.intent.action.OPEN_DOCUMENT');
  assert.deepEqual(intent.categories, ['android.intent.category.OPENABLE']);
  assert.equal(intent.type, '*/*');
  assert.deepEqual([...intent.extras['android.intent.extra.MIME_TYPES']],
    ['application/epub+zip', 'application/pdf', 'application/x-mobipocket-ebook']);
  assert.equal(intent.extras['android.intent.extra.ALLOW_MULTIPLE'], false);
  assert.equal(h.listeners.size, 2);
  chooser.cancel({});
});

test('file chooser honors multiple mode and returns every ClipData URI as android.net.Uri[]', () => {
  const h = androidDouble();
  const activity = h.activity('current');
  h.setCurrent(activity);
  const chooser = new h.api.EvenHubFileChooser();
  const { callback, values } = callbackDouble();
  const owner = {};
  assert.equal(chooser.show(owner, callback, params(['application/epub+zip', '.epub'], true)), true);
  const { intent } = activity.launches[0];
  assert.equal(intent.type, 'application/epub+zip');
  assert.equal(intent.extras['android.intent.extra.MIME_TYPES'], undefined);
  assert.equal(intent.extras['android.intent.extra.ALLOW_MULTIPLE'], true);
  assert.equal(chooser.show({}, callbackDouble().callback, params()), false, 'only one system picker may be pending');
  h.result(1234, -1, dataUri('content://wrong-request'));
  assert.equal(values.length, 0);
  h.result(h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE, -1, clipUris('content://one', 'content://two'));
  assert.equal(values.length, 1);
  assert.equal(values[0].nativeType, 'android.net.Uri');
  assert.deepEqual([...values[0]], ['content://one', 'content://two']);
  assert.equal(h.listeners.size, 0);
  h.result(h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE, -1, dataUri('content://late'));
  assert.equal(values.length, 1, 'late results cannot complete a callback twice');
});

test('file chooser returns one data URI and completes cancellation with null', () => {
  const h = androidDouble();
  h.setCurrent(h.activity('current'));
  const chooser = new h.api.EvenHubFileChooser();
  const first = callbackDouble();
  chooser.show({}, first.callback, params());
  h.result(h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE, -1, dataUri('content://book'));
  assert.deepEqual([...first.values[0]], ['content://book']);

  const second = callbackDouble();
  chooser.show({}, second.callback, params());
  h.result(h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE, 0, null);
  assert.deepEqual(second.values, [null]);
  assert.equal(h.listeners.size, 0);
});

test('file chooser cancels on owning activity destruction and only for its owning WebView', () => {
  const h = androidDouble();
  const old = h.activity('old');
  h.setCurrent(old);
  const chooser = new h.api.EvenHubFileChooser();
  const owner = {}, other = {};
  const first = callbackDouble();
  chooser.show(owner, first.callback, params());
  chooser.cancel(other);
  assert.equal(first.values.length, 0, 'closing another WebView must not steal the pending picker');
  h.destroyed(h.activity('unrelated'));
  assert.equal(first.values.length, 0);
  h.destroyed(old);
  assert.deepEqual(first.values, [null]);
  assert.equal(h.listeners.size, 0);

  const current = h.activity('recreated');
  h.setCurrent(current);
  const second = callbackDouble();
  chooser.show(owner, second.callback, params());
  assert.equal(current.launches.length, 1, 'recreation uses the new current activity');
  chooser.cancel(owner);
  assert.deepEqual(second.values, [null]);
  assert.equal(h.listeners.size, 0);
});

test('file chooser fails closed without an activity and cleans up launch/result failures', () => {
  const h = androidDouble();
  const chooser = new h.api.EvenHubFileChooser();
  assert.equal(chooser.show({}, callbackDouble().callback, params()), false);
  assert.equal(h.listeners.size, 0);

  const broken = h.activity('broken');
  broken.startActivityForResult = () => { throw new Error('no document provider'); };
  h.setCurrent(broken);
  const launch = callbackDouble();
  assert.equal(chooser.show({}, launch.callback, params()), true);
  assert.deepEqual(launch.values, [null]);
  assert.equal(h.listeners.size, 0);

  h.setCurrent(h.activity('working'));
  const malformed = callbackDouble();
  chooser.show({}, malformed.callback, params());
  h.result(h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE, -1, { getClipData() { throw new Error('bad result'); } });
  assert.deepEqual(malformed.values, [null]);
  assert.equal(h.listeners.size, 0);
});

test('file chooser relaxes the filter when an accept extension has no MIME mapping', () => {
  const h = androidDouble();
  const current = h.activity('current');
  h.setCurrent(current);
  const chooser = new h.api.EvenHubFileChooser();
  const { callback } = callbackDouble();
  const owner = {};
  // .cbz has no mapping; filtering the rest would hide the comic asked for.
  assert.equal(chooser.show(owner, callback, params(['.epub,.cbz'])), true);
  const { intent } = current.launches[0];
  assert.equal(intent.type, '*/*');
  assert.equal(intent.extras['android.intent.extra.MIME_TYPES'], undefined);
  chooser.cancel(owner);
  assert.equal(h.listeners.size, 0);
});

test('file chooser keeps a multi-type filter when every accept type is representable', () => {
  const h = androidDouble();
  const current = h.activity('current');
  h.setCurrent(current);
  const chooser = new h.api.EvenHubFileChooser();
  chooser.show({}, callbackDouble().callback, params(['.epub', '.pdf']));
  const { intent } = current.launches[0];
  assert.equal(intent.type, '*/*');
  assert.deepEqual([...intent.extras['android.intent.extra.MIME_TYPES']],
    ['application/epub+zip', 'application/pdf']);
  chooser.cancel({});
});

test('file chooser watchdog reclaims the single slot when no result ever arrives', () => {
  const h = androidDouble({ timers: true });
  const current = h.activity('current');
  h.setCurrent(current);
  const chooser = new h.api.EvenHubFileChooser();
  const owner = {};
  const stuck = callbackDouble();
  assert.equal(chooser.show(owner, stuck.callback, params()), true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, h.api.EVENHUB_FILE_CHOOSER_TIMEOUT_MS);

  // A leaked picker from another app must not block every later file input.
  assert.equal(chooser.show({}, callbackDouble().callback, params()), false);
  assert.equal(h.listeners.size, 2);

  h.timers[0].callback();
  assert.deepEqual(stuck.values, [null], 'the waiting WebView is released, not left hanging');
  assert.equal(h.listeners.size, 0);

  const retry = callbackDouble();
  assert.equal(chooser.show(owner, retry.callback, params()), true, 'slot is reusable after the timeout');
  assert.equal(current.launches.length, 2);

  // A real result disarms the watchdog so it cannot fire twice.
  h.result(h.api.EVENHUB_FILE_CHOOSER_REQUEST_CODE, -1, dataUri('content://book'));
  assert.deepEqual([...retry.values[0]], ['content://book']);
  assert.equal(h.timers[1].cleared, true);
  h.timers[1].callback();
  assert.equal(retry.values.length, 1, 'a cleared watchdog never completes the callback again');
});

test('file chooser does not filter a lone extension to a MIME guess', () => {
  // Books ships <input type="file" accept=".epub">. Android reports stored EPUBs
  // as application/octet-stream, so filtering to application/epub+zip opened a
  // picker with nothing selectable. Books validates .epub itself after choice.
  const h = androidDouble();
  const current = h.activity('current');
  h.setCurrent(current);
  const chooser = new h.api.EvenHubFileChooser();
  const owner = {};
  assert.equal(chooser.show(owner, callbackDouble().callback, params(['.epub'])), true);
  const { intent } = current.launches[0];
  assert.equal(intent.type, '*/*');
  assert.equal(intent.extras['android.intent.extra.MIME_TYPES'], undefined);
  chooser.cancel(owner);
  assert.equal(h.listeners.size, 0);
});

test('file chooser keeps a declared MIME filter even when it names one type', () => {
  // Apps that declare a real MIME (not an extension) still get the filter.
  const h = androidDouble();
  const current = h.activity('current');
  h.setCurrent(current);
  const chooser = new h.api.EvenHubFileChooser();
  const owner = {};
  chooser.show(owner, callbackDouble().callback, params(['application/epub+zip']));
  assert.equal(current.launches[0].intent.type, 'application/epub+zip');
  chooser.cancel(owner);
});

test('file chooser reads NativeScript Java String[] accept params without JS iteration', () => {
  const h = androidDouble();
  const current = h.activity('current');
  h.setCurrent(current);
  const chooser = new h.api.EvenHubFileChooser();
  const owner = {};
  // FileChooserParams.getAcceptTypes() returns a Java String[] proxy: indexed
  // values plus length, but deliberately no Symbol.iterator or join().
  const javaAcceptTypes = { 0: '.epub', length: 1 };
  const javaParams = {
    getAcceptTypes: () => javaAcceptTypes,
    getMode: () => 0,
  };
  // This exact shape threw "TypeError: values is not iterable" in the device log.
  assert.equal(chooser.show(owner, callbackDouble().callback, javaParams), true);
  assert.equal(current.launches.length, 1);
  assert.equal(current.launches[0].intent.type, '*/*');
  assert.equal(current.launches[0].intent.extras['android.intent.extra.MIME_TYPES'], undefined);
  chooser.cancel(owner);
  assert.equal(h.listeners.size, 0);
});
