const assert = require('node:assert/strict');
const test = require('node:test');
const { loader } = require('./helpers/load-typescript.cjs');
const {
  NeuralBandModalities, focusNeuralBandSearchTarget, focusedNeuralBandSearchTarget, neuralBandCursorPlane,
} = require('../.test-build/app/g2/neural-band-modalities.js');

function fixture() {
  const actions = [];
  let target = null;
  let pointerAccepted = true;
  let handwritingAccepted = true;
  const modes = new NeuralBandModalities({
    setPointer(enabled) { actions.push(['pointer', enabled]); return pointerAccepted; },
    setHandwriting(enabled) { actions.push(['writing', enabled]); return handwritingAccepted; },
    resetHandwritingText(text) { actions.push(['reset', text]); },
    pointerChanged(cursor) { actions.push(['cursor', cursor]); },
    pointerClick(x, y) { actions.push(['click', x, y]); },
    pointerBack() { actions.push(['back']); },
    writingTarget: () => focusedNeuralBandSearchTarget() ?? target,
    bounds: () => ({ width: 300, height: 150 }),
  });
  return {
    actions, modes,
    focus(value) { target = value; },
    refusePointer() { pointerAccepted = false; },
    refuseHandwriting() { handwritingAccepted = false; },
  };
}

function draft(initial) {
  let text = initial;
  let active = false;
  return { getText: () => text, setText(value) { text = value; }, setHandwritingActive(value) { active = value; }, get active() { return active; } };
}

test('air pointer moves and clamps in panel pixels; index clicks on release and middle goes back', () => {
  const { actions, modes } = fixture();
  modes.onPointer([0, 0, 10, 0]);
  assert.deepEqual(actions, []);
  assert.equal(modes.togglePointer(), true);
  modes.onPointer([0, 10, 3, -1, 1, 10, 0, 0, 2, 10, 1, 0]);
  assert.deepEqual(actions.at(-1), ['cursor', { x: 165, y: 70, primaryDown: true }]);
  assert.equal(actions.some(([name]) => name === 'click'), false);
  modes.onPointer([1, 10.1, 0, 0, 2, 10.1, 0, 0, 2, 11, 2, 0]);
  assert.deepEqual(actions.filter(([name]) => ['click', 'back'].includes(name)), [['click', 165, 70], ['back']]);
  modes.onPointer([0, 12, 1000, -1000, 0, 12, Number.NaN, 0]);
  assert.deepEqual(actions.at(-1), ['cursor', { x: 299, y: 0, primaryDown: false }]);
  modes.pointerOff();
  assert.deepEqual(actions.at(-1), ['cursor', null]);
});

test('dragging a pinch, stopping mid-pinch, and a late release never click', () => {
  const { actions, modes } = fixture();
  modes.togglePointer();
  modes.onPointer([2, 10, 1, 0, 0, 10.1, 4, 0, 2, 10.2, 0, 0]);
  modes.onPointer([2, 11, 1, 0, 2, 12, 0, 0]);
  modes.onPointer([2, 13, 1, 0]);
  modes.stop();
  modes.onPointer([2, 13.1, 0, 0]);
  assert.equal(actions.some(([name]) => name === 'click'), false);
  assert.deepEqual(actions.slice(-2), [['pointer', false], ['cursor', null]]);
});

test('pointer plane is positioned at the cursor tip and shows a held pinch', () => {
  const raised = neuralBandCursorPlane({ x: 19, y: 12, primaryDown: false }, 5);
  const pressed = neuralBandCursorPlane({ x: 19, y: 12, primaryDown: true }, 5);
  assert.deepEqual([raised.x, raised.y, raised.shellKey], [19, 12, 5]);
  assert.equal(raised.image.getPixel(0, 0), 255);
  assert.ok(pressed.image.getPixel(1, 2) > raised.image.getPixel(1, 2));
});

test('cumulative handwriting can insert and edit a focused draft; finishing keeps it', () => {
  const { actions, modes, focus } = fixture();
  const compose = draft('Café');
  focus(compose);
  assert.equal(modes.toggleHandwriting(), true);
  assert.deepEqual(actions, [['writing', true], ['reset', 'Café']]);
  assert.equal(compose.active, true);
  modes.onHandwriting({ type: 'text', text: 'stale text' });
  assert.equal(compose.getText(), 'Café');
  modes.onHandwriting({ type: 'state', phase: 'ready' });
  modes.onHandwriting({ type: 'text', text: 'Café, ciao' });
  modes.onHandwriting({ type: 'text', text: 'Café, sì' });
  modes.onHandwriting({ type: 'state', phase: 'finished' });
  assert.equal(compose.getText(), 'Café, sì');
  assert.equal(compose.active, false);
});

test('search blur stops recognition and blocks late events from editing another target', () => {
  const { actions, modes, focus } = fixture();
  const compose = draft('untouched');
  const search = draft('tour');
  focus(compose);
  const searchBlur = focusNeuralBandSearchTarget(search);
  modes.toggleHandwriting();
  modes.onHandwriting({ type: 'state', phase: 'ready' });
  modes.onHandwriting({ type: 'text', text: 'turin' });
  searchBlur();
  modes.onHandwriting({ type: 'text', text: 'late result' });
  assert.equal(search.getText(), 'turin');
  assert.equal(compose.getText(), 'untouched');
  assert.deepEqual(actions.at(-1), ['writing', false]);
});

test('Android conversations search registers only while the native editor has focus', () => {
  class EditText {}
  let focusListener, windowListener;
  function impl(callback) { return callback; }
  const observer = {
    addOnGlobalFocusChangeListener: listener => { focusListener = listener; },
    addOnWindowFocusChangeListener: listener => { windowListener = listener; },
    isAlive: () => true,
    removeOnGlobalFocusChangeListener: listener => { if (focusListener === listener) focusListener = null; },
    removeOnWindowFocusChangeListener: listener => { if (windowListener === listener) windowListener = null; },
  };
  const page = loader({
    global: { isAndroid: true },
    android: { widget: { EditText }, view: { ViewTreeObserver: {
      OnGlobalFocusChangeListener: impl,
      OnWindowFocusChangeListener: impl,
    } } },
  }, {
    '../g2/neural-band-modalities': { focusNeuralBandSearchTarget },
    './conversations-view-model': {},
  })('app/phone-ui/conversations-page.ts');
  let viewFocus = null;
  let windowFocused = true;
  const bar = { text: 'mil', android: {
    getViewTreeObserver: () => observer, findFocus: () => viewFocus, hasWindowFocus: () => windowFocused,
  } };
  page.handwritingSearchLoaded({ object: bar });
  assert.equal(focusedNeuralBandSearchTarget(), null);
  viewFocus = new EditText();
  focusListener.onGlobalFocusChanged();
  const target = focusedNeuralBandSearchTarget();
  assert.equal(target.getText(), 'mil');
  target.setText('milano');
  assert.equal(bar.text, 'milano');
  windowFocused = false;
  windowListener.onWindowFocusChanged();
  assert.equal(focusedNeuralBandSearchTarget(), null);
  page.handwritingSearchUnloaded({ object: bar });
  assert.equal(focusListener, null);
  assert.equal(windowListener, null);
});

test('another input edit is preserved if it overlaps recognition', () => {
  const { actions, modes, focus } = fixture();
  const compose = draft('draft');
  focus(compose);
  modes.toggleHandwriting();
  modes.onHandwriting({ type: 'state', phase: 'ready' });
  compose.setText('phone edit');
  modes.onHandwriting({ type: 'text', text: 'draft written' });
  assert.equal(compose.getText(), 'phone edit');
  assert.deepEqual(actions.at(-1), ['writing', false]);
});

test('a rejected mode or an unfocused field cannot change cursor or text', () => {
  const { actions, modes, focus, refusePointer, refuseHandwriting } = fixture();
  assert.equal(modes.toggleHandwriting(), false);
  assert.deepEqual(actions, []);
  refusePointer();
  assert.equal(modes.togglePointer(), false);
  focus(draft('original'));
  refuseHandwriting();
  assert.equal(modes.toggleHandwriting(), false);
  assert.deepEqual(actions, [['pointer', true], ['writing', true]]);
});
