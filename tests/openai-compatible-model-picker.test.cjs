const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

class FakeMenuLayer {
  constructor(title, items, layout) {
    this.title = title;
    this.layout = layout;
    this.setItems(items);
  }
  setItems(items, selectedIndex = 0) {
    this.items = items;
    this.selectedIndex = items.length
      ? Math.max(0, Math.min(selectedIndex ?? 0, items.length - 1))
      : null;
  }
  get selectedItem() {
    return this.selectedIndex === null ? null : this.items[this.selectedIndex];
  }
}

class FakeEditTextSettingLayer {
  constructor(setting) { this.setting = setting; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function model(id, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    supportsTools: extra.supportsTools ?? null,
    offline: extra.offline ?? false,
    deprecated: extra.deprecated ?? false,
    beta: extra.beta ?? false,
  };
}

function pickerEnv({ models = [], saved = '', discover } = {}) {
  const calls = [];
  const settings = {
    baseUrl: 'https://provider.example/api/v1',
    apiKey: 'secret',
    model: saved,
    getBaseUrl() { return this.baseUrl; },
    getApiKey() { return this.apiKey; },
    getModel() { return this.model; },
    setModel(value) { this.model = value; },
  };
  const modelSetting = { id: 'compatible-model' };
  const renders = [];
  const edits = [];
  const layers = [{ id: 'settings-base' }];
  const remove = layer => layer.onRemoved?.();
  const stack = {
    getBaseSize: () => ({ width: 320, height: 240 }),
    push(layer) { layers.push(layer); },
    topMatches(predicate) { return layers.length > 1 && predicate(layers.at(-1)); },
    pop() { if (layers.length > 1) remove(layers.pop()); },
    popThrough(layer) {
      const index = layers.indexOf(layer);
      if (index <= 0) return false;
      for (const removed of layers.splice(index).reverse()) remove(removed);
      return true;
    },
  };
  const ctx = {
    stack,
    actions: {
      requestRender: () => renders.push('render'),
      startTextSettingEdit: setting => { edits.push(setting); },
    },
  };
  const load = loader({}, {
    './menu': { MenuLayer: FakeMenuLayer },
    './dashboard-settings': { EditTextSettingLayer: FakeEditTextSettingLayer },
    '../native/openai-chat-models': {},
  });
  const api = load('app/ui/openai-compatible-model-picker.ts');
  const discoverImpl = discover ?? (async options => {
    calls.push(options);
    return models;
  });
  const picker = new api.OpenAiCompatibleModelPicker(
    settings, modelSetting, discoverImpl, stack.getBaseSize(),
  );
  return {
    api, picker, settings, modelSetting, discoverImpl,
    calls, renders, edits, layers, ctx,
  };
}

function row(picker, text) {
  const found = picker.items.find(item => item.label.includes(text));
  assert.ok(found, `Missing row ${text}; got: ${picker.items.map(item => item.label).join(' | ')}`);
  return found;
}

test('catalog shows capabilities, hides offline models, and saves only an explicit selection', async () => {
  const env = pickerEnv({
    saved: 'generic-model',
    models: [
      model('tools-model', { name: 'Tools Model', supportsTools: true }),
      model('generic-model', { name: 'Generic Model' }),
      model('offline-model', { supportsTools: true, offline: true }),
    ],
  });
  env.picker.open(env.ctx);
  assert.equal(row(env.picker, 'Discovering').disabled, true);
  await flush();
  assert.equal(env.settings.model, 'generic-model');
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].baseUrl, 'https://provider.example/api/v1');
  assert.equal(env.calls[0].apiKey, 'secret');
  assert.equal(env.calls[0].forceRefresh, false);
  assert.equal(env.picker.items.some(item => item.label.includes('offline-model')), false);
  assert.match(row(env.picker, 'Tools Model').label, /\[tools\]/);
  assert.match(row(env.picker, 'Generic Model').label, /\[tools\?\]/);
  assert.ok(row(env.picker, 'Generic Model').label.endsWith(' *'));
  assert.equal(env.picker.selectedItem.label, row(env.picker, 'Generic Model').label);
  assert.equal(env.picker.layout.width, 280);
  assert.equal(env.picker.layout.maxHeight, 200);
  await row(env.picker, 'Tools Model').onSelect(env.ctx, env.picker);
  assert.equal(env.settings.model, 'tools-model');
  assert.equal(env.layers.length, 1);
});

test('refresh bypasses cache and preserves an unlisted saved model without auto-selecting', async () => {
  const env = pickerEnv({
    saved: 'keep-model',
    discover: async options => {
      env.calls.push(options);
      return [model(env.calls.length === 1 ? 'first-model' : 'second-model')];
    },
  });
  env.picker.open(env.ctx);
  await flush();
  assert.match(row(env.picker, 'keep-model').label, /saved only/);
  assert.equal(env.picker.selectedItem.label, row(env.picker, 'keep-model').label);
  await row(env.picker, 'Refresh models').onSelect(env.ctx, env.picker);
  await flush();
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1].forceRefresh, true);
  assert.equal(env.settings.model, 'keep-model');
  assert.ok(row(env.picker, 'second-model'));
  assert.ok(row(env.picker, 'keep-model'));
});

test('cancel invalidates a pending result and manual entry remains available while loading', async () => {
  const pending = deferred();
  const env = pickerEnv({
    saved: 'original-model',
    discover: options => { env.calls.push(options); return pending.promise; },
  });
  env.picker.open(env.ctx);
  await row(env.picker, 'Cancel discovery').onSelect(env.ctx, env.picker);
  assert.equal(env.layers.length, 1);
  const renderCount = env.renders.length;
  pending.resolve([model('late-model')]);
  await flush();
  assert.equal(env.settings.model, 'original-model');
  assert.equal(env.renders.length, renderCount);

  const second = deferred();
  const manual = pickerEnv({
    saved: 'original-model',
    discover: () => second.promise,
  });
  manual.picker.open(manual.ctx);
  await row(manual.picker, 'Enter model manually').onSelect(manual.ctx, manual.picker);
  assert.equal(manual.edits.length, 1);
  assert.equal(manual.edits[0], manual.modelSetting);
  assert.equal(manual.layers.length, 2);
  assert.ok(manual.layers[1] instanceof FakeEditTextSettingLayer);
  second.resolve([model('late-model')]);
  await flush();
  assert.equal(manual.settings.model, 'original-model');
  assert.ok(manual.layers[1] instanceof FakeEditTextSettingLayer);
});

test('offline models are optional but a saved offline model remains selectable', async () => {
  const env = pickerEnv({
    saved: 'saved-offline',
    models: [
      model('online-model'),
      model('saved-offline', { offline: true }),
      model('other-offline', { offline: true }),
    ],
  });
  env.picker.open(env.ctx);
  await flush();
  assert.ok(row(env.picker, 'saved-offline'));
  assert.equal(env.picker.items.some(item => item.label.includes('other-offline')), false);
  await row(env.picker, 'Show offline (2)').onSelect(env.ctx, env.picker);
  assert.ok(row(env.picker, 'other-offline'));
  assert.match(row(env.picker, 'other-offline').label, /offline/);
  await row(env.picker, 'Hide offline models').onSelect(env.ctx, env.picker);
  assert.equal(env.picker.items.some(item => item.label.includes('other-offline')), false);
  assert.equal(env.settings.model, 'saved-offline');
});

test('errors retain the saved model and Try again reloads the current endpoint', async () => {
  const first = deferred();
  const env = pickerEnv({
    saved: 'original-model',
    discover: options => {
      env.calls.push(options);
      if (env.calls.length === 1) return first.promise;
      return Promise.resolve([model('new-endpoint-model')]);
    },
  });
  env.picker.open(env.ctx);
  env.settings.baseUrl = 'https://other.example/api';
  first.resolve([model('old-endpoint-model')]);
  await flush();
  assert.match(row(env.picker, 'Failed:').description, /URL or key changed/);
  assert.equal(env.picker.items.some(item => item.label.includes('old-endpoint-model')), false);
  assert.equal(env.settings.model, 'original-model');
  await row(env.picker, 'Try again').onSelect(env.ctx, env.picker);
  await flush();
  assert.equal(env.calls[1].baseUrl, 'https://other.example/api');
  assert.equal(env.calls[1].forceRefresh, true);
  assert.ok(row(env.picker, 'new-endpoint-model'));
  assert.equal(env.settings.model, 'original-model');
});

test('a stale catalog cannot be selected after the endpoint changes', async () => {
  const env = pickerEnv({ models: [model('old-endpoint-model')] });
  env.picker.open(env.ctx);
  await flush();
  const staleRow = row(env.picker, 'old-endpoint-model');
  env.settings.baseUrl = 'https://other.example/api';
  await staleRow.onSelect(env.ctx, env.picker);
  assert.equal(env.settings.model, '');
  assert.equal(env.layers.length, 2);
});

test('empty catalogs retain recovery actions and settings row requires a URL', async () => {
  const env = pickerEnv({ saved: 'keep-model', models: [] });
  env.picker.open(env.ctx);
  await flush();
  assert.ok(row(env.picker, 'No models listed'));
  assert.ok(row(env.picker, 'Refresh models'));
  assert.ok(row(env.picker, 'Enter model manually'));
  env.ctx.stack.pop();

  const item = env.api.compatibleModelDiscoveryMenuItem(
    env.settings, env.modelSetting, async () => [],
  );
  env.settings.baseUrl = '';
  assert.equal(item.disabled(), true);
  env.settings.baseUrl = 'https://provider.example/api/v1';
  assert.equal(item.disabled(), false);
  item.onSelect(env.ctx);
  assert.equal(env.layers.length, 2);
  assert.equal(env.layers[1].layout.width, 280);
  env.layers[1].onRemoved();
});

test('a temporary overlay does not invalidate a pending result while the picker remains open', async () => {
  const pending = deferred();
  const env = pickerEnv({ discover: () => pending.promise });
  env.picker.open(env.ctx);
  env.layers.push({ id: 'temporary-overlay' });
  pending.resolve([model('available-model')]);
  await flush();
  assert.equal(env.picker.items.some(item => item.label.includes('available-model')), true);
  assert.equal(env.layers.length, 3);
  assert.ok(env.renders.length > 0);
});

test('a discovery error is visible in the modal row and retains manual recovery', async () => {
  const env = pickerEnv({
    discover: async () => { throw new Error('Model discovery is not supported at this URL (HTTP 404)'); },
  });
  env.picker.open(env.ctx);
  await flush();
  assert.match(row(env.picker, 'Failed:').label, /404/);
  assert.match(row(env.picker, 'Failed:').description, /Manual model entry/);
  assert.ok(row(env.picker, 'Try again'));
  assert.ok(row(env.picker, 'Enter model manually'));
  env.ctx.stack.pop();
});

test('long labels stay bounded while descriptions retain the exact model ID', async () => {
  const longId = `provider/${'x'.repeat(90)}-model`;
  const longName = `A very long model name ${'y'.repeat(70)}`;
  const env = pickerEnv({
    models: [model(longId, { name: longName, supportsTools: true })],
  });
  env.picker.open(env.ctx);
  await flush();
  const longRow = row(env.picker, '[tools]');
  assert.ok(longRow.label.length <= 54);
  assert.ok(longRow.description.includes(longId));
});