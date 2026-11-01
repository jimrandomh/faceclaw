const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function discoveryEnv(responder) {
  const requests = [];
  const load = loader({}, {
    '../util/http': {
      fetchTextWithUserAgent: async (url, init) => {
        requests.push({ url, init });
        return responder(url, init, requests.length);
      },
    },
    './sse': {},
  });
  const api = load('app/native/openai-chat-models.ts');
  api.clearCompatibleModelDiscoveryCache();
  return { api, requests };
}

const response = (body, status = 200) => ({ status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
const veniceModel = (id, name, tools, extra = {}) => ({
  id,
  model_spec: {
    name,
    capabilities: { supportsFunctionCalling: tools },
    ...extra,
  },
});

const options = {
  baseUrl: 'https://api.venice.ai/api/v1',
  apiKey: 'venice-key',
};

test('Venice discovery uses its exact API root, auth, timeout, no redirects, and capability metadata', async () => {
  const env = discoveryEnv(async () => response({ data: [
    veniceModel('chat-only', 'Chat only', false),
    veniceModel('offline-tools', 'Offline tools', true, { offline: true }),
    veniceModel('tools-model', 'Tools model', true, { betaModel: true }),
    { id: 'generic-model', name: 'Generic model' },
    veniceModel('old-model', 'Old model', true, { deprecation: { date: '2027-01-01' } }),
  ] }));
  const models = await env.api.discoverOpenAiCompatibleModels(options);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, 'https://api.venice.ai/api/v1/models');
  assert.equal(env.requests[0].init.method, 'GET');
  assert.equal(env.requests[0].init.headers.Authorization, 'Bearer venice-key');
  assert.equal(env.requests[0].init.timeoutMs, 10_000);
  assert.equal(env.requests[0].init.dontFollowRedirects, true);
  assert.equal(models.map(model => model.id).join(','), 'old-model,tools-model,generic-model,chat-only,offline-tools');
  const tools = models.find(model => model.id === 'tools-model');
  assert.equal(tools.name, 'Tools model');
  assert.equal(tools.supportsTools, true);
  assert.equal(tools.beta, true);
  assert.equal(models.find(model => model.id === 'old-model').deprecated, true);
  assert.equal(models.find(model => model.id === 'generic-model').supportsTools, null);
  assert.equal(models.find(model => model.id === 'chat-only').supportsTools, false);
  assert.equal(models.find(model => model.id === 'offline-tools').offline, true);
});

test('Open WebUI discovery uses /api/models, supports optional auth, and marks tool support unknown', async () => {
  const env = discoveryEnv(async () => response({ data: [
    { id: 'qwen-local', name: 'Qwen local' },
    { id: 'second-model' },
  ] }));
  const models = await env.api.discoverOpenAiCompatibleModels({
    baseUrl: 'http://100.64.0.1:3000/api', apiKey: '',
  });
  assert.equal(env.requests[0].url, 'http://100.64.0.1:3000/api/models');
  assert.equal('Authorization' in env.requests[0].init.headers, false);
  assert.equal(JSON.stringify(models.map(model => [model.id, model.supportsTools])), JSON.stringify([
    ['qwen-local', null], ['second-model', null],
  ]));
});

test('successful catalogs are cached briefly per endpoint and credential; refresh bypasses the cache', async () => {
  let now = 1000;
  const env = discoveryEnv(async (_url, _init, count) => response({ data: [{ id: `model-${count}` }] }));
  const deps = { now: () => now };
  const first = await env.api.discoverOpenAiCompatibleModels(options, deps);
  const cached = await env.api.discoverOpenAiCompatibleModels(options, deps);
  assert.equal(first, cached);
  assert.equal(env.requests.length, 1);

  await env.api.discoverOpenAiCompatibleModels({ ...options, apiKey: 'other-key' }, deps);
  assert.equal(env.requests.length, 2, 'a different credential cannot reuse the old response');
  await env.api.discoverOpenAiCompatibleModels({ ...options, baseUrl: 'https://other.example/api' }, deps);
  assert.equal(env.requests.length, 3, 'a different endpoint has its own catalog');
  await env.api.discoverOpenAiCompatibleModels({ ...options, forceRefresh: true }, deps);
  assert.equal(env.requests.length, 4, 'explicit refresh always fetches');

  now += 61_000;
  await env.api.discoverOpenAiCompatibleModels(options, deps);
  assert.equal(env.requests.length, 5, 'the short-lived entry expires');
});

test('invalid URLs and unsupported or malformed responses fail without querying alternate endpoints', async () => {
  const env = discoveryEnv(async (_url, _init, count) => {
    if (count === 1) return response('<html>login</html>');
    if (count === 2) return response({ models: [] });
    return response({ data: [] });
  });
  await assert.rejects(env.api.discoverOpenAiCompatibleModels({ baseUrl: 'not-a-url', apiKey: '' }), /valid compatible API URL/);
  assert.equal(env.requests.length, 0);
  await assert.rejects(env.api.discoverOpenAiCompatibleModels(options), /invalid model list/);
  await assert.rejects(env.api.discoverOpenAiCompatibleModels({ ...options, forceRefresh: true }), /did not return an OpenAI-compatible model list/);
  assert.deepEqual(env.requests.map(request => request.url), [
    'https://api.venice.ai/api/v1/models', 'https://api.venice.ai/api/v1/models',
  ]);
});

test('HTTP and reachability errors are actionable and never fall back to inference', async () => {
  const statuses = [401, 403, 404, 429, 503, 302];
  for (const status of statuses) {
    const env = discoveryEnv(async () => response({}, status));
    await assert.rejects(env.api.discoverOpenAiCompatibleModels(options), error => {
      assert.match(error.message, new RegExp(String(status)));
      return true;
    });
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].init.method, 'GET');
  }
  const unreachable = discoveryEnv(async () => { throw new Error('socket details'); });
  await assert.rejects(unreachable.api.discoverOpenAiCompatibleModels(options), /Could not reach the configured server/);
});

test('model parsing skips invalid rows, deduplicates IDs, and caps catalog size', () => {
  const env = discoveryEnv(async () => response({ data: [] }));
  const rows = [null, {}, { id: '' }, { id: 'same', name: 'First' }, { id: 'same', name: 'Duplicate' }];
  for (let index = 0; index < 510; index++) rows.push({ id: `model-${String(index).padStart(3, '0')}` });
  const parsed = env.api.parseDiscoveredCompatibleModels(rows);
  assert.equal(parsed.length, 500);
  assert.equal(parsed.filter(model => model.id === 'same').length, 1);
  assert.equal(parsed.find(model => model.id === 'same').name, 'First');
});

test('native text HTTP forwards discovery timeout and redirect protections with the app User-Agent', async () => {
  const requests = [];
  const load = loader({ global: { isAndroid: false, isIOS: true } }, {
    '../version': { USER_AGENT: 'Faceclaw/test' },
    '@nativescript/core/http': {
      request: async init => {
        requests.push(init);
        return { statusCode: 200, content: { toString: () => '{"data":[]}' } };
      },
    },
  });
  const { fetchTextWithUserAgent } = load('app/util/http.ts');
  const result = await fetchTextWithUserAgent('https://provider.example/api/models', {
    headers: { Authorization: 'Bearer secret' },
    timeoutMs: 10_000,
    dontFollowRedirects: true,
  });
  assert.equal(requests[0].timeout, 10_000);
  assert.equal(requests[0].dontFollowRedirects, true);
  assert.equal(requests[0].headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].headers['User-Agent'], 'Faceclaw/test');
  assert.equal(JSON.stringify(await result.json()), JSON.stringify({ data: [] }));
});
