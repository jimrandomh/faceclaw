const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// ui-fonts.ts and screen-size.ts over an in-memory settings store, with each
// TTF "loaded" as its path and size.
function fixture(entries = []) {
  const store = new Map(entries);
  const listeners = [];
  const load = loader({}, {
    '../native/settings-store': {
      getStringSetting: (key, fallback) => store.get(key) ?? fallback,
      setStringSetting: (key, value) => { store.set(key, value); for (const listener of listeners) listener(key); },
      onSettingsStoreChanged: (listener) => listeners.push(listener),
    },
    './image': { G2_LENS_WIDTH: 640, G2_LENS_HEIGHT: 480, RAYNEO_IO_WIDTH: 540, RAYNEO_IO_HEIGHT: 220 },
    './bdffont': { getFont: (name) => ({ name }) },
    './ttf-font': { TtfFont: { load: (path, size) => ({ path, size, lineHeight: size + 4 }) } },
    './installed-fonts': { ensurePreinstalledFonts() {}, getInstalledFont: () => null, installedFontPath: (file) => `/fonts/${file}` },
  });
  return { fonts: load('app/graphics/ui-fonts.ts'), screen: load('app/graphics/screen-size.ts'), store, listeners };
}

test('the screen and the default UI font follow the paired glasses: 640x480 at 16px, or a RayNeo iO\'s 540x220 at 14px', () => {
  const { fonts, screen, store, listeners } = fixture();
  assert.deepEqual([screen.screenWidth(), screen.screenHeight(), screen.isRayNeoIoConfigured()], [640, 480, false]);
  assert.equal(fonts.defaultUiFontSize(), 16);
  assert.deepEqual({ ...fonts.getUiFontSelection() }, { kind: 'ttf', file: 'Roboto-Light.ttf', size: 16 });
  assert.equal(fonts.getDefaultSmallFont().size, 16);
  // Pairing a RayNeo iO: the cached fonts re-resolve at its size.
  store.set(screen.GLASSES_TYPE_KEY, 'rayneo-io');
  for (const listener of listeners) listener(screen.GLASSES_TYPE_KEY);
  assert.deepEqual([screen.screenWidth(), screen.screenHeight(), screen.isRayNeoIoConfigured()], [540, 220, true]);
  assert.equal(fonts.defaultUiFontSize(), 14);
  assert.deepEqual({ ...fonts.getUiFontSelection() }, { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 });
  assert.equal(fonts.getDefaultSmallFont().size, 14);
});

test('a chosen UI font keeps its size on either glasses', () => {
  const { fonts, screen, store } = fixture([['deviceType', 'rayneo-io']]);
  fonts.setUiFontSelection({ kind: 'ttf', file: 'Roboto-Light.ttf', size: 17 });
  assert.equal(fonts.getUiFontSelection().size, 17);
  store.set(screen.GLASSES_TYPE_KEY, 'g2');
  assert.equal(fonts.getUiFontSelection().size, 17);
});
