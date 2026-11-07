const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

const APP_DIR = path.resolve(__dirname, '../app');
const FONT_DIR = '/fonts';
const SOLID = 15;

/** A renderer whose every glyph is a 2x1 raster (half, then full coverage) advancing 10px. */
function fakeFontRenderer(families) {
  const calls = [];
  return {
    calls,
    canLoadFont: (file) => path.basename(file) in families,
    getFontName: (file) => families[path.basename(file)],
    getFontMetrics: () => '12 4 0',
    // Pairs measure 1px tighter than their two advances: a kerning of -1.
    measureTextExact: (_file, text) => [...text].length * 10 - ([...text].length > 1 ? 1 : 0),
    renderGlyphCell: (file, size, codePoint) => {
      calls.push({ file: path.basename(file), size, codePoint });
      const bytes = new Uint8Array(10 + 2);
      bytes[0] = (10 * 64) & 0xff;
      bytes[1] = (10 * 64) >> 8;
      bytes[4] = 2; // inkTop
      bytes[6] = 2; // width
      bytes[8] = 1; // height
      bytes[10] = 128;
      bytes[11] = 255;
      return bytes;
    },
  };
}

function loadFonts({ families = {}, selection = null } = {}) {
  const fontRenderer = fakeFontRenderer(families);
  const fileNames = Object.keys(families);
  const load = loader(
    { global: { isAndroid: true, isIOS: false } },
    {
      '@nativescript/core': {
        knownFolders: {
          currentApp: () => ({
            path: APP_DIR,
            getFile: (file) => ({ readTextSync: () => fs.readFileSync(path.join(APP_DIR, file), 'utf8') }),
          }),
          documents: () => ({ getFolder: () => ({ path: FONT_DIR }) }),
        },
        path: { join: (...parts) => parts.join('/') },
        File: { exists: (file) => fileNames.includes(path.basename(file)) },
        Folder: {
          fromPath: () => ({ getEntitiesSync: () => fileNames.map((name) => ({ name, path: `${FONT_DIR}/${name}` })) }),
        },
      },
      '../native/font-renderer': { fontRenderer },
      './font-renderer': { fontRenderer },
      '../native/settings-store': {
        getStringSetting: (key, fallback) => (key === 'display.uiFont2' && selection ? JSON.stringify(selection) : fallback),
        setStringSetting() {},
        onSettingsStoreChanged() {},
      },
    },
  );
  return {
    fontRenderer,
    uiFonts: load('app/graphics/ui-fonts.ts'),
    TtfFont: load('app/graphics/ttf-font.ts').TtfFont,
    bdf: load('app/graphics/bdffont.ts'),
    installed: load('app/graphics/installed-fonts.ts'),
  };
}

const ROBOTO = {
  'Roboto-Light.ttf': 'Roboto\nLight',
  'Roboto-Regular.ttf': 'Roboto\nRegular',
  'Roboto-Medium.ttf': 'Roboto\nMedium',
  'Roboto-SemiBold.ttf': 'Roboto\nSemiBold',
  'Roboto-Bold.ttf': 'Roboto\nBold',
  'Roboto-LightItalic.ttf': 'Roboto\nLight Italic',
  'Roboto-BoldItalic.ttf': 'Roboto\nBold Italic',
  'Other-Bold.ttf': 'Other\nBold',
};

test('bold picks the lightest actually-bold face of the same family', () => {
  const { installed } = loadFonts({ families: ROBOTO });
  const sibling = (file) => installed.boldSiblingFont(`${FONT_DIR}/${file}`)?.fileName ?? null;
  assert.equal(sibling('Roboto-Light.ttf'), 'Roboto-SemiBold.ttf');
  assert.equal(sibling('Roboto-SemiBold.ttf'), 'Roboto-Bold.ttf');
  assert.equal(sibling('Roboto-Bold.ttf'), null, 'nothing heavier');
  assert.equal(sibling('Other-Bold.ttf'), null, 'other families do not count');
  assert.equal(sibling('Roboto-LightItalic.ttf'), null, 'no upright substitute for an italic');
});

test('without a bold face, bold picks the heaviest that is still heavier', () => {
  const { installed } = loadFonts({
    families: { 'A-Light.ttf': 'A\nLight', 'A-Regular.ttf': 'A\nRegular', 'A-Medium.ttf': 'A\nMedium' },
  });
  assert.equal(installed.boldSiblingFont(`${FONT_DIR}/A-Light.ttf`).fileName, 'A-Medium.ttf');
});

test('a TTF variant scales the size and swaps to the bold sibling', () => {
  const { uiFonts, TtfFont } = loadFonts({ families: ROBOTO });
  const base = TtfFont.load(`${FONT_DIR}/Roboto-Light.ttf`, 16);
  assert.equal(uiFonts.uiFontVariant(base, 1, false), base);
  const larger = uiFonts.uiFontVariant(base, 1.5, false);
  assert.equal(larger.sizePx, 24);
  assert.equal(path.basename(larger.path), 'Roboto-Light.ttf');
  const heading = uiFonts.uiFontVariant(base, 1.5, true);
  assert.equal(heading.sizePx, 24);
  assert.equal(path.basename(heading.path), 'Roboto-SemiBold.ttf');
  assert.equal(uiFonts.uiFontVariant(base, 1.5, true), heading, 'memoized');
});

test('a face with nothing heavier is emboldened rather than left looking the same', () => {
  const { uiFonts, TtfFont } = loadFonts({ families: ROBOTO });
  const base = TtfFont.load(`${FONT_DIR}/Roboto-Bold.ttf`, 16);
  const bold = uiFonts.uiFontVariant(base, 1, true);
  assert.notEqual(bold, base);
  assert.equal(bold.path, base.path);
  assert.notEqual(bold.atlasKey, base.atlasKey, 'distinct rasters need a distinct atlas identity');
  assert.notEqual(bold.fingerprintId, base.fingerprintId);
});

test('emboldening thickens the raster by keeping the stronger coverage of each pixel', () => {
  const { TtfFont } = loadFonts({ families: ROBOTO });
  const glyph = TtfFont.load(`${FONT_DIR}/Roboto-Bold.ttf`, 16, 1, true).getGlyph(65);
  const plain = TtfFont.load(`${FONT_DIR}/Roboto-Bold.ttf`, 16).getGlyph(65);
  assert.equal(plain.bbxWidth, 2);
  assert.deepEqual(Array.from(plain.coverage), [8, SOLID]);
  assert.equal(glyph.bbxWidth, 3);
  // Unshifted [8, 15, 0] over shifted [0, 8, 15]: the middle stays solid, which
  // a second strike 1px over would not (its faint left edge would overwrite it).
  assert.deepEqual(Array.from(glyph.coverage), [8, SOLID, SOLID]);
  assert.equal(glyph.advance, plain.advance + 1);
  assert.equal(glyph.dwidthX, plain.dwidthX + 1);
});

test('emboldening leaves the face\'s kerning alone', () => {
  const { TtfFont } = loadFonts({ families: ROBOTO });
  const plain = TtfFont.load(`${FONT_DIR}/Roboto-Bold.ttf`, 16);
  const bold = TtfFont.load(`${FONT_DIR}/Roboto-Bold.ttf`, 16, 1, true);
  assert.equal(plain.measureText('AB'), 19);
  assert.equal(bold.measureText('AB'), 21);
});

test('plain and emboldened loads of one face are separate fonts, with separate glyphs', () => {
  const { TtfFont, fontRenderer } = loadFonts({ families: ROBOTO });
  const file = `${FONT_DIR}/Roboto-Bold.ttf`;
  assert.equal(TtfFont.load(file, 16), TtfFont.load(file, 16));
  assert.notEqual(TtfFont.load(file, 16), TtfFont.load(file, 16, 1, true));
  TtfFont.load(file, 16).getGlyph(65);
  TtfFont.load(file, 16, 1, true).getGlyph(65);
  assert.equal(fontRenderer.calls.length, 2);
});

test('a space stays inkless when emboldened', () => {
  const renderer = loadFonts({ families: ROBOTO });
  renderer.fontRenderer.renderGlyphCell = () => {
    const bytes = new Uint8Array(10);
    bytes[0] = (10 * 64) & 0xff;
    bytes[1] = (10 * 64) >> 8;
    return bytes;
  };
  const space = renderer.TtfFont.load(`${FONT_DIR}/Roboto-Bold.ttf`, 16, 1, true).getGlyph(32);
  assert.equal(space.bbxWidth, 0);
  assert.equal(space.coverage, undefined);
  assert.equal(space.advance, 11);
});

const bitrows = (glyph) => Array.from(glyph.bitmapRows, (row) => row.toString(2).padStart(((glyph.bbxWidth + 7) >> 3) << 3, '0'));

test('a bitmap glyph thickens to the right, and advances further', () => {
  const { bdf } = loadFonts();
  const base = bdf.getFont('terminus12');
  const bold = base.emboldened();
  const [plainI, boldI] = [base, bold].map((font) => font.getGlyph(0x49));
  assert.equal(boldI.dwidthX, plainI.dwidthX + 1);
  assert.equal(boldI.bbxWidth, plainI.bbxWidth + 1);
  bitrows(plainI).forEach((row, index) => {
    const thick = bitrows(boldI)[index];
    for (let bit = 0; bit < row.length; bit++) {
      if (row[bit] === '1') {
        assert.equal(thick[bit], '1');
        assert.equal(thick[bit + 1], '1');
      }
    }
  });
  assert.notEqual(bold.atlasKey, base.atlasKey);
  assert.equal(bold.lineHeight, base.lineHeight);
});

test('a bitmap glyph widening past a byte realigns its rows', () => {
  const { bdf } = loadFonts();
  const font = new bdf.BdfFont({
    ascent: 8,
    descent: 0,
    defaultChar: 65,
    glyphs: new Map([[65, { encoding: 65, dwidthX: 9, bbxWidth: 8, bbxHeight: 1, bbxX: 0, bbxY: 0, bitmapRows: [0b10000001] }]]),
  });
  const glyph = font.emboldened().getGlyph(65);
  assert.equal(glyph.bbxWidth, 9);
  assert.deepEqual(bitrows(glyph), ['1100000110000000']);
});

test('emboldening a font carries through its fallback', () => {
  const { bdf } = loadFonts();
  const bold = bdf.getFont('terminusv12').emboldened();
  const outsideLatin1 = 0x416; // Zhe: only in the Terminus fallback
  assert.equal(bold.getGlyph(outsideLatin1).dwidthX, bdf.getFont('terminus12').getGlyph(outsideLatin1).dwidthX + 1);
});

test('bitmap bold at body size thickens the base face; larger sizes use real Terminus bold', () => {
  const { uiFonts, bdf } = loadFonts();
  const terminus = bdf.getFont('terminus12');
  const proportional = bdf.getFont('terminusv12');
  const bold = uiFonts.uiFontVariant(terminus, 1, true);
  assert.equal(bold.atlasKey, 'terminus12+embolden');
  // Stays proportional: "i" and "W" keep different advances.
  const boldV = uiFonts.uiFontVariant(proportional, 1, true);
  assert.equal(boldV.atlasKey, 'terminusv12+embolden');
  assert.notEqual(boldV.getGlyph(0x69).dwidthX, boldV.getGlyph(0x57).dwidthX);
  assert.equal(uiFonts.uiFontVariant(terminus, 1.5, true).atlasKey, 'terminus18b');
  assert.equal(uiFonts.uiFontVariant(terminus, 1.3, true).atlasKey, 'terminus16b');
  assert.equal(uiFonts.uiFontVariant(terminus, 1.15, true).atlasKey, 'terminus14b');
  assert.equal(uiFonts.uiFontVariant(proportional, 1.5, false).atlasKey, 'terminus18');
});
