const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function settingsEnv(initialUrl = '') {
  let url = initialUrl;
  let webSearch = false;
  const dummySetting = {
    id: 'setting', label: 'Setting', get: () => '', set() {}, displayValue: () => '',
  };
  const urlSetting = {
    id: 'compatible-url', label: 'Compatible API URL', get: () => url, set: value => { url = value; },
    displayValue: () => url,
  };
  const searchSetting = {
    id: 'venice-web-search', label: 'Venice web search', get: () => webSearch,
    set: value => { webSearch = value; }, toggle: () => { webSearch = !webSearch; },
    defaultValue: false, description: 'Venice-only web search.',
  };
  const row = setting => ({ label: setting.label, description: setting.description, onSelect() {} });
  const dashboardSettings = new Proxy({
    assistantOpenAiCompatibleUrlSetting: urlSetting,
    veniceWebSearchSetting: searchSetting,
    enumSettingMenuItem: row,
    textSettingMenuItem: row,
    toggleSettingMenuItem: row,
  }, {
    get(target, property) {
      return property in target ? target[property] : dummySetting;
    },
  });
  const load = loader({ global: { isIOS: false, isAndroid: true } }, {
    './remote-input-menu': { remoteInputMenuItem: () => ({ label: 'Remote input' }) },
    '@nativescript/core': { knownFolders: {} },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({}) },
    '../../graphics/logo': { getDashboardLogo: () => null },
    '../../graphics/textwrap': { wrapText: () => [] },
    '../../version': { FACECLAW_VERSION: 'test' },
    '../../native/local-llm': {
      cancelLocalModelDownload() {}, deleteLocalModel() {}, startLocalModelDownload() {},
      LOCAL_MODEL: { label: 'Qwen', sizeBytes: 1_000_000_000 },
      localModelState: () => ({ status: 'missing' }), onLocalModelStateChanged: () => () => {},
    },
    '../../native/asr-model': {
      ASR_MODELS: {
        moonshine: { label: 'Moonshine', sizeBytes: 1 },
        'whisper-base-en': { label: 'Whisper Base English', sizeBytes: 1 },
      },
      asrModelState: () => ({}), cancelAsrModelDownload() {},
      deleteAsrModel() {}, startAsrModelDownload() {}, onAsrModelStateChanged: () => () => {},
    },
    '../../apps/files/text-viewer': { TextViewerLayer: class {} },
    '../../analytics/privacy-disclosure': { IOS_PRIVACY_NOTICE: '' },
    '../menu': {
      drawRightValueMenuItem() {}, openModalMenu() {},
      submenuItem: label => ({ label, onSelect() {} }),
    },
    '../shell/shell': { shell: { noteUserActivity() {} } },
    '../dashboard-settings': dashboardSettings,
    '../../native/wear-bridge': { wearBridge: {} },
    './settings-panel': {
      SettingsPanelLayer: class { constructor(sections) { this.sections = sections; } },
      openSettingsSubMenu() {},
    },
    '../font-picker': { uiFontPickerMenuItem: () => ({ label: 'Font' }) },
    '../openai-compatible-model-picker': {
      compatibleModelDiscoveryMenuItem: () => ({ label: 'Discover models' }),
    },
    './sse': {},
  });
  const panel = load('app/ui/dashboard/settings-menus.ts').createSettingsPanelLayer();
  const section = panel.sections.find(item => item.label === 'Assistant');
  assert.ok(section);
  return {
    section,
    labels: () => section.items.map(item => item.label),
    setUrl: value => { url = value; },
    searchSetting,
  };
}

test('Venice web search row follows the current URL and never appears for other providers', () => {
  const env = settingsEnv();
  assert.equal(env.labels().includes('Venice web search'), false);
  assert.equal(env.searchSetting.defaultValue, false);
  assert.equal(env.searchSetting.get(), false);

  env.setUrl(' https://api.venice.ai/api/v1/ ');
  assert.equal(env.labels().includes('Venice web search'), true);

  env.setUrl('https://openwebui.example/api');
  assert.equal(env.labels().includes('Venice web search'), false);

  env.setUrl('https://api.venice.ai/api/v1/chat/completions');
  assert.equal(env.labels().includes('Venice web search'), true);

  env.setUrl('https://api.venice.ai.evil.example/api/v1');
  assert.equal(env.labels().includes('Venice web search'), false);

  env.setUrl('http://api.venice.ai/api/v1');
  assert.equal(env.labels().includes('Venice web search'), false);
});
