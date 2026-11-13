const test = require('node:test');
const assert = require('node:assert/strict');
const { HUB_TITLE_INSET_X, layoutHubHeader } = require('../.test-build/app/apps/terminal/hub-header.js');
const { bordered, unbordered, edged } = require('./helpers/viewport.cjs');
const font = size => ({ measureText: text => [...text].length * size, getGlyph: () => ({ dwidthX: size }) });
// Framed all round: the title 8px in plus its inset, and 2px below the top padding.
const TITLE_X = 8 + HUB_TITLE_INSET_X;
test('terminal short status stays inline; exact-fit status does not move the list', () => {
  const f = font(7), title = 'Terminal', status = 'Connected.';
  const width = TITLE_X + f.measureText(title) + 16 + f.measureText(status) + 8;
  const header = layoutHubHeader(f, title, status, bordered(width, 260), 18);
  assert.deepEqual([header.titleX, header.titleY], [TITLE_X, 10]);
  assert.equal(header.y, 10); assert.equal(header.listTop, 34); assert.deepEqual(header.lines, [status]);
  assert.equal(layoutHubHeader(f, title, status, bordered(width - 1, 260), 18).y, 28);
});
test('terminal long error wraps in full-width block and moves menu below all lines at each font size', () => {
  const status = 'Connection failed. The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.';
  for (const size of [5, 7, 12, 20]) for (const width of [320, 576, 640]) {
    const f = font(size), step = size * 2;
    const header = layoutHubHeader(f, 'Terminal - Connections', status, bordered(width, 260), step);
    assert.equal(header.x, TITLE_X); assert.equal(header.y, 10 + step);
    assert.equal(header.lines.join(' '), status);
    assert.ok(header.lines.every(line => f.measureText(line) <= width - TITLE_X - 8));
    assert.ok(header.listTop >= header.y + header.lines.length * step);
    assert.equal(header.listTop, 16 + step * (1 + header.lines.length));
  }
});
test('terminal explicit newlines and long unbroken messages remain complete', () => {
  const h = layoutHubHeader(font(7), 'Terminal', 'First\nSecond', bordered(640, 260), 18);
  assert.equal(h.x, TITLE_X); assert.deepEqual(h.lines, ['First', 'Second']);
  const word = 'x'.repeat(200);
  const wrapped = layoutHubHeader(font(7), 'Terminal', word, bordered(320, 260), 18);
  assert.equal(wrapped.lines.join(''), word);
});
test('terminal header keeps the padding of just the edges a border runs along', () => {
  const f = font(7), title = 'Terminal', status = 'Connected.';
  // Nothing bordered: the title starts its inset from the left edge, at the top edge's offset.
  const open = layoutHubHeader(f, title, status, unbordered(576, 260), 18);
  assert.deepEqual([open.titleX, open.titleY, open.y, open.listTop], [HUB_TITLE_INSET_X, 2, 2, 26]);
  // An inline status may run right up to an unbordered right edge, but stops 8px short of a bordered one.
  const fit = HUB_TITLE_INSET_X + f.measureText(title) + 16 + f.measureText(status);
  assert.equal(layoutHubHeader(f, title, status, unbordered(fit, 260), 18).lines.length, 1);
  assert.equal(layoutHubHeader(f, title, status, unbordered(fit, 260), 18).y, 2);
  assert.equal(layoutHubHeader(f, title, status, edged(fit, 260, 'right'), 18).y, 2 + 18);
  // Each edge on its own.
  const topLeft = layoutHubHeader(f, title, 'First\nSecond', edged(576, 260, 'top', 'left'), 18);
  assert.deepEqual([topLeft.titleX, topLeft.titleY, topLeft.x, topLeft.y], [TITLE_X, 10, TITLE_X, 28]);
  const bottom = layoutHubHeader(f, title, 'First\nSecond', edged(576, 260, 'bottom'), 18);
  assert.deepEqual([bottom.titleX, bottom.titleY, bottom.listTop], [HUB_TITLE_INSET_X, 2, 8 + 18 * 3]);
});
