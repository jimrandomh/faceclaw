'use strict';
const { WindowAnimator } = require('@faceclaw/motion');

// Inject the app's renderer; drawBody uses fixed final coordinates and card clipping.
module.exports = function animatedCard({ compact, expanded, buildBody, releaseBody, drawFrame, drawBody, submit, clock }) {
  let opened = false, body = null;
  const clearBody = () => { if (body !== null) releaseBody(body); body = null; };
  const animator = new WindowAnimator(frame => {
    const canvas = drawFrame(frame.rect, 'EXAMPLE');
    if (frame.bodyVisible) {
      if (body === null) body = buildBody();
      drawBody(canvas, body, expanded(), frame.rect);
    }
    submit(canvas);
  }, clock);
  return {
    setOpen(next) {
      if (next === opened) return;
      opened = next;
      if (!next) clearBody();
      const destination = next ? expanded() : compact();
      if (animator.isRunning()) animator.retarget(destination, !next);
      else animator.start(next ? compact() : expanded(), destination, !next);
    },
    // Call on hide, sleep, disconnect, removal, resize or content invalidation.
    cancel() { animator.cancel(); clearBody(); },
  };
};
