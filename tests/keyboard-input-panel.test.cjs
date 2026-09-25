const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
function fixture() {
  class Observable { get(key) { return this[key]; } notifyPropertyChange() {} }
  const { KeyboardInputViewModel } = loader({}, { '@nativescript/core': { Observable } })('app/phone-ui/keyboard-input-view-model.ts');
  const model = new KeyboardInputViewModel(), sent = [], text = [];
  const session = { targets: [{ id: 'assistant', label: 'Send to Assistant' }, { id: 'app', label: 'Type Into App' }],
    setText: value => text.push(value), sendTo: id => sent.push(id), discard: () => model.setSession(null) };
  model.setSession(session);
  return { model, session, sent, text };
}
test('multiline keyboard editor routes Agent and App buttons to distinct shell destinations', () => {
  const h = fixture();
  assert.equal(h.model.keyboardInputPrimaryTargetLabel, 'Send to Agent');
  assert.equal(h.model.keyboardInputSecondaryTargetLabel, 'Type into App');
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
  assert.equal(h.model.keyboardInputPrimaryTargetLabel, 'Send to Agent');
  assert.equal(h.model.keyboardInputSecondaryTargetVisibility, 'collapse');
  h.model.onKeyboardInputSecondarySendTap(); assert.deepEqual(h.sent, []);
});
