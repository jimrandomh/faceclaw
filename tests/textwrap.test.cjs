const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapStyledParagraph, wrapText } = require('../.test-build/app/graphics/textwrap.js');

// Monospace: every character is one unit wide, so widths count characters.
const mono = {
  measureText: (text) => [...text].length,
  getGlyph: () => ({ dwidthX: 1 }),
};

test('breakLongWords keeps words that fit on a line whole', () => {
  const text = 'Spotify plays on whichever of your devices is open';
  const expected = ['Spotify plays on', 'whichever of your', 'devices is open'];
  assert.deepEqual(wrapText(mono, text, 18), expected);
  assert.deepEqual(wrapText(mono, text, 18, { breakLongWords: true }), expected);
});

test('breakLongWords splits a word wider than a line, starting it on the current line', () => {
  assert.deepEqual(
    wrapText(mono, 'see abcdefghijklmnop end', 8, { breakLongWords: true }),
    ['see abcd', 'efghijkl', 'mnop end'],
  );
});

test('a word wider than a line is split when nothing else fits', () => {
  assert.deepEqual(wrapText(mono, 'abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText(mono, 'abcdefghij', 4, { breakLongWords: true }), ['abcd', 'efgh', 'ij']);
});

test('wrapping still breaks after slashes and hyphens', () => {
  assert.deepEqual(
    wrapText(mono, 'URI: http://127.0.0.1:43823/spotify-callback', 20, { breakLongWords: true }),
    ['URI: http://', '127.0.0.1:43823/', 'spotify-callback'],
  );
});

const wide = {
  measureText: (text) => [...text].length * 2,
  getGlyph: () => ({ dwidthX: 2 }),
};

test('wrapStyledParagraph measures each character in its own font', () => {
  // "aaaa " is plain and "bbbb" double width: 5 + 8 units in all.
  const fontAt = (offset) => (offset >= 5 ? wide : mono);
  const slices = (width) => wrapStyledParagraph('aaaa bbbb', fontAt, width).map(({ start, end }) => 'aaaa bbbb'.slice(start, end));
  assert.deepEqual(slices(13), ['aaaa bbbb']);
  assert.deepEqual(slices(12), ['aaaa', 'bbbb']);
});

test('wrapStyledParagraph matches wrapText for a single font', () => {
  const text = 'URI: http://127.0.0.1:43823/spotify-callback and some more words to wrap';
  for (const width of [4, 8, 13, 20, 200]) {
    const opts = { breakLongWords: true };
    const slices = wrapStyledParagraph(text, () => mono, width, opts).map(({ start, end }) => text.slice(start, end));
    assert.deepEqual(slices, wrapText(mono, text, width, opts));
  }
});

test('wrapStyledParagraph gives one empty range for an empty paragraph', () => {
  assert.deepEqual(wrapStyledParagraph('', () => mono, 10), [{ start: 0, end: 0 }]);
  assert.deepEqual(wrapStyledParagraph('   ', () => mono, 10), [{ start: 0, end: 0 }]);
});
