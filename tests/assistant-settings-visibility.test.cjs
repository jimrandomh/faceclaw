const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function settingsEnv(initialUrl = '', initialModel = 'openai-compatible') {
  let url = initialUrl;
  let model = initialModel;
  let webSearch = false;
  const dummySetting = {
    id: 'setting', label: 'Setting', get: () => '', set() {}, displayValue: () => '',
  };
  const urlSetting = {
    id: 'compatible-url', label: 'Compatible API URL', get: () => url, set: value => { url = value; },
    displayValue: () => url,
  };
  const modelSetting = {
    id: 'assistant-model', label: 'Assistant model', get: () => model, set: value => { model = value; },
    displayValue: () => model,
  };
  const searchSetting = {
    id: 'venice-web-search', label: 'Venice web search', get: () => webSearch,
    set: value => { webSearch = value; }, toggle: () => { webSearch = !webSearch; },
    defaultValue: false, description: 'Venice-only web search.',
  };
  const row = setting => ({ label: setting.label, description: setting.description, onSelect() {} });
  const dashboardSettings = new Proxy({
    assistantModelSetting: modelSetting,
    assistantOpenAiCompatibleUrlSetting: urlSetting,
    assistantOpenAiCompatibleKeySetting: { ...dummySetting, id: 'compatible-key', label: 'Compatible API key' },
    assistantOpenAiCompatibleModelSetting: { ...dummySetting, id: 'compatible-model', label: 'Compatible model ID' },
    assistantHermesUrlSetting: { ...dummySetting, id: 'assistant-hermes-url', label: 'Hermes URL' },
    assistantHermesKeySetting: { ...dummySetting, id: 'assistant-hermes-key', label: 'Hermes key' },
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
    '../notification-filter': { NotificationFilterLayer: class {} },
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
    setModel: value => { model = value; },
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

test('Venice web search row also requires the OpenAI-compatible model to be selected', () => {
  const env = settingsEnv('https://api.venice.ai/api/v1', 'sonnet');
  assert.equal(env.labels().includes('Venice web search'), false);
  env.setModel('hermes');
  assert.equal(env.labels().includes('Venice web search'), false);
  env.setModel('openai-compatible');
  assert.equal(env.labels().includes('Venice web search'), true);
});

test('Hermes URL and key rows appear only while Hermes agent is the selected model', () => {
  const env = settingsEnv('', 'auto');
  // Labels come from the module's VM realm; compare by value.
  const hermesRows = () => JSON.stringify(env.labels().filter(label => label.startsWith('Hermes')));
  assert.equal(hermesRows(), '[]');
  env.setModel('openai-compatible');
  assert.equal(hermesRows(), '[]');
  env.setModel('hermes');
  assert.equal(hermesRows(), JSON.stringify(['Hermes URL', 'Hermes key']));
  const labels = env.labels();
  assert.equal(labels.indexOf('Hermes URL'), labels.indexOf('Assistant model') + 1, 'Hermes rows follow the model row');
});

test('OpenAI-compatible rows appear only while OpenAI-compatible is the selected model', () => {
  const env = settingsEnv('https://api.venice.ai/api/v1', 'auto');
  const compatibleRows = () => JSON.stringify(env.labels().filter(label =>
    label.startsWith('Compatible') || label === 'Discover models' || label === 'Venice web search'));
  assert.equal(compatibleRows(), '[]');
  env.setModel('hermes');
  assert.equal(compatibleRows(), '[]');
  env.setModel('openai-compatible');
  assert.equal(compatibleRows(), JSON.stringify([
    'Compatible API URL', 'Compatible API key', 'Discover models', 'Compatible model ID', 'Venice web search',
  ]));
  const labels = env.labels();
  assert.equal(labels.indexOf('Compatible API URL'), labels.indexOf('Assistant model') + 1, 'compatible rows follow the model row');
});
