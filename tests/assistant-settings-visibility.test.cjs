const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function settingsEnv(initialUrl = '', initialModel = 'openai-compatible', glassesType = 'g2', { ios = false } = {}) {
  let url = initialUrl;
  let model = initialModel;
  let webSearch = false;
  let voiceProvider = 'onboard';
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
    assistantBackendSetting: { ...dummySetting, id: 'assistant-backend', label: 'Assistant backend' },
    assistantBridgeHostSetting: { ...dummySetting, id: 'assistant-bridge-host', label: 'Bridge host' },
    assistantBridgePortSetting: { ...dummySetting, id: 'assistant-bridge-port', label: 'Bridge port' },
    assistantBridgeTokenSetting: { ...dummySetting, id: 'assistant-bridge-token', label: 'Bridge token' },
    assistantAllowProactiveSetting: { ...dummySetting, id: 'assistant-allow-proactive', label: 'Allow proactive agent actions' },
    voiceProviderSetting: { ...dummySetting, id: 'voice-provider', label: 'Transcription Provider', get: () => voiceProvider },
    whisperServerUrlSetting: { ...dummySetting, id: 'whisper-server-url', label: 'Whisper server URL' },
    whisperServerModelSetting: { ...dummySetting, id: 'whisper-server-model', label: 'Whisper server model' },
    whisperServerLanguageSetting: { ...dummySetting, id: 'whisper-server-language', label: 'Whisper language' },
    whisperServerApiKeySetting: { ...dummySetting, id: 'whisper-server-api-key', label: 'Whisper server key' },
    glassesTypeSetting: { ...dummySetting, id: 'glasses-type', get: () => (typeof glassesType === 'function' ? glassesType() : glassesType) },
    enumSettingMenuItem: row,
    textSettingMenuItem: row,
    toggleSettingMenuItem: row,
  }, {
    get(target, property) {
      return property in target ? target[property] : dummySetting;
    },
  });
  const load = loader({ global: { isIOS: ios, isAndroid: !ios } }, {
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
    '../keyboard-settings': { keyboardSettingsMenuItem: () => ({ label: 'Bluetooth keyboard' }) },
    '../keybinding-settings': { keybindingsMenuItem: () => ({ label: 'Keybindings' }) },
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
    sections: panel.sections,
    labels: () => section.items.map(item => item.label),
    voice: panel.sections.find(item => item.label === 'Voice'),
    setVoiceProvider: value => { voiceProvider = value; },
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

test('the Keyboard section, with its pairing row, follows the glasses type while Settings stays open', () => {
  let glassesType = 'g1';
  const sections = settingsEnv('', 'openai-compatible', () => glassesType).sections;
  const labels = sections.map(section => section.label);
  // Always in the list, between the other input devices and the developer
  // options; whether it shows is asked again on every paint.
  assert.equal(labels.indexOf('Keyboard'), labels.indexOf('Watch') + 1);
  const keyboard = sections.find(section => section.label === 'Keyboard');
  assert.equal(keyboard.items.map(item => item.label).join(), 'Bluetooth keyboard,Keybindings');
  assert.equal(keyboard.hidden(), true);
  glassesType = 'rayneo-io';
  assert.equal(keyboard.hidden(), true);
  glassesType = 'g2';
  assert.equal(keyboard.hidden(), false);
  // Nothing else is conditional this way.
  assert.equal(sections.filter(section => section.hidden).length, 1);
});

test('Whisper server rows appear only while Whisper server is the selected transcription provider', () => {
  for (const ios of [false, true]) {
    const env = settingsEnv('', 'auto', 'g2', { ios });
    const labels = () => env.voice.items.map(item => item.label);
    const whisperRows = () => JSON.stringify(labels().filter(label => label.startsWith('Whisper')));
    assert.equal(whisperRows(), '[]');
    const unselected = env.voice.items;
    assert.equal(env.voice.items, unselected, 'the same list between paints while nothing changes');
    for (const provider of ['elevenlabs', 'whisper', 'onboard-whisper']) {
      env.setVoiceProvider(provider);
      assert.equal(whisperRows(), '[]', provider);
    }
    env.setVoiceProvider('whisper-server');
    assert.equal(whisperRows(), JSON.stringify(['Whisper server URL', 'Whisper server model', 'Whisper language', 'Whisper server key']));
    assert.equal(labels().indexOf('Whisper server URL'), labels().indexOf('Transcription Provider') + 1, 'the rows follow the provider row');
    // Android's downloadable on-device models stay listed either way; iOS has none.
    assert.equal(labels().filter(label => label.startsWith('On-device model')).length, ios ? 0 : 2);
    env.setVoiceProvider('soniox');
    assert.equal(env.voice.items, unselected);
  }
});

test('the agent bridge is offered on both platforms', () => {
  const bridgeRows = ['Bridge host', 'Bridge port', 'Bridge token', 'Allow proactive agent actions'];
  for (const ios of [false, true]) {
    const labels = settingsEnv('', 'auto', 'g2', { ios }).labels();
    assert.equal(labels[0], 'Assistant backend');
    assert.equal(JSON.stringify(labels.filter(label => bridgeRows.includes(label))), JSON.stringify(bridgeRows), ios ? 'iOS' : 'Android');
  }
});
