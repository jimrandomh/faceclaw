const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture() {
  let style = 'watch';
  const changes = [], navigations = [];
  class Observable {
    notifyPropertyChange(name, value) { changes.push([name, value]); }
  }
  const { RemoteControlsViewModel } = loader({}, {
    '@nativescript/core': { Observable, Frame: { topmost: () => ({ navigate: entry => navigations.push(entry) }) } },
    '../ui/dashboard-settings': { phoneInputStyleSetting: { get: () => style } },
  })('app/phone-ui/remote-controls-view-model.ts');
  return { model: new RemoteControlsViewModel(), create: () => new RemoteControlsViewModel(), changes, navigations,
    setStyle: value => { style = value; } };
}

test('the touchpad follows the Phone input style setting and only notifies when it changes', () => {
  const h = fixture();
  assert.equal(h.model.watchPadVisibility, 'visible');
  assert.equal(h.model.ringPadVisibility, 'collapse');
  // Some other setting changed: nothing to redraw, no gesture to cancel.
  h.model.refreshInputStyle();
  assert.deepEqual(h.changes, []);
  h.setStyle('ring'); h.model.refreshInputStyle();
  assert.equal(h.model.watchPadVisibility, 'collapse');
  assert.equal(h.model.ringPadVisibility, 'visible');
  assert.deepEqual(h.changes, [['watchPadVisibility', 'collapse'], ['ringPadVisibility', 'visible']]);
  // A page built later starts on the stored style.
  assert.equal(h.create().ringPadVisibility, 'visible');
});

test('the EvenHub phone-UI button shows only with an icon and opens that app through the host', () => {
  const h = fixture(), opened = [], icon = { id: 'icon' };
  h.model.showEvenHubPhoneUi = windowId => opened.push(windowId);
  assert.equal(h.model.evenHubPhoneUiVisibility, 'collapse');
  h.model.onEvenHubPhoneUiTap();
  h.model.evenHubPhoneUi = { windowId: 'w1', title: 'Chess', icon: null };
  assert.equal(h.model.evenHubPhoneUiVisibility, 'collapse');
  h.model.onEvenHubPhoneUiTap();
  assert.deepEqual(opened, [], 'a hidden button opens nothing');

  h.changes.length = 0;
  h.model.evenHubPhoneUi = { windowId: 'w1', title: 'Chess', icon };
  assert.equal(h.model.evenHubPhoneUiVisibility, 'visible');
  assert.equal(h.model.evenHubPhoneUiIcon, icon);
  assert.equal(h.model.evenHubPhoneUiLabel, 'Open Chess on phone');
  assert.deepEqual(h.changes.map(change => change[0]), ['evenHubPhoneUiIcon', 'evenHubPhoneUiVisibility', 'evenHubPhoneUiLabel']);
  h.model.onEvenHubPhoneUiTap();
  assert.deepEqual(opened, ['w1']);

  // The host pushes a fresh object on every snapshot; an equal one is not a change.
  h.changes.length = 0;
  h.model.evenHubPhoneUi = { windowId: 'w1', title: 'Chess', icon };
  assert.deepEqual(h.changes, []);
  h.model.evenHubPhoneUi = null;
  assert.equal(h.model.evenHubPhoneUiVisibility, 'collapse');
  assert.equal(h.model.evenHubPhoneUiLabel, '');
});

test('the gear button opens the settings page', () => {
  const h = fixture();
  h.model.onSettingsTap();
  // The entry is built in the module's own realm, so compare its field.
  assert.deepEqual(h.navigations.map(entry => entry.moduleName), ['phone-ui/settings-page']);
});

test('the control bar keeps the EvenHub button leftmost and the pads bound to the input style', () => {
  const xml = require('node:fs').readFileSync(require('node:path').join(__dirname, '../app/phone-ui/remote-controls.xml'), 'utf8');
  const bar = xml.slice(xml.indexOf('class="control-bar"'), xml.indexOf('onControlsContentLayoutChanged'));
  const order = ['onEvenHubPhoneUiTap', 'onSyntheticMicTap', 'onKeyboardTap', 'onSettingsTap'].map(name => bar.indexOf(name));
  assert.ok(order.every(index => index >= 0), 'all four buttons are in the bar');
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // A leading star column takes the slack, so the app button's coming and going moves no other button.
  assert.match(xml, /columns="\*,auto,auto,auto,auto"[^>]*class="control-bar"/);
  assert.match(xml, /visibility="\{\{ watchPadVisibility \}\}"/);
  assert.match(xml, /visibility="\{\{ ringPadVisibility \}\}"/);
  assert.doesNotMatch(xml, /TabVisibility|TabClass|TabTap/);
});
