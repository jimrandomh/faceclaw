const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapText } = require('../.test-build/app/graphics/textwrap.js');

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
