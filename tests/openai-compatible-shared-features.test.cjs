const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function sharedEnv() {
  const compatible = [], unexpected = [];
  const localLlm = {
    streamLocalModel: () => unexpected.push('local'),
    isLocalModelReady: () => false,
    isLocalModelSupported: () => true,
    LOCAL_MODEL: { id: 'qwen', label: 'Qwen' },
  };
  const settings = {
    anthropicApiKeySetting: { get: () => '' },
    assistantModelSetting: { get: () => 'openai-compatible' },
    assistantOpenAiCompatibleUrlSetting: { get: () => 'https://provider.example/api/v1' },
    assistantOpenAiCompatibleKeySetting: { get: () => 'compatible-key' },
    assistantOpenAiCompatibleModelSetting: { get: () => 'compatible-model' },
    openAiApiKeySetting: { get: () => '' },
  };
  const fail = provider => () => { unexpected.push(provider); };
  const load = loader({ global: { isIOS: false, isAndroid: true } }, {
    '../../native/anthropic': { streamAnthropicMessage: fail('anthropic') },
    '../../native/openai': { streamOpenAiResponse: fail('openai') },
    '../../native/local-llm': localLlm,
    '../native/local-llm': localLlm,
    '../../native/openai-chat': {
      streamOpenAiCompatibleChat: options => {
        compatible.push(options);
        return { cancel() {} };
      },
    },
    '../../ui/dashboard-settings': settings,
    '../../prompts': {
      CALCULATOR_REWRITE_SYSTEM_PROMPT: 'calculator system',
      buildCalculatorRewriteUserMessage: spoken => `rewrite: ${spoken}`,
      TRANSLATE_SYSTEM_PROMPT: 'translate system',
      buildTranslateUserMessage: speech => `translate: ${speech}`,
    },
  });
  return { load, compatible, unexpected };
}

test('Calculator uses the configured compatible provider and preserves its small output cap', async () => {
  const env = sharedEnv();
  const { rewriteSpokenProblem } = env.load('app/apps/calculator/calculator-llm.ts');
  const result = rewriteSpokenProblem('one plus one');
  assert.equal(env.compatible.length, 1);
  assert.deepEqual(env.unexpected, []);
  const options = env.compatible[0];
  assert.equal(options.baseUrl, 'https://provider.example/api/v1');
  assert.equal(options.apiKey, 'compatible-key');
  assert.equal(options.model, 'compatible-model');
  assert.equal(options.maxTokens, 200);
  assert.equal(options.messages[0].content, 'rewrite: one plus one');
  options.onDone({ text: '1 + 1', content: [], stopReason: 'end_turn' });
  assert.equal(await result, '1 + 1');
});

test('Translate resolves and streams through the compatible provider without changing its cancellation contract', () => {
  const env = sharedEnv();
  const { resolveTranslationModel, streamTranslation } = env.load('app/apps/translate/translate-llm.ts');
  const model = resolveTranslationModel();
  assert.equal(model.provider, 'openai-compatible');
  assert.equal(model.baseUrl, 'https://provider.example/api/v1');
  const progress = [], answers = [], errors = [];
  const handle = streamTranslation(model, {
    speech: 'Hola', context: [], language: 'Spanish',
    onProgress: text => progress.push(text),
    onDone: text => answers.push(text),
    onError: error => errors.push(error),
  });
  assert.equal(typeof handle.cancel, 'function');
  assert.equal(env.compatible.length, 1);
  assert.deepEqual(env.unexpected, []);
  const options = env.compatible[0];
  assert.equal(options.baseUrl, 'https://provider.example/api/v1');
  assert.equal(options.model, 'compatible-model');
  assert.equal(options.maxTokens, 1024);
  assert.equal(options.messages[0].content, 'translate: Hola');
  options.onTextDelta('Hello', '<english>Hello</english>');
  options.onDone({ text: '<english>Hello</english>', content: [], stopReason: 'end_turn' });
  assert.deepEqual(progress, ['Hello']);
  assert.deepEqual(answers, ['Hello']);
  assert.deepEqual(errors, []);
});
