// Viewports for layout tests: what ctx.stack.getBaseSize() (or a worker's
// open-window message) hands a layout. Needs `tsc -p tests/tsconfig.json`.
const viewport = require('../../.test-build/app/ui/viewport.js');

/** A window with a border line along every edge (a framed window): 8px of padding all round. */
const bordered = (width, height) => viewport.viewportWith({ width, height }, viewport.uniformEdges('border'));

/** A window nothing borders (Border: None, or immersive): no padding. */
const unbordered = (width, height) => viewport.viewportWith({ width, height }, viewport.uniformEdges('offscreen'));

/** A window with border lines along just the named edges, e.g. edged(576, 260, 'top', 'left'). */
const edged = (width, height, ...borders) => viewport.viewportWith({ width, height }, {
  top: 'offscreen', right: 'offscreen', bottom: 'offscreen', left: 'offscreen',
  ...Object.fromEntries(borders.map((edge) => [edge, 'border'])),
});

module.exports = { ...viewport, bordered, unbordered, edged };
