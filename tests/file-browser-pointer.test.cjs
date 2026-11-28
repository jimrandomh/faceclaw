const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const graphics = require('../.test-build/app/graphics/image.js');

test('Files pointer opens the shown folder and ignores the old rows until repaint', async () => {
  const textPositions = new Map();
  const picked = [];
  const font = {
    lineHeight: 12,
    measureText: text => text.length * 6,
    drawText: (_image, x, y, text) => textPositions.set(text, [x, y]),
  };
  const load = loader({ global: { isIOS: false } }, {
    '../../graphics/image': graphics,
    '../graphics/image': graphics,
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../graphics/screen-size': { screenWidth: () => 300, screenHeight: () => 130 },
    '../../graphics/icons': { renderIcon: () => null },
    '../graphics/icons': { renderIcon: () => null },
    '../../ui/dashboard-settings': { ConfigSettingEnum: class { get() { return 'list'; } } },
    '../../ui/icon-grid': { IconGrid: class { resetSelection() {} } },
    '../../native/settings-store': { getStringSetting: () => '[]' },
    '../native/settings-store': { getStringSetting: (_key, fallback) => fallback },
    '../../native/file-access': {
      hasAllFilesAccess: () => true,
      externalStorageRootPath: () => '/internal',
      listDirectory: path => path === '/' ? ['first.txt', 'document.txt'].map(name =>
        ({ name, path: '/' + name, isDirectory: false })) : [],
    },
  });
  const { FileBrowserLayer } = load('app/apps/files/file-browser.ts');
  const browser = new FileBrowserLayer({ isSupportedFile: () => true, onFilePicked: entry => picked.push(entry.path) });
  const ctx = { stack: {
    isFocused: () => true,
    getBaseSize: () => ({ width: 300, height: 130, padding: { top: 8, right: 8, bottom: 8, left: 8 } }),
  } };
  const paint = () => { textPositions.clear(); browser.paint(ctx); };
  paint();
  const [x, y] = textPositions.get('/');
  assert.equal(await browser.hitTest(0, y, ctx), false);
  assert.equal(await browser.hitTest(x, y, ctx), true);
  assert.equal(await browser.hitTest(x, y, ctx), false, 'the previous folder rows are no longer targets');
  paint();
  const [fileX, fileY] = textPositions.get('document.txt');
  assert.equal(await browser.hitTest(fileX, fileY, ctx), true);
  assert.deepEqual(picked, ['/document.txt']);
});
