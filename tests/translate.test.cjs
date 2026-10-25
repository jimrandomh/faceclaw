const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const { TranslationModel } = loader()('app/apps/translate/translation-model.ts');
const { buildTranslateUserMessage } = loader()('app/prompts.ts');

// One character per pixel, so wrapping is predictable.
const measure = text => text.length;
// Values built inside the loader's sandbox have its prototypes; compare as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

function settingsHarness({ main = 'onboard', setUp = [] } = {}) {
  class Setting {
    constructor(options) { Object.assign(this, options); this.value = options.defaultValue; }
    get() { return this.value; }
    set(value) { this.value = value; return value; }
    displayValue(value = this.get()) { return this.formatValue ? this.formatValue(value) : String(value); }
  }
  const labels = { elevenlabs: 'ElevenLabs', whisper: 'OpenAI (Whisper)', soniox: 'Soniox', 'whisper-server': 'Whisper server' };
  const available = new Set(setUp);
  return loader({}, {
    '../../ui/dashboard-settings': {
      ConfigSettingEnum: Setting,
      ConfigSettingBoolean: Setting,
      voiceProviderSetting: {
        get: () => main,
        isDisabled: provider => !available.has(provider),
        displayValue: provider => labels[provider] ?? provider,
      },
    },
  })('app/apps/translate/translate-settings.ts');
}

test('finals translate in order; finals arriving mid-request merge into one waiting block', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Hola, ¿qué', isFinal: false });
  model.accept({ text: 'Hola, ¿qué tal?', isFinal: true });
  assert.equal(model.segments.length, 1);
  const first = model.nextJob();
  assert.equal(first.source, 'Hola, ¿qué tal?');
  assert.deepEqual(plain(first.context), []);
  assert.equal(model.nextJob(), null, 'one request at a time');

  model.accept({ text: 'Muy bien.', isFinal: true });
  model.accept({ text: '', isFinal: true }); // an empty final with no partial adds nothing
  model.accept({ text: 'Gracias.', isFinal: true });
  assert.equal(model.segments.length, 2);
  assert.equal(model.segments[1].source, 'Muy bien. Gracias.');

  assert.equal(model.progress(first, 'Hi, how'), true);
  assert.equal(first.segment.streaming, 'Hi, how');
  model.complete(first, 'Hi, how are you?');
  const second = model.nextJob();
  assert.equal(second.source, 'Muy bien. Gracias.');
  assert.deepEqual(plain(second.context), [{ source: 'Hola, ¿qué tal?', translation: 'Hi, how are you?' }]);
  model.complete(second, 'Very well. Thanks.');
  assert.equal(model.nextJob(), null);
});

test('the live block is translated provisionally, redone as it grows, and settles on a matching final', () => {
  const model = new TranslationModel();
  model.accept({ text: '今日は', isFinal: false });
  const first = model.nextJob();
  assert.equal(first.source, '今日は');
  model.accept({ text: '今日はいい天気', isFinal: false }); // grows while the request is in flight
  assert.equal(model.nextJob(), null);
  model.complete(first, 'Today');
  assert.deepEqual(plain(model.lines(measure, 100, false)), [{ text: 'Today', gray: 170 }]);

  const second = model.nextJob();
  assert.equal(second.source, '今日はいい天気');
  // The redo streams over the old text only once it is as long.
  model.progress(second, 'To');
  assert.deepEqual(plain(model.lines(measure, 100, false).map(line => line.text)), ['Today']);
  model.progress(second, 'The weather');
  assert.deepEqual(plain(model.lines(measure, 100, false).map(line => line.text)), ['The weather']);
  model.complete(second, 'The weather is nice today');

  // A final matching what was translated needs no further request.
  model.accept({ text: '今日はいい天気', isFinal: true });
  assert.equal(model.nextJob(), null);
  assert.deepEqual(plain(model.lines(measure, 100, false)), [{ text: 'The weather is nice today', gray: 230 }]);
});

test('a final that differs from the request in flight makes it moot; a matching one keeps it', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Bonjour', isFinal: false });
  const stale = model.nextJob();
  assert.equal(model.accept({ text: 'Bonjour à tous', isFinal: true }), true);
  assert.equal(model.isActive(stale), false);
  assert.equal(model.progress(stale, 'Hello'), false);
  const redo = model.nextJob();
  assert.equal(redo.source, 'Bonjour à tous');
  model.complete(stale, 'Hello'); // a late reply from the cancelled request is ignored
  assert.equal(model.isActive(redo), true);
  model.complete(redo, 'Hello everyone');

  model.accept({ text: 'Merci', isFinal: false });
  const kept = model.nextJob();
  assert.equal(model.accept({ text: 'Merci', isFinal: true }), false);
  model.complete(kept, 'Thank you');
  assert.equal(model.nextJob(), null);
  assert.deepEqual(plain(model.lines(measure, 100, false).map(line => line.gray)), [230, 230]);
});

test('small revisions of a live block wait for a bigger change; its final is always redone', () => {
  const model = new TranslationModel();
  model.accept({ text: 'abcdef', isFinal: false });
  model.complete(model.nextJob(), 'one');
  model.accept({ text: 'abcdeg', isFinal: false });
  assert.equal(model.nextJob(), null);
  model.accept({ text: 'abcdefgh', isFinal: false });
  assert.equal(model.nextJob(), null);
  model.accept({ text: 'abcdefghi', isFinal: false });
  model.complete(model.nextJob(), 'two');
  model.accept({ text: 'abcdefghj', isFinal: true });
  assert.equal(model.nextJob().source, 'abcdefghj');
});

test('an empty final keeps the live partial it replaces', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Bonjour', isFinal: false });
  model.accept({ text: '', isFinal: true });
  assert.equal(model.segments[0].source, 'Bonjour');
  assert.equal(model.segments[0].final, true);
});

test('context skips failed, dropped and provisional turns and stays bounded', () => {
  const model = new TranslationModel();
  const translate = (source, translation) => {
    model.accept({ text: source, isFinal: true });
    const job = model.nextJob();
    if (translation === null) model.fail(job);
    else model.complete(job, translation);
  };
  translate('uno', 'one');
  translate('ruido', null);
  translate('mmm', '');
  for (let i = 0; i < 6; i++) translate(`frase ${i}`, `sentence ${i}`);
  model.accept({ text: 'último', isFinal: true });
  const { context } = model.nextJob();
  assert.equal(context.length, 4);
  assert.deepEqual(plain(context.at(-1)), { source: 'frase 5', translation: 'sentence 5' });
  assert.ok(context.every(turn => turn.translation));

  const long = new TranslationModel();
  for (let i = 0; i < 3; i++) {
    long.accept({ text: 'x'.repeat(500), isFinal: true });
    long.complete(long.nextJob(), 'y'.repeat(500));
  }
  long.accept({ text: 'next', isFinal: true });
  assert.equal(long.nextJob().context.length, 1, 'the newest turn is kept even when it alone is over the cap');

  // A final whose redo failed still shows its provisional translation, but
  // that translates other text, so it isn't context.
  const stale = new TranslationModel();
  stale.accept({ text: 'Ich gehe', isFinal: false });
  stale.complete(stale.nextJob(), 'I go');
  stale.accept({ text: 'Ich gehe nach Hause', isFinal: true });
  stale.fail(stale.nextJob());
  assert.deepEqual(plain(stale.lines(measure, 100, false)), [{ text: 'I go', gray: 170 }]);
  stale.accept({ text: 'Tschüss', isFinal: true });
  assert.deepEqual(plain(stale.nextJob().context), []);
});

test('display lines: settled bright, provisional dimmer, originals dim until translated or when shown', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Guten Morgen', isFinal: true });
  model.complete(model.nextJob(), 'Good morning');
  model.accept({ text: 'Wie geht es?', isFinal: true });
  const asking = model.nextJob();
  model.accept({ text: 'Danke', isFinal: false });
  assert.deepEqual(plain(model.lines(measure, 100, false)), [
    { text: 'Good morning', gray: 230 },
    { text: 'Wie geht es?', gray: 120 },
    { text: 'Danke', gray: 90 },
  ]);
  model.progress(asking, 'How are');
  assert.deepEqual(plain(model.lines(measure, 100, false).map(line => line.text)), ['Good morning', 'How are', 'Danke']);
  assert.deepEqual(plain(model.lines(measure, 100, true).map(line => line.gray)), [120, 230, 120, 170, 90]);
  assert.deepEqual(plain(model.lines(measure, 7, false).slice(0, 2)), [{ text: 'Good', gray: 230 }, { text: 'morning', gray: 230 }]);

  // A failed block keeps its original on screen.
  model.fail(asking);
  assert.deepEqual(plain(model.lines(measure, 100, false)[1]), { text: 'Wie geht es?', gray: 120 });

  // A settled, empty translation is noise: hidden unless originals are shown.
  model.accept({ text: 'mmm', isFinal: true });
  model.complete(model.nextJob(), '');
  assert.equal(model.lines(measure, 100, false).some(line => line.text === 'mmm'), false);
  assert.equal(model.lines(measure, 100, true).some(line => line.text === 'mmm'), true);
});

test('saved text pairs each final original with its translation', () => {
  const model = new TranslationModel();
  for (const [source, translation] of [['Ciao', 'Hello'], ['Okay.', 'Okay.'], ['boh', null]]) {
    model.accept({ text: source, isFinal: true });
    const job = model.nextJob();
    if (translation === null) model.fail(job);
    else model.complete(job, translation);
  }
  model.accept({ text: 'ancora', isFinal: false }); // still live: not saved
  assert.equal(model.savedText(), 'Ciao\n→ Hello\n\nOkay.\n\nboh\n→ (not translated)');
});

test('the user message carries earlier turns as context, then the speech', () => {
  assert.equal(buildTranslateUserMessage('Hola', []), 'Translate this speech into English:\n<speech>Hola</speech>');
  const message = buildTranslateUserMessage('¿Y tú?', [{ source: 'Bien', translation: 'Fine' }]);
  assert.match(message, /context only/);
  assert.match(message, /<speech>Bien<\/speech>\n<english>Fine<\/english>\n\nTranslate this speech/);
  assert.ok(message.endsWith('<speech>¿Y tú?</speech>'));
  assert.equal(buildTranslateUserMessage('こんにちは', [], 'Japanese'),
    'Translate this Japanese speech into English:\n<speech>こんにちは</speech>');
});

test('Auto picks the main provider when it is multilingual, else the first one set up', () => {
  let settings = settingsHarness({ main: 'soniox', setUp: ['elevenlabs', 'soniox'] });
  assert.equal(settings.resolveTranslateProvider(), 'soniox');
  assert.equal(settings.translateProviderSetting.displayValue('auto'), 'Auto (Soniox)');

  settings = settingsHarness({ main: 'onboard', setUp: ['soniox', 'whisper'] });
  assert.equal(settings.resolveTranslateProvider(), 'whisper');
  // The main provider counts only when it is set up.
  settings = settingsHarness({ main: 'elevenlabs', setUp: ['soniox'] });
  assert.equal(settings.resolveTranslateProvider(), 'soniox');

  settings = settingsHarness({ main: 'onboard', setUp: [] });
  assert.equal(settings.resolveTranslateProvider(), null);
  assert.equal(settings.translateProviderSetting.displayValue('auto'), 'Auto (none set up)');
});

test('an explicit provider is used only while it is set up, and on-device ones are never offered', () => {
  const settings = settingsHarness({ main: 'soniox', setUp: ['soniox', 'whisper-server'] });
  assert.equal(settings.resolveTranslateProvider('whisper-server'), 'whisper-server');
  assert.equal(settings.resolveTranslateProvider('elevenlabs'), null);
  assert.equal(settings.translateProviderSetting.isDisabled('elevenlabs'), true);
  assert.equal(settings.translateProviderSetting.isDisabled('auto'), false);
  assert.deepEqual(plain(settings.translateProviderSetting.values), ['auto', 'elevenlabs', 'whisper', 'soniox', 'whisper-server']);
});

test('the spoken language defaults to auto-detect and resolves to an ISO 639-1 code once chosen', () => {
  const settings = settingsHarness();
  assert.equal(settings.resolveTranslateLanguage(), '');
  assert.equal(settings.translateLanguageSetting.displayValue('auto'), 'Auto-detect');
  settings.translateLanguageSetting.set('ja');
  assert.equal(settings.resolveTranslateLanguage(), 'ja');
  assert.equal(settings.spokenLanguageName('ja'), 'Japanese');
  assert.equal(settings.translateLanguageSetting.values[0], 'auto');
  assert.ok(settings.translateLanguageSetting.values.slice(1).every(code => /^[a-z]{2}$/.test(code)));
  assert.equal(settings.translateLanguageSetting.values.includes('en'), false, 'English is the target, not a source');
});
