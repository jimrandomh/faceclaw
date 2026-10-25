const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
function fixture({ choose } = {}) {
  class Observable { get(key) { return this[key]; } notifyPropertyChange() {} }
  const dialogs = [];
  const Dialogs = { action: async options => { dialogs.push(options); return choose ? choose(options.actions) : options.cancelButtonText; } };
  const { KeyboardInputViewModel } = loader({ setTimeout: callback => callback() },
    { '@nativescript/core': { Observable, Dialogs } })('app/phone-ui/keyboard-input-view-model.ts');
  const model = new KeyboardInputViewModel(), sent = [], text = [], visibilities = [];
  const session = { targets: [{ id: 'assistant', label: 'Send to Assistant' }, { id: 'app', label: 'Type Into App' }],
    setText: value => text.push(value), sendTo: id => sent.push(id), discard: () => model.setSession(null),
    visibility: 'both', setVisibility(value) { visibilities.push(value); this.visibility = value; },
    history: [] };
  model.setSession(session);
  const field = { text: '', focused: 0, selection: null, focus() { this.focused++; }, setSelection(start) { this.selection = start; } };
  const button = { page: { getViewById: id => id === 'keyboardInputField' ? field : undefined } };
  return { model, session, sent, text, visibilities, dialogs, field, button };
}
test('multiline keyboard editor routes Assistant and App buttons to distinct shell destinations', () => {
  const h = fixture();
  assert.equal(h.model.keyboardInputPrimaryTargetLabel, 'To Assistant');
  assert.equal(h.model.keyboardInputSecondaryTargetLabel, 'To App');
  h.model.onKeyboardInputTextChange({ object: { text: 'First line\nSecond line' } });
  h.model.onKeyboardInputPrimarySendTap();
  h.model.onKeyboardInputSecondarySendTap();
  assert.deepEqual(h.sent, ['assistant', 'app']);
  assert.equal(h.text.at(-1), 'First line\nSecond line');
});
test('discard and shell-side closure reset the editor; unsupported destinations stay hidden', () => {
  const h = fixture();
  h.model.keyboardInputText = 'draft'; h.model.onKeyboardInputDiscardTap();
  assert.equal(h.model.keyboardInputText, '');
  assert.equal(h.model.keyboardInputVisibility, 'collapse');
  h.model.setSession({ ...h.session, targets: [{ id: 'assistant', label: 'Send' }] });
  assert.equal(h.model.keyboardInputPrimaryTargetLabel, 'Send');
  assert.equal(h.model.keyboardInputSecondaryTargetVisibility, 'collapse');
  h.model.onKeyboardInputSecondarySendTap(); assert.deepEqual(h.sent, []);
});
test('visibility button cycles both, phone only, glasses only; glasses-only hides the field but keeps it', () => {
  const h = fixture();
  const state = () => [h.model.keyboardInputPhoneIconOpacity, h.model.keyboardInputGlassesIconOpacity,
    h.model.keyboardInputFieldClass, h.model.keyboardInputGlassesOnlyVisibility];
  assert.deepEqual(state(), [1, 1, '', 'collapse']);
  h.model.onKeyboardInputVisibilityTap();
  assert.deepEqual(state(), [1, 0.3, '', 'collapse']);
  h.model.onKeyboardInputVisibilityTap();
  assert.deepEqual(state(), [0.3, 1, 'keyboard-input-field-hidden', 'visible']);
  h.model.onKeyboardInputGlassesOnlyHintTap({ object: h.button });
  assert.equal(h.field.focused, 1);
  h.model.onKeyboardInputVisibilityTap();
  assert.deepEqual(h.visibilities, ['phone', 'glasses', 'both']);
  assert.equal(h.model.keyboardInputVisibilityDescription, 'Shown on phone and glasses');
});
test('history button lists recent inputs on one line each and puts the pick in the field', async () => {
  const long = 'x'.repeat(100);
  const h = fixture({ choose: actions => actions[1] });
  assert.equal(h.model.keyboardInputHistoryOpacity, 0.3);
  await h.model.onKeyboardInputHistoryTap({ object: h.button });
  assert.equal(h.dialogs.length, 0);
  h.session.history = ['first line\n  second', long];
  h.model.setSession(null); h.model.setSession(h.session);
  assert.equal(h.model.keyboardInputHistoryOpacity, 1);
  await h.model.onKeyboardInputHistoryTap({ object: h.button });
  assert.deepEqual([...h.dialogs[0].actions], ['first line second', `${'x'.repeat(79)}…`]);
  assert.equal(h.model.keyboardInputText, long);
  assert.equal(h.text.at(-1), long);
  assert.equal(h.field.text, long);
  assert.equal(h.field.selection, 100);
});

function layerFixture(visibility = 'both', history = []) {
  const menu = { items: [], setItems(items) { this.items = items; }, get selectedItem() { return this.items[0]; } };
  const { KeyboardInputLayer } = loader({}, {
    './input-dialog': { createInputDialogMenu: () => menu, paintInputDialog() {} },
  })('app/ui/shell/keyboard-input.ts');
  const stack = new Set(), events = [];
  const layer = new KeyboardInputLayer({
    actions: { requestRender() {} },
    onClosed: () => events.push('closed'),
    dismiss: () => { if (stack.delete(layer)) layer.onRemoved(); },
    setShownOnGlasses: shown => { if (shown) stack.add(layer); else if (stack.delete(layer)) layer.onRemoved(); },
    visibility, onVisibilityChanged: value => events.push(`visibility:${value}`), history,
    sendTargets: [{ id: 'app', label: 'Type Into App', onSend: text => events.push(`sent:${text}`) }],
  });
  if (layer.shownOnGlasses) stack.add(layer);
  // The shell's sleep path: the stack is cleared and each layer told.
  const clearStack = () => { for (const removed of [...stack]) { stack.delete(removed); removed.onRemoved(); } };
  return { layer, stack, events, history, clearStack };
}
test('phone-only takes the dialog off the glasses without ending the session', () => {
  const f = layerFixture();
  f.layer.setVisibility('phone');
  assert.equal(f.stack.size, 0);
  assert.deepEqual(f.events, ['visibility:phone']);
  f.clearStack();
  f.layer.setText('typed while hidden'); f.layer.sendTo('app');
  assert.deepEqual(f.events, ['visibility:phone', 'closed', 'sent:typed while hidden']);
  f.layer.setVisibility('both');
  assert.equal(f.stack.size, 0);
});
test('shown again on the glasses, the dialog closes with the stack as before', () => {
  const f = layerFixture('phone');
  assert.equal(f.stack.size, 0);
  f.layer.setVisibility('glasses');
  assert.equal(f.stack.size, 1);
  f.layer.setVisibility('both');
  assert.deepEqual(f.events, ['visibility:glasses', 'visibility:both']);
  f.clearStack();
  assert.deepEqual(f.events.at(-1), 'closed');
  const discarded = layerFixture('phone');
  discarded.layer.discard();
  assert.deepEqual(discarded.events, ['closed']);
});
test('sent messages go into the shared history newest first, without duplicates or blanks', () => {
  const history = [];
  for (const text of ['one', '  ', 'two', 'one ']) {
    const f = layerFixture('both', history);
    f.layer.setText(text); f.layer.sendTo('app');
  }
  assert.deepEqual(history, ['one', 'two']);
  for (let i = 0; i < 25; i++) {
    const f = layerFixture('phone', history);
    f.layer.setText(`message ${i}`); f.layer.sendTo('app');
  }
  assert.equal(history.length, 20);
  assert.equal(history[0], 'message 24');
});
