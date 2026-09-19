const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutHubHeader } = require('../.test-build/app/apps/terminal/hub-header.js');
const font = size => ({ measureText: text => [...text].length * size, getGlyph: () => ({ dwidthX: size }) });
test('terminal short status stays inline; exact-fit status does not move the list', () => {
  const f = font(7), title = 'Terminal', status = 'Connected.';
  const width = 18 + f.measureText(title) + 16 + f.measureText(status) + 12;
  const header = layoutHubHeader(f, title, status, width, 18);
  assert.equal(header.y, 10); assert.equal(header.listTop, 34); assert.deepEqual(header.lines, [status]);
  assert.equal(layoutHubHeader(f, title, status, width - 1, 18).y, 28);
});
test('terminal long error wraps in full-width block and moves menu below all lines at each font size', () => {
  const status = 'Connection failed. The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.';
  for (const size of [5, 7, 12, 20]) for (const width of [320, 576, 640]) {
    const f = font(size), step = size * 2;
    const header = layoutHubHeader(f, 'Terminal - Connections', status, width, step);
    assert.equal(header.x, 18); assert.equal(header.y, 10 + step);
    assert.equal(header.lines.join(' '), status);
    assert.ok(header.lines.every(line => f.measureText(line) <= width - 30));
    assert.ok(header.listTop >= header.y + header.lines.length * step);
    assert.equal(header.listTop, 16 + step * (1 + header.lines.length));
  }
});
test('terminal explicit newlines and long unbroken messages remain complete', () => {
  const h = layoutHubHeader(font(7), 'Terminal', 'First\nSecond', 640, 18);
  assert.equal(h.x, 18); assert.deepEqual(h.lines, ['First', 'Second']);
  const word = 'x'.repeat(200);
  const wrapped = layoutHubHeader(font(7), 'Terminal', word, 320, 18);
  assert.equal(wrapped.lines.join(''), word);
});
